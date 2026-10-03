import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type NodeDb as Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { createRouter } from './routes.js';
import { getCardByName } from './cards.js';
import { setOwned } from './collection.js';
import { setWanted } from './wishlist.js';
import { createDeck, setCardQty } from './decks.js';
import { getPriceReport, snapshotPrices } from './pricewatch.js';
import { sfCard } from './testutil.js';

const FIXTURE = [
  sfCard({ name: 'Sol Ring', type_line: 'Artifact', prices: { usd: '2.00' } }),
  sfCard({ name: 'Cultivate', type_line: 'Sorcery', color_identity: ['G'], prices: { usd: '0.50' } }),
  sfCard({ name: 'Mox Emerald', type_line: 'Artifact', prices: { usd: '400.00' } }),
  sfCard({ name: 'Mystery', type_line: 'Instant' }), // no price
  sfCard({ name: 'Unwatched', type_line: 'Instant', prices: { usd: '9.00' } }),
];
let db: Db;
const id = (name: string) => getCardByName(db, name)!.id;
const setPrice = (name: string, usd: number) => db.prepare('UPDATE cards SET usd = ?, usd_min = NULL WHERE id = ?').run(usd, id(name));
const rowsFor = (name: string) => db.prepare('SELECT day, price FROM price_history WHERE card_id = ? ORDER BY day').all(id(name)) as unknown as Array<{ day: string; price: number }>;

beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, (async function* () { for (const c of FIXTURE) yield JSON.stringify(c); })());
});

describe('recording prices', () => {
  it('records the price of the cards you have, want or use in a deck, and only those', () => {
    setOwned(db, id('Sol Ring'), 1);
    setWanted(db, id('Mox Emerald'), 1);
    const d = createDeck(db, 'D', 'commander'); setCardQty(db, d.id, id('Cultivate'), 'main', 1);
    expect(snapshotPrices(db, '2026-01-01')).toBe(3);
    expect(rowsFor('Sol Ring')).toEqual([{ day: '2026-01-01', price: 2 }]);
    expect(rowsFor('Unwatched')).toEqual([]);
  });

  it('skips a card with no price, and stores a new row only when the price changes', () => {
    setOwned(db, id('Sol Ring'), 1); setOwned(db, id('Mystery'), 1);
    expect(snapshotPrices(db, '2026-01-01')).toBe(1);
    expect(snapshotPrices(db, '2026-01-02')).toBe(0); // unchanged
    expect(snapshotPrices(db, '2026-01-02')).toBe(0); // and calling again is harmless
    setPrice('Sol Ring', 3);
    expect(snapshotPrices(db, '2026-01-03')).toBe(1);
    expect(rowsFor('Sol Ring')).toEqual([{ day: '2026-01-01', price: 2 }, { day: '2026-01-03', price: 3 }]);
  });

  it('picks up a card the day you start watching it', () => {
    setOwned(db, id('Sol Ring'), 1);
    snapshotPrices(db, '2026-01-01');
    setOwned(db, id('Cultivate'), 1);
    expect(snapshotPrices(db, '2026-01-05')).toBe(1);
    expect(rowsFor('Cultivate')).toEqual([{ day: '2026-01-05', price: 0.5 }]);
  });
});

describe('the price report', () => {
  const history = () => {
    setOwned(db, id('Sol Ring'), 4);
    setOwned(db, id('Cultivate'), 1);
    setWanted(db, id('Mox Emerald'), 1);
    snapshotPrices(db, '2026-01-01');
    setPrice('Sol Ring', 3); setPrice('Cultivate', 0.25); setPrice('Mox Emerald', 500);
    snapshotPrices(db, '2026-01-20');
  };

  it('says nothing has moved until something has, and that it has not been watching yet before the first snapshot', () => {
    expect(getPriceReport(db, { now: '2026-01-31' })).toMatchObject({ since: null, tracked: 0, up: [], down: [] });
    setOwned(db, id('Sol Ring'), 1);
    snapshotPrices(db, '2026-01-01');
    expect(getPriceReport(db, { now: '2026-01-31' })).toMatchObject({ since: '2026-01-01', tracked: 1, up: [], down: [] });
  });

  it('lists risers and fallers over the window, biggest effect on you first (the change times the copies you own)', () => {
    history();
    const r = getPriceReport(db, { days: 30, now: '2026-01-31' });
    expect(r.up.map((m) => [m.card.name, m.then, m.now, m.change, m.effectUsd])).toEqual([
      ['Mox Emerald', 400, 500, 100, 100], // wanted, one still to find
      ['Sol Ring', 2, 3, 1, 4], // $1 on four copies
    ]);
    expect(r.down.map((m) => [m.card.name, m.change, m.pct, m.effectUsd])).toEqual([['Cultivate', -0.25, -50, -0.25]]);
    expect(r.up[1]).toMatchObject({ pct: 50, owned: 4 });
  });

  it('compares with the price on the first day of the window, so a short window sees only the later change', () => {
    history();
    setPrice('Sol Ring', 3.5);
    snapshotPrices(db, '2026-01-28');
    const week = getPriceReport(db, { days: 7, now: '2026-01-31' });
    expect(week.up.map((m) => [m.card.name, m.then, m.now])).toEqual([['Sol Ring', 3, 3.5]]); // Mox and Cultivate did not move since the 24th
    const month = getPriceReport(db, { days: 30, now: '2026-01-31' });
    expect(month.up.find((m) => m.card.name === 'Sol Ring')).toMatchObject({ then: 2, now: 3.5 });
  });

  it('uses the earliest record when it has not been watching that long', () => {
    history();
    const r = getPriceReport(db, { days: 365, now: '2026-01-31' });
    expect(r.up.find((m) => m.card.name === 'Sol Ring')).toMatchObject({ then: 2, now: 3 });
    expect(r.since).toBe('2026-01-01');
  });

  it('can be narrowed to the collection or to the wishlist', () => {
    history();
    expect(getPriceReport(db, { now: '2026-01-31', scope: 'collection' }).up.map((m) => m.card.name)).toEqual(['Sol Ring']);
    const wish = getPriceReport(db, { now: '2026-01-31', scope: 'wishlist' });
    expect([...wish.up, ...wish.down].map((m) => m.card.name)).toEqual(['Mox Emerald']);
  });

  it('values what you own then and now', () => {
    history();
    expect(getPriceReport(db, { now: '2026-01-31' })).toMatchObject({ valueThen: 8.5, valueNow: 12.25 }); // 4 x 2 + 0.5, then 4 x 3 + 0.25
  });

  it('counts a card you own and want by what you own', () => {
    setOwned(db, id('Sol Ring'), 2); setWanted(db, id('Sol Ring'), 5);
    snapshotPrices(db, '2026-01-01'); setPrice('Sol Ring', 4); snapshotPrices(db, '2026-01-20');
    expect(getPriceReport(db, { now: '2026-01-31' }).up[0]).toMatchObject({ change: 2, effectUsd: 4, owned: 2, wanted: 5 });
  });
});

describe('the route', () => {
  it('snapshots and reports, and ignores nonsense', async () => {
    setOwned(db, id('Sol Ring'), 1);
    const r = createRouter({ db, data: {} as never, semantic: {} as never });
    const res = await r({ method: 'GET', path: '/api/prices', query: { days: '7', scope: 'bogus' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ days: 7, tracked: 1, up: [], down: [] });
    expect((res.body as { since: string }).since).toMatch(/^\d{4}-\d\d-\d\d$/);
  });

  it('starts by noting the prices as they are', () => {
    setOwned(db, id('Sol Ring'), 1);
    createRouter({ db, data: {} as never, semantic: {} as never });
    expect(rowsFor('Sol Ring')).toHaveLength(1);
  });
});
