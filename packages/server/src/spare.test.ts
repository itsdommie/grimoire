import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddToCollectionResult, ImportResult, MissingReport } from '@grimoire/shared';
import { openDb, type NodeDb as Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { buildServer } from './server.js';
import { addDeckToCollection, collectionSummary, commanderIdeas, deckMissing, setOwned } from './collection.js';
import { getCardByName, searchCards } from './cards.js';
import { createDeck, setCardQty } from './decks.js';
import { sfCard } from './testutil.js';

const FIXTURE = [
  sfCard({ name: 'Gruul Commander', type_line: 'Legendary Creature — Beast', color_identity: ['R', 'G'], colors: ['R', 'G'], mana_cost: '{R}{G}', cmc: 2, prices: { usd: '5.00' } }),
  sfCard({ name: 'Green Commander', type_line: 'Legendary Creature — Elf', color_identity: ['G'], colors: ['G'], mana_cost: '{G}', cmc: 1, prices: { usd: '2.00' } }),
  sfCard({ name: 'Sol Ring', type_line: 'Artifact', mana_cost: '{1}', cmc: 1, prices: { usd: '1.50' } }),
  sfCard({ name: 'Cultivate', type_line: 'Sorcery', color_identity: ['G'], colors: ['G'], prices: { usd: '0.50' } }),
  sfCard({ name: 'Lightning Bolt', type_line: 'Instant', color_identity: ['R'], colors: ['R'], prices: { usd: '1.00' } }),
  sfCard({ name: 'Forest', type_line: 'Basic Land — Forest', color_identity: ['G'] }),
];

let db: Db;
let app: FastifyInstance;
const id = (name: string) => getCardByName(db, name)!.id;
const names = (query: string, excludeDeck?: number) => searchCards(db, { query, excludeDeck }).cards.map((c) => c.name).sort();
const deckWith = (name: string, cards: Record<string, number>, format: 'commander' | 'modern' = 'commander') => {
  const deck = createDeck(db, name, format);
  for (const [card, qty] of Object.entries(cards)) setCardQty(db, deck.id, id(card), 'main', qty);
  return deck.id;
};

beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, (async function* () { for (const c of FIXTURE) yield JSON.stringify(c); })());
  app = buildServer({ db, dataDir: '/nonexistent', logger: false });
});

describe('spare copies', () => {
  it('5 Sol Rings across 4 decks leaves one spare; a fifth deck uses it up', () => {
    setOwned(db, id('Sol Ring'), 5);
    for (let i = 1; i <= 4; i++) deckWith(`Deck ${i}`, { 'Sol Ring': 1 });
    expect(names('spare>0')).toEqual(['Sol Ring']);
    expect(names('spare>=2')).toEqual([]);
    expect(getCardByName(db, 'Sol Ring')).toMatchObject({ owned: 5, inDecks: 4 });
    deckWith('Deck 5', { 'Sol Ring': 1 });
    expect(names('spare>0')).toEqual([]);
    expect(names('owned>0')).toEqual(['Sol Ring']); // still owned, just all in use
  });

  it('counts every copy in a deck, not just whether the card is in one', () => {
    setOwned(db, id('Lightning Bolt'), 6);
    deckWith('Burn', { 'Lightning Bolt': 4 }, 'modern');
    expect(names('spare>=2')).toEqual(['Lightning Bolt']);
    expect(names('spare>=3')).toEqual([]);
  });

  it('leaves the deck being built out of the count, so its own cards stay available to it', () => {
    setOwned(db, id('Cultivate'), 1);
    const mine = deckWith('Mine', { Cultivate: 1 });
    expect(names('spare>0')).toEqual([]);
    expect(names('spare>0', mine)).toEqual(['Cultivate']);
    const other = deckWith('Other', {});
    expect(names('spare>0', other)).toEqual([]); // but another deck has it
  });

  it("a Commander sideboard is a maybeboard and holds no copies; a 60-card sideboard does", () => {
    setOwned(db, id('Cultivate'), 1);
    setOwned(db, id('Lightning Bolt'), 1);
    const edh = createDeck(db, 'EDH', 'commander').id;
    setCardQty(db, edh, id('Cultivate'), 'sideboard', 1);
    const modern = createDeck(db, 'Modern', 'modern').id;
    setCardQty(db, modern, id('Lightning Bolt'), 'sideboard', 1);
    expect(names('spare>0')).toEqual(['Cultivate']);
  });

  it('a commander counts as a copy in use', () => {
    setOwned(db, id('Green Commander'), 1);
    const deck = createDeck(db, 'Elves').id;
    setCardQty(db, deck, id('Green Commander'), 'commander', 1);
    expect(names('spare>0')).toEqual([]);
  });

  it('rejects a non-numeric value', () => {
    expect(() => names('spare>lots')).toThrow(/whole number/);
  });
});

describe('what a deck is missing, leaving other decks alone', () => {
  it('uses only the spare copies when asked', () => {
    setOwned(db, id('Sol Ring'), 5);
    for (let i = 1; i <= 4; i++) deckWith(`Deck ${i}`, { 'Sol Ring': 1 });
    const fresh = deckWith('Fresh', { 'Sol Ring': 2, Cultivate: 1 });
    setOwned(db, id('Cultivate'), 1);

    const all = deckMissing(db, fresh);
    expect(all).toMatchObject({ needed: 3, have: 3, excludedOtherDecks: false });
    expect(all.missing).toEqual([]);

    const spare = deckMissing(db, fresh, { excludeOtherDecks: true });
    expect(spare).toMatchObject({ needed: 3, have: 2, excludedOtherDecks: true });
    expect(spare.missing).toHaveLength(1);
    expect(spare.missing[0]).toMatchObject({ need: 2, owned: 1, missing: 1, costUsd: 1.5 });
    expect(spare.missing[0]!.card.name).toBe('Sol Ring');
  });

  it("the deck's own copies are not taken from it", () => {
    setOwned(db, id('Sol Ring'), 1);
    const only = deckWith('Only', { 'Sol Ring': 1 });
    expect(deckMissing(db, only, { excludeOtherDecks: true }).missing).toEqual([]);
  });

  it('never goes negative when other decks hold more than you own', () => {
    setOwned(db, id('Sol Ring'), 1);
    deckWith('A', { 'Sol Ring': 1 });
    deckWith('B', { 'Sol Ring': 1 });
    const fresh = deckWith('Fresh', { 'Sol Ring': 1 });
    expect(deckMissing(db, fresh, { excludeOtherDecks: true }).missing[0]).toMatchObject({ owned: 0, missing: 1 });
  });
});

describe('commander ideas leaving decks alone', () => {
  it('drops commanders and cards that are fully in decks', () => {
    for (const n of ['Gruul Commander', 'Green Commander', 'Sol Ring', 'Cultivate', 'Lightning Bolt']) setOwned(db, id(n), 1);
    setOwned(db, id('Sol Ring'), 2);
    const deck = createDeck(db, 'Gruul').id;
    setCardQty(db, deck, id('Gruul Commander'), 'commander', 1);
    setCardQty(db, deck, id('Sol Ring'), 'main', 1);
    setCardQty(db, deck, id('Cultivate'), 'main', 1);

    const all = commanderIdeas(db);
    expect(all.map((i) => i.commander.name)).toEqual(['Gruul Commander', 'Green Commander']);

    const spare = commanderIdeas(db, 24, true);
    expect(spare.map((i) => i.commander.name)).toEqual(['Green Commander']); // Gruul leads a deck already
    // Mono-green fits Sol Ring and Cultivate; Cultivate's only copy is in the deck, and Sol Ring has one of two spare.
    expect(spare[0]).toMatchObject({ playable: 1, spells: 1 });
    expect(all.find((i) => i.commander.name === 'Green Commander')).toMatchObject({ playable: 2, spells: 2 });
  });
});

describe('adding a deck to the collection', () => {
  it('adds its cards, skipping basic lands and a Commander maybeboard', () => {
    const deck = createDeck(db, 'Built').id;
    setCardQty(db, deck, id('Green Commander'), 'commander', 1);
    setCardQty(db, deck, id('Sol Ring'), 'main', 1);
    setCardQty(db, deck, id('Forest'), 'main', 30);
    setCardQty(db, deck, id('Cultivate'), 'sideboard', 1);
    setOwned(db, id('Sol Ring'), 2);

    const r = addDeckToCollection(db, deck);
    expect(r).toMatchObject({ added: 2, unique: 2 });
    expect(getCardByName(db, 'Sol Ring')).toMatchObject({ owned: 3 });
    expect(getCardByName(db, 'Green Commander')!.owned).toBe(1);
    expect(getCardByName(db, 'Forest')!.owned).toBe(0);
    expect(getCardByName(db, 'Cultivate')!.owned).toBe(0);
    expect(collectionSummary(db).total).toBe(4);
  });

  it('counts a 60-card sideboard, and the copies are then spare-aware: the deck uses what it added', () => {
    const deck = deckWith('Burn', { 'Lightning Bolt': 3 }, 'modern');
    setCardQty(db, deck, id('Lightning Bolt'), 'sideboard', 1);
    addDeckToCollection(db, deck);
    expect(getCardByName(db, 'Lightning Bolt')).toMatchObject({ owned: 4, inDecks: 4 });
    expect(names('spare>0')).toEqual([]);
  });

  it('works over the API, and as an option on deck import', async () => {
    const deck = deckWith('Via API', { 'Sol Ring': 2 });
    const res = await app.inject({ method: 'POST', url: `/api/decks/${deck}/add-to-collection` });
    expect(res.json<AddToCollectionResult>()).toMatchObject({ added: 2, unique: 1 });

    const imp = await app.inject({ method: 'POST', url: '/api/decks/import', payload: { text: '1 Cultivate\n1 Lightning Bolt', name: 'Imported', addToCollection: true } });
    expect(imp.statusCode).toBe(201);
    expect(imp.json<ImportResult>().addedToCollection).toMatchObject({ added: 2, unique: 2 });
    expect(getCardByName(db, 'Cultivate')!.owned).toBe(1);

    const plain = await app.inject({ method: 'POST', url: '/api/decks/import', payload: { text: '1 Counterspell', name: 'Plain' } });
    expect(plain.json<ImportResult>().addedToCollection).toBeUndefined();
  });

  it('exposes spare filtering on the search, missing and commander endpoints', async () => {
    setOwned(db, id('Sol Ring'), 2);
    const a = deckWith('A', { 'Sol Ring': 2 });
    const b = deckWith('B', {});
    const search = (q: string, deck?: number) => app.inject({ method: 'GET', url: `/api/cards/search?${new URLSearchParams({ q, ...(deck ? { deck: String(deck) } : {}) })}` }).then((r) => r.json<{ cards: Array<{ name: string }> }>().cards.map((c) => c.name));
    expect(await search('spare>0')).toEqual([]);
    expect(await search('spare>0', a)).toEqual(['Sol Ring']);
    const miss = await app.inject({ method: 'GET', url: `/api/decks/${b}/missing?spare=1` });
    expect(miss.json<MissingReport>().excludedOtherDecks).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/collection/commanders?spare=1' })).statusCode).toBe(200);
  });
});
