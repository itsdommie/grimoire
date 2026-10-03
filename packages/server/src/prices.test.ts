import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { DataStatus } from '@grimoire/shared';
import { dbPathFor, openDb, type Db } from './db.js';
import { snapshotPrices } from './pricewatch.js';
import { DataManager } from './data.js';
import { loadJsonl, loadPrices, isRealPaperPrinting } from './ingest.js';
import { searchCards } from './cards.js';
import { importCollection, collectionSummary, deckMissing } from './collection.js';
import { importDeck } from './decks.js';
import { buildServer } from './server.js';
import { sfCard, tmpDir, writeBulk } from './testutil.js';

const SOL = sfCard({ name: 'Sol Ring', type_line: 'Artifact', oracle_id: 'o-sol', prices: { usd: '1.50' } }); // featured printing costs 1.50
const BOLT = sfCard({ name: 'Lightning Bolt', type_line: 'Instant', oracle_id: 'o-bolt', prices: { usd: '3.00' } });
const NOPRICE = sfCard({ name: 'Mystery', type_line: 'Artifact', oracle_id: 'o-none' });
const CARDS = [SOL, BOLT, NOPRICE];

const printing = (oracle_id: string, set: string, usd: string | null, extra: Record<string, unknown> = {}) => ({ object: 'card', oracle_id, set, layout: 'normal', games: ['paper'], digital: false, prices: { usd }, ...extra });
const PRINTINGS = [
  printing('o-sol', 'cmm', '1.50'), printing('o-sol', 'c21', '0.90'), printing('o-sol', 'dig', '0.05', { digital: true, games: ['arena'] }),
  printing('o-sol', 'ovr', '0.10', { oversized: true }), printing('o-sol', 'foil', null),
  printing('o-bolt', 'm11', '2.00'), printing('o-bolt', 'gld', '0.20', { border_color: 'gold' }), printing('o-bolt', 'tok', '0.30', { layout: 'token' }), printing('o-bolt', 'mem', '0.40', { set_type: 'memorabilia' }),
  printing('o-none', 'xyz', null),
  printing('ghost-card', 'ghs', '0.01'),
];
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const asLines = (rows: unknown[]) => (async function* () { for (const r of rows) yield JSON.stringify(r); })();
const row = (db: Db, name: string) => db.prepare('SELECT usd, usd_min, usd_min_set FROM cards WHERE name = ?').get(name) as { usd: number | null; usd_min: number | null; usd_min_set: string | null };

async function seeded(): Promise<Db> {
  const db = openDb(':memory:');
  await loadJsonl(db, asLines(CARDS));
  return db;
}

describe('which printings count', () => {
  it.each([
    [printing('a', 's', '1'), true],
    [printing('a', 's', '1', { digital: true }), false],
    [printing('a', 's', '1', { games: ['arena', 'mtgo'] }), false],
    [printing('a', 's', '1', { oversized: true }), false],
    [printing('a', 's', '1', { border_color: 'gold' }), false],
    [printing('a', 's', '1', { layout: 'art_series' }), false],
    [printing('a', 's', '1', { set_type: 'token' }), false],
    [{ set: 's', games: ['paper'] }, false], // no oracle id
  ])('%j -> %s', (p, expected) => expect(isRealPaperPrinting(p as never)).toBe(expected));
});

describe('loadPrices', () => {
  it('keeps the cheapest real paper printing per card, with its set', async () => {
    const db = await seeded();
    expect(await loadPrices(db, asLines(PRINTINGS))).toBe(2);
    expect(row(db, 'Sol Ring')).toEqual({ usd: 1.5, usd_min: 0.9, usd_min_set: 'c21' });
    expect(row(db, 'Lightning Bolt')).toEqual({ usd: 3, usd_min: 2, usd_min_set: 'm11' });
    expect(row(db, 'Mystery').usd_min).toBeNull();
  });
  it('replaces earlier prices and ignores printings of cards we do not have', async () => {
    const db = await seeded();
    await loadPrices(db, asLines(PRINTINGS));
    await loadPrices(db, asLines([printing('o-sol', 'new', '0.60')]));
    expect(row(db, 'Sol Ring').usd_min).toBe(0.6);
    expect(row(db, 'Lightning Bolt').usd_min).toBeNull(); // not in the new file
  });
});

describe('prices in the app', () => {
  it('search, ordering, collection value and missing-card cost use the cheapest price when there is one', async () => {
    const db = await seeded();
    await loadPrices(db, asLines(PRINTINGS));
    const names = (q: string, order?: 'usd') => searchCards(db, { query: q, order }).cards.map((c) => c.name);
    expect(names('usd<1')).toEqual(['Sol Ring']); // 0.90 cheapest, though the featured printing is 1.50
    expect(names('usd>=2')).toEqual(['Lightning Bolt']);
    expect(names('t:artifact', 'usd')).toEqual(['Sol Ring', 'Mystery']); // priced cards first, unpriced last
    const sol = searchCards(db, { query: 'sol ring' }).cards[0]!;
    expect(sol).toMatchObject({ usd: 1.5, usdMin: 0.9, usdMinSet: 'c21' });

    importCollection(db, '2 Sol Ring\n1 Mystery', 'replace');
    expect(collectionSummary(db)).toEqual({ unique: 2, total: 3, valueUsd: 1.8, unpriced: 1 });

    const deck = importDeck(db, 'Deck\n3 Lightning Bolt\n1 Sol Ring', { name: 'd', format: 'modern' }).deck;
    const rep = deckMissing(db, deck.id);
    expect(rep.missing.map((m) => [m.card.name, m.costUsd])).toEqual([['Lightning Bolt', 6]]); // 3 x 2.00 cheapest (Sol Ring is owned)
    expect(rep.totalUsd).toBe(6);
  });
  it('without cheapest prices, the featured price is used as before', async () => {
    const db = await seeded();
    expect(searchCards(db, { query: 'usd<2' }).cards.map((c) => c.name)).toEqual(['Sol Ring']);
    importCollection(db, '2 Sol Ring', 'replace');
    expect(collectionSummary(db).valueUsd).toBe(3);
  });
});

describe('DataManager prices', () => {
  const setup = async () => {
    const dataDir = tmpDir();
    const db = openDb(dbPathFor(dataDir));
    const pricesFile = join(dataDir, 'prices.jsonl');
    writeFileSync(pricesFile, jsonl(PRINTINGS));
    const dm = new DataManager({ dataDir, db, localFile: writeBulk(dataDir, 'cards.jsonl', CARDS), localPrices: pricesFile });
    return { dataDir, db, dm };
  };

  it('is off by default; turning it on applies cheapest prices and reports it', async () => {
    const { dm, db } = await setup();
    dm.start(); await dm.idle();
    expect(dm.status().prices).toEqual({ enabled: false, updatedAt: null });
    expect(row(db, 'Sol Ring').usd_min).toBeNull();
    dm.start({ prices: true }); await dm.idle();
    expect(dm.status().prices).toMatchObject({ enabled: true, updatedAt: 'local' });
    expect(row(db, 'Sol Ring').usd_min).toBe(0.9);
  });

  it('starts the price history afresh when cheapest prices are turned on or off, so re-pricing is not mistaken for a market move', async () => {
    const { dm, db } = await setup();
    dm.start(); await dm.idle();
    const sol = (db.prepare("SELECT id FROM cards WHERE name = 'Sol Ring'").get() as { id: string }).id;
    db.prepare('INSERT INTO collection (card_id, qty) VALUES (?, 1)').run(sol);
    const history = () => (db.prepare('SELECT price FROM price_history WHERE card_id = ?').all(sol) as Array<{ price: number }>).map((r) => r.price);
    snapshotPrices(db);
    expect(history()).toEqual([1.5]);
    dm.start({ prices: true }); await dm.idle();
    expect(history()).toEqual([0.9]); // the old basis is gone; only the new one is recorded
    dm.start({ force: true }); await dm.idle(); // an ordinary update keeps the history (and records only what changed)
    expect(history()).toEqual([0.9]);
    dm.start({ prices: false }); await dm.idle();
    expect(history()).toEqual([1.5]);
  });

  it('stays on across card updates, and turning it off clears the prices', async () => {
    const { dm, db } = await setup();
    dm.start({ prices: true }); await dm.idle();
    dm.start({ force: true }); await dm.idle(); // the card pool is replaced, wiping usd_min, then re-applied
    expect(row(db, 'Sol Ring').usd_min).toBe(0.9);
    dm.start({ prices: false }); await dm.idle();
    expect(dm.status().prices).toEqual({ enabled: false, updatedAt: null });
    expect(row(db, 'Sol Ring').usd_min).toBeNull();
    expect(row(db, 'Sol Ring').usd).toBe(1.5);
  });

  const manifest = (cards: string, prices: string) => ({ data: [
    { type: 'oracle_cards', updated_at: cards, jsonl_download_uri: 'https://x/cards.jsonl.gz' },
    { type: 'default_cards', updated_at: prices, jsonl_download_uri: 'https://x/default.jsonl.gz' },
  ] });
  const fakeFetch = (m: ReturnType<typeof manifest>, calls: string[], failPrices = false) => (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/bulk-data')) return Response.json(m);
    if (u.includes('default')) return failPrices ? new Response('no', { status: 503 }) : new Response(new Uint8Array(gzipSync(jsonl(PRINTINGS))));
    return new Response(new Uint8Array(gzipSync(jsonl(CARDS))));
  }) as typeof fetch;

  it('downloads the big file once, reuses the cached copy when only the cards change, and refreshes after a week', async () => {
    const dataDir = tmpDir();
    const db = openDb(dbPathFor(dataDir));
    const calls: string[] = [];
    const downloads = () => calls.filter((u) => u.includes('default')).length;
    let dm = new DataManager({ dataDir, db, fetch: fakeFetch(manifest('2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'), calls) });
    dm.start({ prices: true }); await dm.idle();
    expect(downloads()).toBe(1);
    expect(row(db, 'Sol Ring').usd_min).toBe(0.9);

    // A newer card pool arrives the next day: cards re-import, prices come back from the cache with no new download.
    dm = new DataManager({ dataDir, db, fetch: fakeFetch(manifest('2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z'), calls) });
    dm.start(); await dm.idle();
    expect(downloads()).toBe(1);
    expect(row(db, 'Sol Ring').usd_min).toBe(0.9);

    // Eight days later the prices are stale and a newer file exists: download again.
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('prices_checked_at', ?)").run(new Date(Date.now() - 8 * 864e5).toISOString());
    dm = new DataManager({ dataDir, db, fetch: fakeFetch(manifest('2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z'), calls) });
    dm.start(); await dm.idle();
    expect(downloads()).toBe(2);
    expect(dm.status().prices!.updatedAt).toBe('2026-10-10T00:00:00Z');
  });

  it('a failed price download is a warning: the cards are fine and prices stay enabled for a retry', async () => {
    const dataDir = tmpDir();
    const db = openDb(dbPathFor(dataDir));
    const dm = new DataManager({ dataDir, db, fetch: fakeFetch(manifest('2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'), [], true) });
    dm.start({ prices: true }); await dm.idle();
    const s = dm.status();
    expect(s).toMatchObject({ state: 'ready', cardCount: 3, prices: { enabled: true, updatedAt: null } });
    expect(s.warning).toMatch(/prices.*503/);
  });
});

describe('prices API', () => {
  it('POST /api/data/prices turns them on and off', async () => {
    const dataDir = tmpDir();
    const db = openDb(dbPathFor(dataDir));
    const pricesFile = join(dataDir, 'p.jsonl');
    writeFileSync(pricesFile, jsonl(PRINTINGS));
    const app = buildServer({ db, dataDir, logger: false, bulkFile: writeBulk(dataDir, 'c.jsonl', CARDS), pricesFile });
    app.data.start(); await app.data.idle();
    const post = (enabled: boolean) => app.inject({ method: 'POST', url: '/api/data/prices', payload: { enabled } });
    expect((await post(true)).statusCode).toBe(202);
    await app.data.idle();
    expect(((await app.inject({ method: 'GET', url: '/api/data/status' })).json() as DataStatus).prices).toMatchObject({ enabled: true });
    expect(row(db, 'Sol Ring').usd_min).toBe(0.9);
    await post(false);
    await app.data.idle();
    expect(row(db, 'Sol Ring').usd_min).toBeNull();
  });
});
