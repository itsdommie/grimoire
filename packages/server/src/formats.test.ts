import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DeckDetail, DeckSummary, ImportResult, MissingReport } from '@grimoire/shared';
import { openDb, type Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { buildServer } from './server.js';
import { exportUserData, restoreUserData } from './backup.js';
import { sfCard } from './testutil.js';

const std = { standard: 'legal', modern: 'legal', commander: 'legal' };
const FIXTURE = [
  sfCard({ name: 'Forest', type_line: 'Basic Land — Forest', color_identity: ['G'], legalities: std }),
  sfCard({ name: 'Llanowar Elves', type_line: 'Creature — Elf Druid', color_identity: ['G'], colors: ['G'], legalities: std }),
  sfCard({ name: 'Lightning Bolt', type_line: 'Instant', color_identity: ['R'], colors: ['R'], legalities: { modern: 'legal', commander: 'legal', standard: 'not_legal' }, prices: { usd: '1.00' } }),
  sfCard({ name: 'Cmdr', type_line: 'Legendary Creature — Elf', color_identity: ['G'], colors: ['G'], legalities: std }),
  sfCard({ name: 'Banned Card', type_line: 'Sorcery', legalities: { modern: 'banned', commander: 'legal', standard: 'legal' } }),
];
let db: Db;
let app: FastifyInstance;
beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, (async function* () { for (const c of FIXTURE) yield JSON.stringify(c); })());
  app = buildServer({ db, dataDir: '/x', logger: false });
});
const j = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as never });
  return { status: r.statusCode, body: (r.body ? JSON.parse(r.body) : null) as T };
};
const codes = (d: DeckDetail) => d.issues.map((i) => i.code);

describe('deck formats over the API', () => {
  it('creates decks in a format (default Commander) and rejects unknown ones', async () => {
    expect((await j<DeckSummary>('POST', '/api/decks', { name: 'A' })).body.format).toBe('commander');
    const m = await j<DeckSummary>('POST', '/api/decks', { name: 'B', format: 'modern' });
    expect(m.status).toBe(201);
    expect(m.body.format).toBe('modern');
    const bad = await j('POST', '/api/decks', { name: 'C', format: 'frontier' });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toMatch(/Unknown format/);
  });

  it('validates against the deck\'s own format', async () => {
    const d = (await j<DeckSummary>('POST', '/api/decks', { name: 'Modern', format: 'modern' })).body;
    const imp = await j<ImportResult>('POST', '/api/decks/import', { deckId: d.id, text: 'Deck\n56 Forest\n4 Lightning Bolt\nSideboard\n1 Banned Card' });
    expect(imp.body.deck.format).toBe('modern');
    expect(codes(imp.body)).toEqual(['banned']); // 60 main cards, so no size warning; Banned Card is banned in Modern
    const five = await j<DeckDetail>('PUT', `/api/decks/${d.id}/cards`, { cardId: imp.body.entries.find((e) => e.card.name === 'Lightning Bolt')!.card.id, board: 'main', qty: 5 });
    expect(codes(five.body)).toContain('copies');
  });

  it('imports into a new deck with a chosen format', async () => {
    const r = await j<ImportResult>('POST', '/api/decks/import', { text: '4 Lightning Bolt\n20 Forest', name: 'Std', format: 'standard' });
    expect(r.body.deck.format).toBe('standard');
    expect(codes(r.body)).toEqual(expect.arrayContaining(['deck-size', 'not-legal'])); // Bolt isn't standard-legal in the fixture
    expect((await j('POST', '/api/decks/import', { text: '1 Forest', format: 'nope' })).status).toBe(400);
  });

  it('importing a card in both the main deck and the sideboard keeps both stacks (a commander still wins over its main copy)', async () => {
    const r = await j<ImportResult>('POST', '/api/decks/import', { text: 'Deck\n4 Lightning Bolt\nSideboard\n2 Lightning Bolt', name: 'Both', format: 'modern' });
    expect(r.body.entries.filter((e) => e.card.name === 'Lightning Bolt').map((e) => [e.board, e.qty]).sort()).toEqual([['main', 4], ['sideboard', 2]]);
    expect(codes(r.body)).toContain('copies'); // 6 copies in total
    const c = await j<ImportResult>('POST', '/api/decks/import', { text: 'Commander\n1 Cmdr\nDeck\n1 Cmdr\n3 Forest', name: 'Dup' });
    expect(c.body.entries.filter((e) => e.card.name === 'Cmdr').map((e) => e.board)).toEqual(['commander']);
  });

  it('changing format renames safely, and leaving Commander moves the commander into the main deck', async () => {
    const d = (await j<DeckSummary>('POST', '/api/decks', { name: 'Elves' })).body;
    await j('POST', '/api/decks/import', { deckId: d.id, text: 'Commander\n1 Cmdr\nDeck\n2 Llanowar Elves' });
    const patched = await j<DeckSummary>('PATCH', `/api/decks/${d.id}`, { format: 'modern' });
    expect(patched.body.format).toBe('modern');
    const detail = (await j<DeckDetail>('GET', `/api/decks/${d.id}`)).body;
    expect(detail.entries.every((e) => e.board !== 'commander')).toBe(true);
    expect(detail.entries.find((e) => e.card.name === 'Cmdr')).toMatchObject({ board: 'main', qty: 1 });
    expect(codes(detail)).not.toContain('wrong-zone');
    // Renaming still works, and a bad format changes nothing.
    expect((await j<DeckSummary>('PATCH', `/api/decks/${d.id}`, { name: 'Renamed' })).body).toMatchObject({ name: 'Renamed', format: 'modern' });
    expect((await j('PATCH', `/api/decks/${d.id}`, { format: 'nope' })).status).toBe(400);
    expect((await j<DeckDetail>('GET', `/api/decks/${d.id}`)).body.deck.format).toBe('modern');
  });

  it('missing-card reports include the sideboard for 60-card formats but not for Commander', async () => {
    const text = 'Deck\n4 Lightning Bolt\nSideboard\n2 Llanowar Elves';
    const modern = (await j<ImportResult>('POST', '/api/decks/import', { text, name: 'm', format: 'modern' })).body.deck;
    const cmdr = (await j<ImportResult>('POST', '/api/decks/import', { text, name: 'c' })).body.deck;
    expect((await j<MissingReport>('GET', `/api/decks/${modern.id}/missing`)).body).toMatchObject({ needed: 6, have: 0 });
    expect((await j<MissingReport>('GET', `/api/decks/${cmdr.id}/missing`)).body).toMatchObject({ needed: 4, have: 0 });
  });

  it('backups keep each deck\'s format, and unknown formats restore as Commander', async () => {
    await j('POST', '/api/decks', { name: 'Keep', format: 'pauper' });
    const backup = exportUserData(db);
    expect(backup.decks[0]!.format).toBe('pauper');
    const target = openDb(':memory:');
    await loadJsonl(target, (async function* () { for (const c of FIXTURE) yield JSON.stringify(c); })());
    restoreUserData(target, { ...backup, decks: [...backup.decks, { name: 'Odd', format: 'frontier', cards: [] }] }, 'replace');
    const formats = (target.prepare('SELECT name, format FROM decks ORDER BY name').all() as unknown as Array<{ name: string; format: string }>).map((r) => `${r.name}:${r.format}`);
    expect(formats).toEqual(['Keep:pauper', 'Odd:commander']);
  });
});
