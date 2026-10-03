import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CollectionImportResult, CollectionSummary, CommanderIdea, DeckSummary, MissingReport, SearchResponse } from '@grimoire/shared';
import { openDb, type NodeDb as Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { buildServer } from './server.js';
import { commanderIdeas, importCollection, collectionSummary, setOwned } from './collection.js';
import { searchCards } from './cards.js';
import { BadRequestError } from './decks.js';
import { sfCard } from './testutil.js';

const gruulCmdr = sfCard({ name: 'Gruul Commander', type_line: 'Legendary Creature — Beast', color_identity: ['R', 'G'], colors: ['R', 'G'], mana_cost: '{R}{G}', cmc: 2, prices: { usd: '5.00' } });
const monoGCmdr = sfCard({ name: 'Green Commander', type_line: 'Legendary Creature — Elf', color_identity: ['G'], colors: ['G'], mana_cost: '{G}', cmc: 1, prices: { usd: '2.00' } });
const FIXTURE = [
  gruulCmdr, monoGCmdr,
  sfCard({ name: 'Sol Ring', type_line: 'Artifact', mana_cost: '{1}', cmc: 1, prices: { usd: '1.50' } }),
  sfCard({ name: 'Cultivate', type_line: 'Sorcery', color_identity: ['G'], colors: ['G'], prices: { usd: '0.50' } }),
  sfCard({ name: 'Lightning Bolt', type_line: 'Instant', color_identity: ['R'], colors: ['R'], prices: { usd: '1.00' } }),
  sfCard({ name: 'Counterspell', type_line: 'Instant', color_identity: ['U'], colors: ['U'], prices: { usd: '2.00' } }),
  sfCard({ name: 'Banned Card', type_line: 'Instant', color_identity: ['G'], legalities: { commander: 'banned' }, prices: { usd: '99.00' } }),
  sfCard({ name: 'Forest', type_line: 'Basic Land — Forest', color_identity: ['G'] }),
  sfCard({ name: 'Cheap Land', type_line: 'Land', prices: { usd: '0.10' } }),
  sfCard({ name: 'Unpriced Thing', type_line: 'Artifact' }),
];

let db: Db;
let app: FastifyInstance;
beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, (async function* () { for (const c of FIXTURE) yield JSON.stringify(c); })());
  app = buildServer({ db, dataDir: '/nonexistent', logger: false });
});

describe('importCollection', () => {
  it('imports a ManaBox CSV, merging duplicate rows and reporting unresolved names', () => {
    const csv = 'Name,Set code,Collector number,Foil,Quantity,ManaBox ID\nSol Ring,cmm,400,normal,2,1\nSol Ring,cmm,400,foil,1,2\n"Nonexistent Card",x,1,normal,1,3\nCultivate,c21,1,normal,1,4';
    const r = importCollection(db, csv, 'merge');
    expect(r).toMatchObject({ format: 'manabox', imported: 4, unique: 2, unresolved: ['Nonexistent Card'] });
    expect(r.summary).toEqual({ unique: 2, total: 4, valueUsd: 3 * 1.5 + 0.5, unpriced: 0 });
  });

  it('merge adds to existing quantities; replace swaps the whole collection', () => {
    importCollection(db, '2 Sol Ring\n1 Cultivate', 'merge');
    importCollection(db, '3 Sol Ring', 'merge');
    expect(collectionSummary(db)).toMatchObject({ unique: 2, total: 6 });
    importCollection(db, '1 Lightning Bolt', 'replace');
    expect(collectionSummary(db)).toMatchObject({ unique: 1, total: 1 });
  });

  it('counts unpriced cards and rejects empty or non-matching input', () => {
    expect(importCollection(db, '1 Unpriced Thing\n1 Sol Ring', 'merge').summary).toMatchObject({ unique: 2, unpriced: 1 });
    expect(() => importCollection(db, '\n \n', 'merge')).toThrow(BadRequestError);
    expect(() => importCollection(db, '5 Totally Fake\n2 Also Fake', 'merge')).toThrow(/None of the 2 rows/);
  });

  it('resolves front-face names for split cards and ignores printing decorations', () => {
    const r = importCollection(db, '1 Sol Ring (CMM) 400 *F*', 'merge');
    expect(r.unresolved).toEqual([]);
    expect(r.imported).toBe(1);
  });
});

describe('owned in search and cards', () => {
  it('every card carries its owned count and `owned` filters', () => {
    importCollection(db, '2 Sol Ring\n1 Cultivate', 'merge');
    const names = (q: string) => searchCards(db, { query: q }).cards.map((c) => c.name);
    expect(names('owned>0')).toEqual(['Cultivate', 'Sol Ring']);
    expect(names('owned>=2')).toEqual(['Sol Ring']);
    expect(names('owned:0 t:instant')).toEqual(['Banned Card', 'Counterspell', 'Lightning Bolt']);
    expect(names('-owned>0 c:g')).toEqual(['Green Commander', 'Gruul Commander']);
    expect(searchCards(db, { query: 'sol ring' }).cards[0]!.owned).toBe(2);
    expect(searchCards(db, { query: 'bolt' }).cards[0]!.owned).toBe(0);
    expect(() => names('owned:lots')).toThrow(/whole number/);
  });
});

describe('setOwned', () => {
  it('sets, updates and removes; validates', () => {
    const id = searchCards(db, { query: '!"sol ring"' }).cards[0]!.id;
    setOwned(db, id, 3);
    expect(collectionSummary(db).total).toBe(3);
    setOwned(db, id, 1);
    expect(collectionSummary(db).total).toBe(1);
    setOwned(db, id, 0);
    expect(collectionSummary(db).unique).toBe(0);
    expect(() => setOwned(db, id, -1)).toThrow(BadRequestError);
    expect(() => setOwned(db, 'nope', 1)).toThrow(/Unknown card/);
  });
});

describe('commanderIdeas', () => {
  it('ranks owned commanders by owned legal cards within their colour identity', () => {
    importCollection(db, 'Gruul Commander\nGreen Commander\nSol Ring\nCultivate\nLightning Bolt\nCounterspell\nBanned Card\nCheap Land', 'replace');
    const ideas = commanderIdeas(db);
    expect(ideas.map((i) => i.commander.name)).toEqual(['Gruul Commander', 'Green Commander']);
    // Gruul: Green Commander, Sol Ring, Cultivate, Bolt, Cheap Land (not Counterspell: blue; not Banned Card).
    expect(ideas[0]).toMatchObject({ playable: 5, spells: 4 });
    // Mono-green: Sol Ring, Cultivate, Cheap Land (Gruul Commander is red-green; Bolt is red).
    expect(ideas[1]).toMatchObject({ playable: 3, spells: 2 });
  });
  it('only lists commanders you own', () => {
    importCollection(db, 'Sol Ring\nCultivate', 'replace');
    expect(commanderIdeas(db)).toEqual([]);
  });
});

describe('collection API', () => {
  const j = async <T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : null) as T };
  };

  it('imports, summarises, lists with a search filter, edits and clears', async () => {
    const imp = await j<CollectionImportResult>('POST', '/api/collection/import', { text: '2 Sol Ring\n1 Cultivate\n1 Lightning Bolt', mode: 'replace' });
    expect(imp.status).toBe(201);
    expect((await j<CollectionSummary>('GET', '/api/collection/summary')).body).toMatchObject({ unique: 3, total: 4 });

    const all = await j<SearchResponse>('GET', '/api/collection');
    expect(all.body.cards.map((c) => [c.name, c.owned])).toEqual([['Cultivate', 1], ['Lightning Bolt', 1], ['Sol Ring', 2]]);
    expect((await j<SearchResponse>('GET', '/api/collection?q=c:g')).body.cards.map((c) => c.name)).toEqual(['Cultivate']);
    expect((await j<SearchResponse>('GET', '/api/collection?q=bogus:1')).status).toBe(400);

    const sol = all.body.cards.find((c) => c.name === 'Sol Ring')!;
    expect((await j<CollectionSummary>('PUT', '/api/collection/cards', { cardId: sol.id, qty: 5 })).body.total).toBe(7);
    expect((await j('PUT', '/api/collection/cards', { cardId: sol.id, qty: -2 })).status).toBe(400);
    expect((await j('POST', '/api/collection/import', { text: '' })).status).toBe(400);

    expect((await j('DELETE', '/api/collection')).status).toBe(204);
    expect((await j<CollectionSummary>('GET', '/api/collection/summary')).body.total).toBe(0);
  });

  it('reports what a deck is missing, with prices, ignoring basics and the sideboard', async () => {
    await j('POST', '/api/collection/import', { text: 'Sol Ring\nGruul Commander', mode: 'replace' });
    const deck = (await j<DeckSummary>('POST', '/api/decks', { name: 'd' })).body;
    const deckText = 'Commander\n1 Gruul Commander\n\nDeck\n1 Sol Ring\n2 Cultivate\n1 Unpriced Thing\n30 Forest\nSideboard\n1 Counterspell';
    await j('POST', '/api/decks/import', { text: deckText, deckId: deck.id });

    const rep = (await j<MissingReport>('GET', `/api/decks/${deck.id}/missing`)).body;
    expect(rep).toMatchObject({ needed: 5, have: 2, unpriced: 1 });
    expect(rep.missing.map((m) => [m.card.name, m.need, m.owned, m.missing, m.costUsd])).toEqual([
      ['Cultivate', 2, 0, 2, 1], // 2 x $0.50, but singleton rules aside it's still what the list asks for
      ['Unpriced Thing', 1, 0, 1, null],
    ]);
    expect(rep.totalUsd).toBe(1);
    expect((await j('GET', '/api/decks/999/missing')).status).toBe(404);
  });

  it('commander ideas endpoint', async () => {
    await j('POST', '/api/collection/import', { text: 'Gruul Commander\nCultivate', mode: 'replace' });
    const ideas = (await j<CommanderIdea[]>('GET', '/api/collection/commanders')).body;
    expect(ideas).toHaveLength(1);
    expect(ideas[0]).toMatchObject({ playable: 1, spells: 1 });
  });
});
