import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseComprehensiveRules } from '@grimoire/shared';
import { openDb, type NodeDb } from './db.js';
import { loadJsonl, loadRulings, loadTags } from './ingest.js';
import { loadAliases } from './names.js';
import { loadPrintings } from './printings.js';
import { loadRules, searchRules, rulesStatus } from './rules.js';
import { createDeck, getDeck, setCardQty } from './decks.js';
import { setOwned, setOwnedPrinting } from './collection.js';
import { getCardByName, searchCards } from './cards.js';
import { applyCardData, CARD_DATA_TABLES, type CardDataManifest } from './carddata.js';
import { buildCardData } from './carddata-build.js';
import { DATA_VERSION } from './data.js';
import { SCHEMA_VERSION } from './schema.js';
import { SAMPLE_RULES_TEXT, sfCard, tmpDir } from './testutil.js';

const lines = async function* (objs: object[]) { for (const o of objs) yield JSON.stringify(o); };

/** A database holding a version of the card data: cards, rulings, tags, rules, aliases and printings. */
async function seed(path: string, version: string, cards: Array<[string, string, string]>, extra: { rule?: string } = {}): Promise<NodeDb> {
  const db = openDb(path);
  await loadJsonl(db, lines(cards.map(([id, name, text]) => sfCard({ name, oracle_id: id, oracle_text: text, type_line: 'Artifact' }))));
  await loadRulings(db, lines(cards.map(([id]) => ({ oracle_id: id, source: 'wotc', published_at: version, comment: `Ruling from ${version}` }))));
  await loadTags(db, lines([{ id: 't1', slug: 'ramp', label: 'Ramp', description: null, taggings: cards.map(([id]) => ({ oracle_id: id })) }]));
  loadRules(db, parseComprehensiveRules(SAMPLE_RULES_TEXT.replace('100.1.', extra.rule ?? '100.1.')));
  loadAliases(db, [[`Nickname ${version}`, cards[0]![0]]]);
  loadPrintings(db, { version, sets: [['tst', `Test ${version}`, '2020-01-01']], rows: cards.map(([id], i) => [`p-${id}`, id, 'tst', String(i + 1), 1, 1, 0, 0, '2020-01-01']) });
  const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  put.run('bulk_updated_at', version); put.run('card_count', String(cards.length)); put.run('data_version', String(DATA_VERSION)); put.run('printings_version', version);
  return db;
}

/** Package a seeded source database the way CI does, and unpack the gzipped result to a file the app could attach. */
function packaged(srcPath: string): { manifest: CardDataManifest; dbPath: string } {
  const outDir = tmpDir();
  const manifest = buildCardData(srcPath, outDir, { minCards: 1 });
  const dbPath = join(outDir, 'unpacked.db');
  writeFileSync(dbPath, gunzipSync(readFileSync(join(outDir, manifest.file))));
  return { manifest, dbPath };
}

const OLD: Array<[string, string, string]> = [['o-sol', 'Sol Ring', 'Old text'], ['o-gone', 'Retired Card', 'Going away']];
const NEW: Array<[string, string, string]> = [['o-sol', 'Sol Ring', 'New text'], ['o-fresh', 'Fresh Card', 'Brand new']];

describe('replacing the card data', () => {
  it('swaps every card table, and leaves decks, collection and printing records exactly as they were', async () => {
    const dir = tmpDir();
    const source = await seed(join(dir, 'source.db'), '2026-10-10', NEW, { rule: '100.1. UPDATED RULE TEXT trample.' });
    source.close();
    const { manifest, dbPath } = packaged(join(dir, 'source.db'));
    expect(manifest).toMatchObject({ version: '2026-10-10', dataVersion: DATA_VERSION, schema: SCHEMA_VERSION, cards: 2, file: 'card-data.db.gz' });

    const device = await seed(join(dir, 'device.db'), '2026-10-01', OLD);
    // The user's things: a deck, a collection, a recorded printing, and an embedding.
    const deck = createDeck(device, 'My deck');
    setCardQty(device, deck.id, 'o-sol', 'main', 1);
    setCardQty(device, deck.id, 'o-gone', 'main', 2);
    setOwned(device, 'o-sol', 2);
    setOwnedPrinting(device, 'p-o-sol', 'nonfoil', 1, { claim: true });
    device.prepare('INSERT INTO embeddings (card_id, hash, vec) VALUES (?, ?, ?)').run('o-sol', 7, new Uint8Array([1, 2, 3]));

    const result = applyCardData(device, dbPath, { minCards: 1 });
    expect(result.cards).toBe(2);
    expect(result.tables).toEqual(expect.arrayContaining([...CARD_DATA_TABLES, 'rules_fts', 'glossary_fts']));

    // New data is in.
    expect(searchCards(device, { query: 'o:"New text"' }).cards.map((c) => c.name)).toEqual(['Sol Ring']);
    expect(searchCards(device, { query: 'name:fresh' }).cards.map((c) => c.name)).toEqual(['Fresh Card']);
    expect(getCardByName(device, 'Retired Card')).toBeNull();
    expect((device.prepare('SELECT comment FROM rulings').all() as Array<{ comment: string }>).map((r) => r.comment).sort()).toEqual(['Ruling from 2026-10-10', 'Ruling from 2026-10-10']);
    expect((device.prepare('SELECT count(*) AS n FROM card_tags WHERE tag = ?').get('ramp') as { n: number }).n).toBe(2);
    expect(searchRules(device, 'trample').rules.some((r) => r.text.includes('UPDATED RULE TEXT'))).toBe(true); // the full-text index came across too
    expect(rulesStatus(device).loaded).toBe(true);
    expect(device.prepare('SELECT alias FROM card_aliases').all()).toEqual([{ alias: 'Nickname 2026-10-10' }]);
    expect(device.prepare('SELECT id, set_code FROM printings ORDER BY id').all()).toEqual([{ id: 'p-o-fresh', set_code: 'tst' }, { id: 'p-o-sol', set_code: 'tst' }]);
    expect(device.prepare('SELECT name FROM sets').get()).toEqual({ name: 'Test 2026-10-10' });
    const meta = (k: string) => (device.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: string }).value;
    expect([meta('bulk_updated_at'), meta('card_count'), meta('printings_version')]).toEqual(['2026-10-10', '2', '2026-10-10']);

    // The user's things are untouched, including a deck card whose card is gone from the new data.
    expect(getDeck(device, deck.id).entries.map((e) => `${e.qty} ${e.card.name}`)).toEqual(['1 Sol Ring']); // (Retired Card has no card now; its row is still there)
    expect((device.prepare('SELECT card_id, qty FROM deck_cards ORDER BY card_id').all() as Array<{ card_id: string; qty: number }>).map((r) => `${r.card_id}:${r.qty}`)).toEqual(['o-gone:2', 'o-sol:1']);
    expect(getCardByName(device, 'Sol Ring')).toMatchObject({ owned: 2, ownedPrinting: { id: 'p-o-sol', finish: 'nonfoil' } });
    expect(device.prepare('SELECT card_id, hash FROM embeddings').all()).toEqual([{ card_id: 'o-sol', hash: 7 }]);
  });

  it('the published file holds only card data: no user tables, no indexes, no embeddings', async () => {
    const dir = tmpDir();
    const source = await seed(join(dir, 'source.db'), 'v', NEW);
    createDeck(source, 'Private deck'); setOwned(source, 'o-sol', 5);
    source.prepare('INSERT INTO embeddings (card_id, hash, vec) VALUES (?, ?, ?)').run('o-sol', 1, new Uint8Array(4));
    source.prepare("INSERT INTO meta (key, value) VALUES ('prices_enabled', '1')").run();
    source.close();
    const { dbPath } = packaged(join(dir, 'source.db'));
    const built = new DatabaseSync(dbPath, { readOnly: true });
    const tables = (built.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%\\_fts\\_%' ESCAPE '\\'").all() as Array<{ name: string }>).map((r) => r.name).sort();
    expect(tables).toEqual([...CARD_DATA_TABLES, 'glossary_fts', 'meta', 'rules_fts'].sort());
    expect(built.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all()).toEqual([]);
    expect((built.prepare('SELECT key FROM meta ORDER BY key').all() as Array<{ key: string }>).map((r) => r.key)).not.toContain('prices_enabled');
    built.close();
  });

  it('refuses card data from a newer schema, a damaged file and a file that is not card data, leaving the old data alone', async () => {
    const dir = tmpDir();
    (await seed(join(dir, 'source.db'), 'v2', NEW)).close();
    const { dbPath } = packaged(join(dir, 'source.db'));
    const device = await seed(join(dir, 'device.db'), 'v1', OLD);
    const before = () => JSON.stringify([device.prepare('SELECT id, name, oracle_text FROM cards ORDER BY id').all(), device.prepare("SELECT value FROM meta WHERE key = 'bulk_updated_at'").get()]);
    const snapshot = before();

    expect(() => applyCardData(device, dbPath)).toThrow(/damaged \(2 cards\)/); // the default floor refuses a tiny pool
    const newer = new DatabaseSync(dbPath);
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`); newer.close();
    expect(() => applyCardData(device, dbPath, { minCards: 1 })).toThrow(/newer version of Brewhall/);
    const empty = join(dir, 'empty.db');
    new DatabaseSync(empty).close();
    expect(() => applyCardData(device, empty, { minCards: 1 })).toThrow(/isn't card data/);
    expect(before()).toBe(snapshot);
  });

  it('is all or nothing: a failure part-way rolls the whole swap back, and the next attempt can still attach', async () => {
    const dir = tmpDir();
    (await seed(join(dir, 'source.db'), 'v2', NEW)).close();
    const { dbPath } = packaged(join(dir, 'source.db'));
    const device = await seed(join(dir, 'device.db'), 'v1', OLD);
    device.exec("CREATE TRIGGER boom BEFORE INSERT ON rulings BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => applyCardData(device, dbPath, { minCards: 1 })).toThrow(/disk full/);
    expect(searchCards(device, { query: 'o:"Old text"' }).total).toBe(1); // cards were swapped before rulings failed: all undone
    expect(getCardByName(device, 'Fresh Card')).toBeNull();
    device.exec('DROP TRIGGER boom');
    expect(applyCardData(device, dbPath, { minCards: 1 }).cards).toBe(2); // DETACH happened, so attaching again works
    expect(getCardByName(device, 'Fresh Card')).not.toBeNull();
  });

  it('matches columns by name, so a database with extra or reordered columns still takes the data', async () => {
    const dir = tmpDir();
    (await seed(join(dir, 'source.db'), 'v2', NEW)).close();
    const { dbPath } = packaged(join(dir, 'source.db'));
    const fresh = new DatabaseSync(dbPath);
    fresh.exec('ALTER TABLE cards ADD COLUMN from_the_future TEXT'); // card data from a newer build that has a column this app lacks
    fresh.close();
    const device = await seed(join(dir, 'device.db'), 'v1', OLD);
    device.exec('ALTER TABLE cards ADD COLUMN only_here TEXT DEFAULT \'kept\''); // and an app with one the data lacks
    expect(applyCardData(device, dbPath, { minCards: 1 }).cards).toBe(2);
    expect(device.prepare("SELECT name, only_here FROM cards WHERE id = 'o-fresh'").get()).toEqual({ name: 'Fresh Card', only_here: 'kept' });
  });

  it('applying the same data twice gives the same result', async () => {
    const dir = tmpDir();
    (await seed(join(dir, 'source.db'), 'v2', NEW)).close();
    const { dbPath } = packaged(join(dir, 'source.db'));
    const device = await seed(join(dir, 'device.db'), 'v1', OLD);
    applyCardData(device, dbPath, { minCards: 1 });
    applyCardData(device, dbPath, { minCards: 1 });
    expect((device.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n).toBe(2);
    expect((device.prepare('SELECT count(*) AS n FROM rules_fts').get() as { n: number }).n).toBe((device.prepare('SELECT count(*) AS n FROM rules').get() as { n: number }).n);
  });

  it('building from a database with no card data says so', () => {
    const dir = tmpDir();
    openDb(join(dir, 'empty.db')).close();
    expect(() => buildCardData(join(dir, 'empty.db'), join(dir, 'out'))).toThrow(/no card data/);
    expect(() => buildCardData(join(dir, 'empty.db'), join(dir, 'out'), { minCards: 0 })).toThrow(/no card data/); // (no version either)
  });
});

describe('what the Android app assumes', () => {
  it('knows the same data version as the downloader, so it refuses card data shaped for a newer app', () => {
    const source = readFileSync(new URL('../../mobile/src/dataVersion.ts', import.meta.url), 'utf8');
    expect(Number(/DATA_VERSION_FOR_UPDATES = (\d+)/.exec(source)?.[1])).toBe(DATA_VERSION);
  });
});
