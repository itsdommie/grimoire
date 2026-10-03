import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type NodeDb as Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { loadPrintings, type PrintingsFile } from './printings.js';
import { setOwned, setOwnedPrinting } from './collection.js';
import { getSet, listSets } from './sets.js';
import { searchCards } from './cards.js';
import { createRouter } from './routes.js';
import { sfCard } from './testutil.js';

const SOL = 'oid-sol', BOLT = 'oid-bolt', FIRE = 'oid-fire', CTR = 'oid-ctr';
const cards = [
  sfCard({ name: 'Sol Ring', oracle_id: SOL, type_line: 'Artifact', set: 'c21' }),
  sfCard({ name: 'Lightning Bolt', oracle_id: BOLT, type_line: 'Instant', set: '2xm' }),
  sfCard({ name: 'Fire // Ice', oracle_id: FIRE, layout: 'split', type_line: 'Instant // Instant', image_uris: { normal: 'x' }, set: 'cmm' }),
  sfCard({ name: 'Counterspell', oracle_id: CTR, type_line: 'Instant', set: 'cmm' }),
];
const row = (id: string, card: string, set: string, collector: string, finishes: number, usd: number, released: string): PrintingsFile['rows'][number] => [id, card, set, collector, finishes, usd, usd * 2, 0, released];
const FILE: PrintingsFile = {
  version: 'v1',
  sets: [['lea', 'Limited Edition Alpha', '1993-08-05'], ['2xm', 'Double Masters', '2020-08-07'], ['c21', 'Commander 2021', '2021-04-23'], ['cmm', 'Commander Masters', '2023-08-04'], ['mt2', 'Empty Set', '2024-01-01']],
  rows: [
    row('sol-lea', SOL, 'lea', '269', 1, 900, '1993-08-05'),
    row('sol-c21', SOL, 'c21', '263', 1, 2, '2021-04-23'),
    row('sol-cmm-400', SOL, 'cmm', '400', 3, 3, '2023-08-04'),
    row('sol-cmm-400s', SOL, 'cmm', '400★', 2, 30, '2023-08-04'),
    row('sol-cmm-9', SOL, 'cmm', '9', 1, 1, '2023-08-04'),
    row('bolt-2xm', BOLT, '2xm', '117', 3, 2, '2020-08-07'),
    row('bolt-lea', BOLT, 'lea', '161', 1, 400, '1993-08-05'),
    row('bolt-cmm', BOLT, 'cmm', '10', 1, 5, '2023-08-04'),
    row('fire-cmm', FIRE, 'cmm', '300', 1, 1, '2023-08-04'),
    row('ctr-cmm', CTR, 'cmm', '5', 1, 0, '2023-08-04'), // no price known
  ],
};

let db: Db;
beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, (async function* () { for (const c of cards) yield JSON.stringify(c); })());
  loadPrintings(db, FILE);
});

describe('the list of sets', () => {
  it('lists sets with printings, newest first, with how many different cards each has', () => {
    const sets = listSets(db);
    expect(sets.map((s) => s.code)).toEqual(['cmm', 'c21', '2xm', 'lea']); // mt2 has no printings, so it isn't listed
    expect(sets.find((s) => s.code === 'cmm')).toMatchObject({ name: 'Commander Masters', released: '2023-08-04', cards: 4, owned: 0, ownedHere: 0 }); // Sol Ring has three printings here but counts once
    expect(sets.find((s) => s.code === 'lea')?.cards).toBe(2);
  });

  it('counts the cards you own in any printing, and those you have recorded as this set', () => {
    setOwned(db, SOL, 1); // no printing recorded
    setOwnedPrinting(db, 'bolt-lea', 'nonfoil', 1); // recorded as Alpha
    const by = Object.fromEntries(listSets(db).map((s) => [s.code, s]));
    expect(by.cmm).toMatchObject({ owned: 2, ownedHere: 0 }); // Sol Ring and Lightning Bolt are in the set; neither is recorded as it
    expect(by.lea).toMatchObject({ owned: 2, ownedHere: 1 });
    expect(by['2xm']).toMatchObject({ owned: 1, ownedHere: 0 });
  });

  it('narrows by name or exact code', () => {
    expect(listSets(db, 'master').map((s) => s.code)).toEqual(['cmm', '2xm']);
    expect(listSets(db, '2XM').map((s) => s.code)).toEqual(['2xm']);
    expect(listSets(db, 'nothing like this')).toEqual([]);
  });
});

describe('one set', () => {
  it('lists each card once, in collector-number order (9 before 10 before 300), with its variants and cheapest price', () => {
    const d = getSet(db, 'cmm')!;
    expect(d.cards.map((c) => [c.card.name, c.collector, c.variants, c.usd])).toEqual([
      ['Counterspell', '5', 1, null],
      ['Sol Ring', '9', 3, 1], // three printings; the lowest number stands for it and the cheapest price counts
      ['Lightning Bolt', '10', 1, 5],
      ['Fire // Ice', '300', 1, 1],
    ]);
    expect(d.cards[1]!.printingId).toBe('sol-cmm-9');
    expect(d.cards[1]!.imageUrl).toBe('https://cards.scryfall.io/normal/front/s/o/sol-cmm-9.jpg');
    expect(d.cards.map((c) => c.finish)).toEqual(['nonfoil', 'nonfoil', 'nonfoil', 'nonfoil']);
    expect(d.total).toBe(4);
  });

  it('records a foil-only printing as foil', () => {
    db.exec("UPDATE printings SET finishes = 2 WHERE id = 'fire-cmm'");
    expect(getSet(db, 'cmm')!.cards.find((c) => c.card.name === 'Fire // Ice')!.finish).toBe('foil');
  });

  it('prices what you are missing, and says how many cards have no price', () => {
    expect(getSet(db, 'cmm')).toMatchObject({ missingUsd: 7, unpriced: 1 }); // Sol 1 + Bolt 5 + Fire 1; Counterspell has no price
    setOwned(db, SOL, 1);
    expect(getSet(db, 'cmm')).toMatchObject({ missingUsd: 6, unpriced: 1 });
    expect(getSet(db, 'cmm')!.set).toMatchObject({ owned: 1 });
  });

  it('has no cost when no prices are known', () => {
    db.exec('UPDATE printings SET usd = NULL, usd_foil = NULL, usd_etched = NULL');
    expect(getSet(db, 'cmm')).toMatchObject({ missingUsd: null, unpriced: 4 });
  });

  it('shows copies recorded as this set, apart from copies of the card owned elsewhere', () => {
    setOwnedPrinting(db, 'sol-lea', 'nonfoil', 1);
    setOwnedPrinting(db, 'sol-cmm-400', 'foil', 2);
    const sol = getSet(db, 'cmm')!.cards.find((c) => c.card.name === 'Sol Ring')!;
    expect(sol.card.owned).toBe(3);
    expect(sol.copiesHere).toBe(2);
    expect(getSet(db, 'lea')!.cards.find((c) => c.card.name === 'Sol Ring')!.copiesHere).toBe(1);
  });

  it('filters to what you own or are missing, and pages', () => {
    setOwned(db, SOL, 1); setOwned(db, FIRE, 1);
    expect(getSet(db, 'cmm', { filter: 'owned' })!.cards.map((c) => c.card.name)).toEqual(['Sol Ring', 'Fire // Ice']);
    expect(getSet(db, 'cmm', { filter: 'missing' })!.cards.map((c) => c.card.name)).toEqual(['Counterspell', 'Lightning Bolt']);
    const page = getSet(db, 'cmm', { limit: 2, offset: 1 })!;
    expect(page.total).toBe(4);
    expect(page.cards.map((c) => c.card.name)).toEqual(['Sol Ring', 'Lightning Bolt']);
    expect(getSet(db, 'cmm', { filter: 'missing' })!.missingUsd).toBe(5); // the cost is of everything missing, not of the page or filter shown
  });

  it('finds a set by code in any case, and none that does not exist', () => {
    expect(getSet(db, 'CMM')!.set.code).toBe('cmm');
    expect(getSet(db, 'zzz')).toBeNull();
    expect(getSet(db, 'mt2')).toBeNull(); // nothing printed in it
  });
});

describe('searching by set', () => {
  it('finds every card printed in the set, not only those whose featured printing is from it', () => {
    const names = (q: string) => searchCards(db, { query: q }).cards.map((c) => c.name).sort();
    expect(names('set:cmm')).toEqual(['Counterspell', 'Fire // Ice', 'Lightning Bolt', 'Sol Ring']); // Sol Ring and Bolt are featured from other sets
    expect(names('e:lea')).toEqual(['Lightning Bolt', 'Sol Ring']);
    expect(names('set:CMM t:artifact')).toEqual(['Sol Ring']);
    expect(names('-set:cmm')).toEqual([]);
  });
});

describe('the routes', () => {
  const call = () => createRouter({ db, data: {} as never, semantic: {} as never });
  it('lists sets and returns one with its filter, and 404s an unknown one', async () => {
    const r = call();
    expect(((await r({ method: 'GET', path: '/api/sets', query: { q: 'commander' } })).body as { sets: Array<{ code: string }> }).sets.map((s) => s.code)).toEqual(['cmm', 'c21']);
    const one = await r({ method: 'GET', path: '/api/sets/cmm', query: { filter: 'missing', limit: '1' } });
    expect(one.status).toBe(200);
    expect((one.body as { cards: unknown[]; total: number }).cards).toHaveLength(1);
    expect((await r({ method: 'GET', path: '/api/sets/zzz' })).status).toBe(404);
    expect((await r({ method: 'GET', path: '/api/sets/cmm', query: { filter: 'bogus' } })).status).toBe(200); // an unknown filter just means all
  });
});
