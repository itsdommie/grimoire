import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CardDetail } from '@grimoire/shared';
import { dbPathFor, migrate, openDb, SCHEMA_VERSION, type NodeDb as Db } from './db.js';
import { DataManager, DATA_VERSION } from './data.js';
import { loadJsonl, loadRulings, loadTags } from './ingest.js';
import { searchCards } from './cards.js';
import { buildServer } from './server.js';
import { rulesResponse, sfCard, tmpDir, writeBulk } from './testutil.js';

const solRing = sfCard({ name: 'Sol Ring', type_line: 'Artifact', oracle_id: 'o-sol' });
const cultivate = sfCard({ name: 'Cultivate', type_line: 'Sorcery', color_identity: ['G'], colors: ['G'], oracle_id: 'o-cult' });
const wrath = sfCard({ name: 'Wrath of God', type_line: 'Sorcery', color_identity: ['W'], colors: ['W'], oracle_id: 'o-wrath' });
const dfc = sfCard({ name: 'Delver // Insectile', layout: 'transform', oracle_id: 'o-delver', type_line: 'Creature // Creature', card_faces: [{ mana_cost: '{U}', image_uris: { normal: 'https://img/front.jpg' } }, { image_uris: { normal: 'https://img/back.jpg' } }] });
const split = sfCard({ name: 'Fire // Ice', layout: 'split', oracle_id: 'o-fire', image_uris: { normal: 'https://img/fire.jpg' }, card_faces: [{ mana_cost: '{1}{R}' }, { mana_cost: '{1}{U}' }] });
const CARDS = [solRing, cultivate, wrath, dfc, split];

const tag = (id: string, slug: string, taggings: string[], extra: Record<string, unknown> = {}) => ({ object: 'tag', id, slug, label: slug, type: 'oracle', description: `${slug} desc`, parent_ids: [], child_ids: [], aliases: [], taggings: taggings.map((oracle_id) => ({ oracle_id, weight: 'median' })), ...extra });
const TAGS = [
  tag('t-ramp', 'ramp', [], { child_ids: ['t-rock', 't-landramp'], aliases: ['mana-ramp'] }),
  tag('t-rock', 'mana-rock', ['o-sol'], { parent_ids: ['t-ramp'] }),
  tag('t-landramp', 'land-ramp', ['o-cult'], { parent_ids: ['t-ramp'] }),
  tag('t-sweeper', 'sweeper', ['o-wrath', 'ghost-card-not-in-pool']),
  tag('t-noise', 'alliteration', ['o-sol']),
];
const RULINGS = [
  { object: 'ruling', oracle_id: 'o-sol', source: 'wotc', published_at: '2020-01-01', comment: 'Sol Ring taps for two colourless.' },
  { object: 'ruling', oracle_id: 'o-sol', source: 'scryfall', published_at: '2018-05-05', comment: 'An older ruling.' },
  { object: 'ruling', oracle_id: 'ghost-card-not-in-pool', source: 'wotc', published_at: '2020-01-01', comment: 'Should be dropped.' },
];
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const asLines = (rows: unknown[]) => (async function* () { for (const r of rows) yield JSON.stringify(r); })();

let db: Db;
beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, asLines(CARDS));
  await loadRulings(db, asLines(RULINGS));
  await loadTags(db, asLines(TAGS));
});

describe('rulings and tags import', () => {
  it('keeps only rulings and taggings for cards in the pool', () => {
    expect((db.prepare('SELECT count(*) AS n FROM rulings').get() as { n: number }).n).toBe(2);
    expect((db.prepare('SELECT count(*) AS n FROM card_tags').get() as { n: number }).n).toBe(4);
    expect((db.prepare("SELECT cards FROM tags WHERE slug = 'sweeper'").get() as { cards: number }).cards).toBe(1);
  });
  it('re-importing replaces rather than duplicates', async () => {
    await loadRulings(db, asLines(RULINGS));
    await loadTags(db, asLines(TAGS));
    expect((db.prepare('SELECT count(*) AS n FROM rulings').get() as { n: number }).n).toBe(2);
    expect((db.prepare('SELECT count(*) AS n FROM tags').get() as { n: number }).n).toBe(5);
  });
});

describe('otag: search', () => {
  const names = (q: string) => searchCards(db, { query: q }).cards.map((c) => c.name);
  it('matches direct taggings', () => expect(names('otag:sweeper')).toEqual(['Wrath of God']));
  it('includes descendant tags (a parent tag matches cards tagged only with its children)', () => expect(names('otag:ramp')).toEqual(['Cultivate', 'Sol Ring']));
  it('resolves aliases and the function:/oracletag: spellings', () => {
    expect(names('otag:mana-ramp')).toEqual(['Cultivate', 'Sol Ring']);
    expect(names('function:mana-rock')).toEqual(['Sol Ring']);
  });
  it('combines with other terms and negation', () => {
    expect(names('otag:ramp c:g')).toEqual(['Cultivate']);
    expect(names('t:sorcery -otag:ramp')).toEqual(['Wrath of God']);
  });
  it('rejects unknown tags with a helpful message, and says so when tags are not downloaded', () => {
    expect(() => names('otag:nonsense')).toThrow(/Unknown function tag "nonsense"/);
    const bare = openDb(':memory:');
    expect(() => searchCards(bare, { query: 'otag:ramp' })).toThrow(/aren't downloaded yet/);
  });
});

describe('back-face images', () => {
  it('stores the back of transform/modal cards but not of split cards', () => {
    const get = (n: string) => searchCards(db, { query: `!"${n}"` }).cards[0]!;
    expect(get('Delver // Insectile')).toMatchObject({ imageUrl: 'https://img/front.jpg', imageUrlBack: 'https://img/back.jpg' });
    expect(get('Fire // Ice').imageUrlBack).toBeNull();
  });
});

describe('card detail API', () => {
  it('returns rulings oldest first and meaningful tags only', async () => {
    const app = buildServer({ db, dataDir: '/x', logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/cards/o-sol/detail' });
    expect(res.statusCode).toBe(200);
    const d = res.json() as CardDetail;
    expect(d.card.name).toBe('Sol Ring');
    expect(d.rulings.map((r) => r.comment)).toEqual(['An older ruling.', 'Sol Ring taps for two colourless.']);
    // These fixture tags are all tiny (< 25 cards), so none are shown; real tags are filtered the same way.
    expect(d.tags).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/cards/nope/detail' })).statusCode).toBe(404);
  });
});

describe('DataManager with extras', () => {
  it('imports cards, rulings and tags from local files and reports ready, not outdated', async () => {
    const dataDir = tmpDir();
    const dbm = openDb(dbPathFor(dataDir));
    const dm = new DataManager({
      dataDir, db: dbm,
      localFile: writeBulk(dataDir, 'cards.jsonl', CARDS),
      localRulings: (() => { const f = join(dataDir, 'rulings.jsonl'); writeFileSync(f, jsonl(RULINGS)); return f; })(),
      localTags: (() => { const f = join(dataDir, 'tags.jsonl'); writeFileSync(f, jsonl(TAGS)); return f; })(),
    });
    expect(dm.status()).toMatchObject({ state: 'empty' });
    dm.start(); await dm.idle();
    expect(dm.status()).toMatchObject({ state: 'ready', cardCount: 5 });
    expect(dm.status().outdated).toBeUndefined();
    expect(dm.status().warning).toBeUndefined();
    expect(searchCards(dbm, { query: 'otag:ramp' }).total).toBe(2);
  });

  it('a card-only local import is not "outdated" when no extras are configured', async () => {
    const dataDir = tmpDir();
    const dbm = openDb(dbPathFor(dataDir));
    const dm = new DataManager({ dataDir, db: dbm, localFile: writeBulk(dataDir, 'c.jsonl', CARDS) });
    dm.start(); await dm.idle();
    expect(dm.status().outdated).toBeUndefined();
  });

  it('flags older data as outdated and re-imports from the cached file, keeping decks and collection', async () => {
    const dataDir = tmpDir();
    const dbm = openDb(dbPathFor(dataDir));
    const cards = writeBulk(dataDir, 'c.jsonl', CARDS);
    const dm = new DataManager({ dataDir, db: dbm, localFile: cards });
    dm.start(); await dm.idle();
    dbm.prepare("INSERT INTO decks (name) VALUES ('keep me')").run();
    dbm.prepare("INSERT INTO collection (card_id, qty) VALUES ('o-sol', 2)").run();

    dbm.prepare("UPDATE meta SET value = '1' WHERE key = 'data_version'").run(); // simulate an install from an older app version
    expect(dm.status().outdated).toBe(true);
    dm.start(); await dm.idle();
    expect(dm.status().outdated).toBeUndefined();
    expect(dbm.prepare("SELECT value FROM meta WHERE key = 'data_version'").get()).toMatchObject({ value: String(DATA_VERSION) });
    expect((dbm.prepare('SELECT count(*) AS n FROM decks').get() as { n: number }).n).toBe(1);
    expect((dbm.prepare('SELECT qty FROM collection').get() as { qty: number }).qty).toBe(2);
  });

  it('downloads extras from the manifest, and a failing extra is a warning rather than a failed update', async () => {
    const gz = (await import('node:zlib')).gzipSync;
    const bodies: Record<string, Buffer> = { cards: gz(jsonl(CARDS)), rulings: gz(jsonl(RULINGS)), tags: gz(jsonl(TAGS)) };
    const make = (failTags: boolean) => (async (url: string | URL | Request) => {
      const u = String(url);
      const rules = rulesResponse(u);
      if (rules) return rules;
      if (u.endsWith('/bulk-data')) return Response.json({ data: [
        { type: 'oracle_cards', updated_at: '2026-10-02T00:00:00Z', jsonl_download_uri: 'https://x/cards.jsonl.gz' },
        { type: 'rulings', updated_at: '2026-10-02T00:00:00Z', jsonl_download_uri: 'https://x/rulings.jsonl.gz' },
        { type: 'oracle_tags', updated_at: '2026-10-02T00:00:00Z', jsonl_download_uri: 'https://x/tags.jsonl.gz' },
      ] });
      if (failTags && u.includes('tags')) return new Response('no', { status: 503 });
      const body = u.includes('cards') ? bodies.cards! : u.includes('rulings') ? bodies.rulings! : bodies.tags!;
      return new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } });
    }) as typeof fetch;

    const dataDir = tmpDir();
    const dbm = openDb(dbPathFor(dataDir));
    const bad = new DataManager({ dataDir, db: dbm, fetch: make(true) });
    bad.start(); await bad.idle();
    expect(bad.status()).toMatchObject({ state: 'ready', cardCount: 5 });
    expect(bad.status().warning).toMatch(/card tags.*503/);
    expect(bad.status().outdated).toBe(true); // tags still missing, so the app will try again later

    const good = new DataManager({ dataDir, db: dbm, fetch: make(false) });
    good.start(); await good.idle();
    expect(good.status().warning).toBeUndefined();
    expect(good.status().outdated).toBeUndefined();
    expect(searchCards(dbm, { query: 'otag:sweeper' }).total).toBe(1);
  });
});

describe('migrations', () => {
  it('upgrades a database created before back-face images existed, without touching user data', () => {
    const dir = tmpDir();
    const path = dbPathFor(dir);
    // A v1-shaped file: cards without image_url_back, a deck, a collection row, no user_version.
    const old = new DatabaseSync(path);
    old.exec(SCHEMA_V1_CARDS);
    old.exec("CREATE TABLE decks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'commander', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    old.exec("INSERT INTO decks (name) VALUES ('legacy deck')");
    old.close();

    const upgraded = openDb(path);
    expect((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect((upgraded.prepare("SELECT count(*) AS n FROM pragma_table_info('cards') WHERE name = 'image_url_back'").get() as { n: number }).n).toBe(1);
    expect((upgraded.prepare('SELECT name FROM decks').get() as { name: string }).name).toBe('legacy deck');
    expect(() => migrate(upgraded)).not.toThrow(); // idempotent
  });
});

const SCHEMA_V1_CARDS = `CREATE TABLE cards (id TEXT PRIMARY KEY, name TEXT NOT NULL, mana_cost TEXT NOT NULL DEFAULT '', cmc REAL NOT NULL DEFAULT 0, type_line TEXT NOT NULL DEFAULT '',
  oracle_text TEXT NOT NULL DEFAULT '', colors INTEGER NOT NULL DEFAULT 0, colors_count INTEGER NOT NULL DEFAULT 0, color_identity INTEGER NOT NULL DEFAULT 0, identity_count INTEGER NOT NULL DEFAULT 0,
  produced_mana INTEGER NOT NULL DEFAULT 0, keywords TEXT NOT NULL DEFAULT '', power TEXT, toughness TEXT, loyalty TEXT, power_n REAL, toughness_n REAL, loyalty_n REAL, rarity TEXT NOT NULL,
  rarity_n INTEGER NOT NULL, set_code TEXT NOT NULL, layout TEXT NOT NULL, digital INTEGER NOT NULL DEFAULT 0, edhrec_rank INTEGER, usd REAL, image_url TEXT, scryfall_uri TEXT NOT NULL)`;


