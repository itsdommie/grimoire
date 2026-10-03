import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DeckDetail, ImportResult, DeckSummary } from '@grimoire/shared';
import { openDb, type Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { buildServer } from './server.js';
import type { ScryfallCard } from './scryfall.js';

const base = { layout: 'normal', rarity: 'common', set: 'tst', scryfall_uri: 'https://scryfall.com/x', legalities: { commander: 'legal' } };
let n = 0;
const card = (c: Partial<ScryfallCard> & { name: string }): ScryfallCard => ({ ...base, oracle_id: `id-${n++}`, ...c });

const FIXTURE: ScryfallCard[] = [
  card({ name: "Atraxa, Praetors' Voice", type_line: 'Legendary Creature — Phyrexian Angel Horror', color_identity: ['W', 'U', 'B', 'G'], colors: ['W', 'U', 'B', 'G'] }),
  card({ name: 'Sol Ring', type_line: 'Artifact', mana_cost: '{1}', cmc: 1 }),
  card({ name: 'Fireball', type_line: 'Sorcery', color_identity: ['R'], colors: ['R'] }),
  card({ name: 'Forest', type_line: 'Basic Land — Forest', color_identity: ['G'] }),
  card({ name: 'Fire // Ice', layout: 'split', type_line: 'Instant // Instant', color_identity: ['R', 'U'], card_faces: [{ mana_cost: '{1}{R}', colors: ['R'] }, { mana_cost: '{1}{U}', colors: ['U'] }] }),
];

let app: FastifyInstance;
let db: Db;
async function* fixtureLines() { for (const c of FIXTURE) yield JSON.stringify(c); }
const ids: Record<string, string> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, fixtureLines());
  for (const c of FIXTURE) ids[c.name] = c.oracle_id!;
  app = buildServer({ db, dataDir: '/nonexistent' });
});

const json = async <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : null) as T };
};

describe('deck API', () => {
  it('creates, lists, renames and deletes decks', async () => {
    const created = await json<DeckSummary>('POST', '/api/decks', { name: '  Atraxa Superfriends ' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Atraxa Superfriends', cardCount: 0, format: 'commander' });
    const id = created.body.id;

    expect((await json<DeckSummary>('PATCH', `/api/decks/${id}`, { name: 'Renamed' })).body.name).toBe('Renamed');
    expect((await json<DeckSummary[]>('GET', '/api/decks')).body).toHaveLength(1);
    expect((await json('DELETE', `/api/decks/${id}`)).status).toBe(204);
    expect((await json('GET', `/api/decks/${id}`)).status).toBe(404);
  });

  it('validates input', async () => {
    expect((await json('POST', '/api/decks', { name: '   ' })).status).toBe(400);
    expect((await json('GET', '/api/decks/abc')).status).toBe(400);
    expect((await json('GET', '/api/decks/999')).status).toBe(404);
    const { body: d } = await json<DeckSummary>('POST', '/api/decks', { name: 'x' });
    expect((await json('PUT', `/api/decks/${d.id}/cards`, { cardId: ids['Sol Ring'], board: 'main', qty: -1 })).status).toBe(400);
    expect((await json('PUT', `/api/decks/${d.id}/cards`, { cardId: ids['Sol Ring'], board: 'nope', qty: 1 })).status).toBe(400);
    expect((await json('PUT', `/api/decks/${d.id}/cards`, { cardId: 'missing', board: 'main', qty: 1 })).status).toBe(404);
  });

  it('adds, updates, moves and removes cards, validating as it goes', async () => {
    const { body: d } = await json<DeckSummary>('POST', '/api/decks', { name: 'x' });
    const put = (name: string, board: string, qty: number, move = false) => json<DeckDetail>('PUT', `/api/decks/${d.id}/cards`, { cardId: ids[name], board, qty, move });

    await put("Atraxa, Praetors' Voice", 'commander', 1);
    let r = await put('Fireball', 'main', 1);
    expect(r.body.issues.map((i) => i.code)).toContain('color-identity');

    r = await put('Forest', 'main', 40);
    expect(r.body.deck.cardCount).toBe(42);
    expect(r.body.entries.find((e) => e.card.name === 'Forest')?.qty).toBe(40);

    // Moving Fireball to the sideboard (an explicit move) stops it counting against the deck.
    r = await put('Fireball', 'sideboard', 1, true);
    expect(r.body.issues.map((i) => i.code)).not.toContain('color-identity');
    expect(r.body.entries.filter((e) => e.card.name === 'Fireball')).toHaveLength(1);

    r = await put('Fireball', 'sideboard', 0);
    expect(r.body.entries.some((e) => e.card.name === 'Fireball')).toBe(false);
  });

  it('keeps main and sideboard copies side by side, but the commander zone is exclusive', async () => {
    const { body: d } = await json<DeckSummary>('POST', '/api/decks', { name: 'x', format: 'modern' });
    const put = (name: string, board: string, qty: number, move = false) => json<DeckDetail>('PUT', `/api/decks/${d.id}/cards`, { cardId: ids[name], board, qty, move });
    await put('Fireball', 'main', 3);
    const r = await put('Fireball', 'sideboard', 2);
    expect(r.body.entries.filter((e) => e.card.name === 'Fireball').map((e) => [e.board, e.qty]).sort()).toEqual([['main', 3], ['sideboard', 2]]);
    // Making it the commander takes it out of the 99 entirely.
    const c = await put('Fireball', 'commander', 1);
    expect(c.body.entries.filter((e) => e.card.name === 'Fireball').map((e) => [e.board, e.qty])).toEqual([['commander', 1]]);
    // Putting it back in the main deck leaves the command zone.
    const back = await put('Fireball', 'main', 2);
    expect(back.body.entries.filter((e) => e.card.name === 'Fireball').map((e) => [e.board, e.qty])).toEqual([['main', 2]]);
  });

  it('survives re-ingesting the card pool', async () => {
    const { body: d } = await json<DeckSummary>('POST', '/api/decks', { name: 'x' });
    await json('PUT', `/api/decks/${d.id}/cards`, { cardId: ids['Sol Ring'], board: 'main', qty: 1 });
    await loadJsonl(db, fixtureLines()); // wipes and reloads cards + legality
    const after = await json<DeckDetail>('GET', `/api/decks/${d.id}`);
    expect(after.body.entries.map((e) => e.card.name)).toEqual(['Sol Ring']);
    expect(after.body.entries[0]?.card.legalities.commander).toBe('legal');
  });
});

describe('import / export', () => {
  const list = "Commander\n1 Atraxa, Praetors' Voice (C16) 28 *F*\n\nDeck\n1x Sol Ring [Ramp]\n3 Forest\n1 Fire\n1 Totally Fake Card\nSideboard\n1 Fireball";

  it('imports into a new deck, reporting unresolved lines', async () => {
    const res = await json<ImportResult>('POST', '/api/decks/import', { text: list, name: 'Imported' });
    expect(res.status).toBe(201);
    expect(res.body.unresolved).toEqual(['Totally Fake Card']);
    expect(res.body.deck.name).toBe('Imported');
    const by = Object.fromEntries(res.body.entries.map((e) => [e.card.name, [e.board, e.qty]]));
    expect(by).toEqual({
      "Atraxa, Praetors' Voice": ['commander', 1],
      'Sol Ring': ['main', 1],
      Forest: ['main', 3],
      'Fire // Ice': ['main', 1], // front-face name resolves to the split card
      Fireball: ['sideboard', 1],
    });
  });

  it('merges duplicate lines and can replace an existing deck', async () => {
    const first = await json<ImportResult>('POST', '/api/decks/import', { text: '2 Forest\n3 Forest' });
    expect(first.body.entries[0]).toMatchObject({ qty: 5 });
    expect(first.body.deck.name).toBe('Imported deck');
    const second = await json<ImportResult>('POST', '/api/decks/import', { text: '1 Sol Ring', deckId: first.body.deck.id });
    expect(second.body.entries.map((e) => e.card.name)).toEqual(['Sol Ring']);
    expect((await json<DeckSummary[]>('GET', '/api/decks')).body).toHaveLength(1);
  });

  it('rejects empty lists and unknown target decks', async () => {
    expect((await json('POST', '/api/decks/import', { text: '\n\n' })).status).toBe(400);
    expect((await json('POST', '/api/decks/import', { text: '1 Forest', deckId: 123 })).status).toBe(404);
  });

  it('exports a deck that re-imports identically', async () => {
    const imported = await json<ImportResult>('POST', '/api/decks/import', { text: list });
    const id = imported.body.deck.id;
    const res = await app.inject({ method: 'GET', url: `/api/decks/${id}/export` });
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body).toBe("Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Fire // Ice\n3 Forest\n1 Sol Ring\n\nSideboard\n1 Fireball\n");

    const again = await json<ImportResult>('POST', '/api/decks/import', { text: res.body });
    expect(again.body.unresolved).toEqual([]);
    expect(again.body.entries.map((e) => [e.card.name, e.board, e.qty])).toEqual(imported.body.entries.map((e) => [e.card.name, e.board, e.qty]));

    const plain = await app.inject({ method: 'GET', url: `/api/decks/${id}/export?style=plain` });
    expect(plain.body).not.toContain('Commander');
  });
});
