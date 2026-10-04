import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RestoreResult, UserDataBackup } from '@grimoire/shared';
import { dbPathFor, openDb, SCHEMA_VERSION, type NodeDb as Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { buildServer } from './server.js';
import { exportUserData, parseBackup, restoreUserData } from './backup.js';
import { importCollection } from './collection.js';
import { createDeck, getDeck, importDeck, listDecks } from './decks.js';
import { sfCard, tmpDir } from './testutil.js';

const CARDS = [
  sfCard({ name: 'Sol Ring', type_line: 'Artifact', oracle_id: 'o-sol' }),
  sfCard({ name: 'Cultivate', type_line: 'Sorcery', oracle_id: 'o-cult', color_identity: ['G'] }),
  sfCard({ name: 'Forest', type_line: 'Basic Land — Forest', oracle_id: 'o-forest', color_identity: ['G'] }),
  sfCard({ name: 'Cmdr', type_line: 'Legendary Creature — Elf', oracle_id: 'o-cmdr', color_identity: ['G'] }),
];
const lines = () => (async function* () { for (const c of CARDS) yield JSON.stringify(c); })();
async function freshDb(): Promise<Db> { const db = openDb(':memory:'); await loadJsonl(db, lines()); return db; }

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  importDeck(db, 'Commander\n1 Cmdr\nDeck\n1 Sol Ring\n1 Cultivate\n20 Forest\nSideboard\n1 Sol Ring', { name: 'Elves' });
  createDeck(db, 'Empty deck');
  importCollection(db, '3 Sol Ring\n1 Cultivate', 'replace');
});

describe('backups made before the app was renamed', () => {
  it('are still recognised and restored, and anything else is still refused', async () => {
    const target = await freshDb();
    const old = { app: 'grimoire', version: 1, exportedAt: '', decks: [{ name: 'From the Grimoire days', format: 'commander', cards: [] }], collection: [{ id: 'o-sol', name: 'Sol Ring', qty: 2 }] };
    expect(restoreUserData(target, old, 'merge')).toMatchObject({ decks: 1, collectionCopies: 2 });
    expect(() => parseBackup({ ...old, app: 'someone-else' })).toThrow(/doesn't look like a Brewhall backup/);
  });
});

describe('export / restore', () => {
  it('round-trips decks and collection into a fresh database', async () => {
    const backup = exportUserData(db);
    expect(backup).toMatchObject({ app: 'brewhall', version: 1 });
    expect(backup.decks.map((d) => d.name)).toEqual(['Elves', 'Empty deck']);
    expect(JSON.parse(JSON.stringify(backup))).toEqual(backup); // plain JSON

    const target = await freshDb();
    const r = restoreUserData(target, backup, 'merge');
    expect(r).toMatchObject({ decks: 2, collectionCards: 2, collectionCopies: 4, unresolved: [] });
    expect(listDecks(target).map((d) => d.name).sort()).toEqual(['Elves', 'Empty deck']);
    const elves = getDeck(target, listDecks(target).find((d) => d.name === 'Elves')!.id);
    expect(elves.entries.map((e) => [e.card.name, e.board, e.qty]).sort()).toEqual(
      [['Cmdr', 'commander', 1], ['Cultivate', 'main', 1], ['Forest', 'main', 20], ['Sol Ring', 'main', 1], ['Sol Ring', 'sideboard', 1]].sort(),
    );
    expect(exportUserData(target).collection).toEqual(backup.collection);
  });

  it('merge adds to what is there; replace wipes first', () => {
    const backup = exportUserData(db);
    restoreUserData(db, backup, 'merge');
    expect(listDecks(db)).toHaveLength(4); // duplicated, never overwritten
    expect(exportUserData(db).collection.find((c) => c.id === 'o-sol')!.qty).toBe(6);
    restoreUserData(db, backup, 'replace');
    expect(listDecks(db)).toHaveLength(2);
    expect(exportUserData(db).collection.find((c) => c.id === 'o-sol')!.qty).toBe(3);
  });

  it('falls back to the card name when an id is gone, and reports cards that cannot be found', async () => {
    const backup: UserDataBackup = {
      app: 'grimoire', version: 1, exportedAt: '', collection: [{ id: 'old-id', name: 'Sol Ring', qty: 2 }, { id: 'nope', name: 'Vanished Card', qty: 1 }],
      decks: [{ name: 'D', format: 'commander', cards: [{ id: 'old-id-2', name: 'Cultivate', board: 'main', qty: 1 }, { id: 'zzz', name: '', board: 'main', qty: 1 }] }],
    };
    const target = await freshDb();
    const r = restoreUserData(target, backup, 'merge');
    expect(r).toMatchObject({ decks: 1, deckCards: 1, collectionCards: 1, collectionCopies: 2 });
    expect(r.unresolved.sort()).toEqual(['Vanished Card', 'zzz']);
  });

  it('is atomic: a bad backup changes nothing', () => {
    const before = JSON.stringify(exportUserData(db).decks);
    expect(() => restoreUserData(db, { app: 'grimoire', version: 1, decks: [{ name: 'x', cards: [{ id: 'o-sol', board: 'nope', qty: 1 }] }], collection: [] }, 'replace')).toThrow(/malformed/);
    expect(JSON.stringify(exportUserData(db).decks)).toBe(before);
  });
});

describe('parseBackup', () => {
  it.each([
    [null, /doesn't look like a Brewhall backup/],
    [{ app: 'other' }, /doesn't look like a Brewhall backup/],
    [{ app: 'grimoire', version: 2, decks: [], collection: [] }, /version 2/],
    [{ app: 'grimoire', version: 1, decks: 'x' }, /missing its decks or collection/],
    [{ app: 'grimoire', version: 1, decks: [{ name: 5, cards: [] }], collection: [] }, /deck in the backup is malformed/],
    [{ app: 'grimoire', version: 1, decks: [], collection: [{ id: 'a', qty: 0 }] }, /collection entry/],
  ])('rejects %j', (input, message) => {
    expect(() => parseBackup(input)).toThrow(message);
  });
});

describe('backup API', () => {
  it('downloads a JSON file and restores it', async () => {
    const app = buildServer({ db, dataDir: '/x', logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/backup' });
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="brewhall-backup-\d{4}-\d{2}-\d{2}\.json"/);
    const data = JSON.parse(res.body);
    const restored = await app.inject({ method: 'POST', url: '/api/backup/restore', payload: { data, mode: 'replace' } });
    expect(restored.statusCode).toBe(201);
    expect((restored.json() as RestoreResult).decks).toBe(2);
    expect((await app.inject({ method: 'POST', url: '/api/backup/restore', payload: { data: { app: 'nope' } } })).statusCode).toBe(400);
  });

  it('accepts large bodies (a big collection export is several MB)', async () => {
    const app = buildServer({ db, dataDir: '/x', logger: false });
    const text = 'Name,Quantity\n' + 'Sol Ring,1\n'.repeat(150_000); // ~1.6 MB, over Fastify's default 1 MB limit
    const res = await app.inject({ method: 'POST', url: '/api/collection/import', payload: { text, mode: 'replace' } });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { imported: number }).imported).toBe(150_000);
  });
});

describe('safety copy before migrating', () => {
  const OLD_DECKS = "CREATE TABLE decks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'commander', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))";
  const makeOld = (withDeck: boolean) => {
    const path = dbPathFor(tmpDir());
    const old = new DatabaseSync(path);
    old.exec(OLD_DECKS);
    if (withDeck) old.exec("INSERT INTO decks (name) VALUES ('precious')");
    old.close();
    return path;
  };

  it('copies only the user tables when an old database holds decks', () => {
    const path = makeOld(true);
    openDb(path).close();
    const dir = join(dirname(path), 'backups');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^user-data-before-v${SCHEMA_VERSION}-`));
    const copy = new DatabaseSync(join(dir, files[0]!));
    expect((copy.prepare('SELECT name FROM decks').get() as { name: string }).name).toBe('precious');
    expect(() => copy.prepare('SELECT 1 FROM cards LIMIT 1').get()).toThrow(); // no card data: copies stay small
  });

  it('makes no copy for a fresh database or one without user data, and none once migrated', () => {
    const fresh = dbPathFor(tmpDir());
    openDb(fresh).close();
    expect(existsSync(join(dirname(fresh), 'backups'))).toBe(false);
    const empty = makeOld(false);
    openDb(empty).close();
    expect(existsSync(join(dirname(empty), 'backups'))).toBe(false);
    const path = makeOld(true);
    openDb(path).close();
    openDb(path).close(); // already at the current version
    expect(readdirSync(join(dirname(path), 'backups'))).toHaveLength(1);
  });
});
