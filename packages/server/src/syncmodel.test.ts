import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb, migrate, SCHEMA_VERSION, type NodeDb as Db } from './db.js';

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const one = (db: Db, sql: string, ...p: Array<string | number>) => db.prepare(sql).get(...p) as Record<string, unknown>;
const all = (db: Db, sql: string, ...p: Array<string | number>) => db.prepare(sql).all(...p) as Array<Record<string, unknown>>;
const tombs = (db: Db) => all(db, 'SELECT kind, key FROM sync_tombstones ORDER BY kind, key').map((r) => `${r.kind}:${r.key}`);

describe('upgrading a database from before sync (v10)', () => {
  // The user-data tables as v0.6.0 left them: stamped with datetime('now'), decks without a sync id, deck cards without a stamp.
  const v10 = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE decks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'commander', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE deck_cards (deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE, card_id TEXT NOT NULL, board TEXT NOT NULL, qty INTEGER NOT NULL, PRIMARY KEY (deck_id, card_id, board)) WITHOUT ROWID;
      CREATE TABLE collection (card_id TEXT PRIMARY KEY, qty INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE collection_prints (card_id TEXT NOT NULL, printing_id TEXT NOT NULL, finish TEXT NOT NULL, qty INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (printing_id, finish)) WITHOUT ROWID;
      CREATE TABLE wishlist (card_id TEXT PRIMARY KEY, want INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO decks (id, name, updated_at) VALUES (1, 'Old A', '2026-01-02 03:04:05'), (2, 'Old B', '2026-02-03 04:05:06');
      INSERT INTO deck_cards VALUES (1, 'c1', 'main', 2), (2, 'c2', 'commander', 1);
      INSERT INTO collection VALUES ('c1', 3, '2026-01-02 03:04:05');
      INSERT INTO collection_prints VALUES ('c1', 'p1', 'foil', 1, '2026-01-02 03:04:05');
      INSERT INTO wishlist VALUES ('c3', 2, '2026-03-04 05:06:07');
      PRAGMA user_version = 10;
    `);
    return db as unknown as Db;
  };

  it('keeps every deck, card and count, gives decks their own ids and stamps everything in one format', () => {
    const db = v10();
    migrate(db);
    expect(one(db, 'PRAGMA user_version').user_version).toBe(SCHEMA_VERSION);
    expect(all(db, 'SELECT name FROM decks ORDER BY id')).toEqual([{ name: 'Old A' }, { name: 'Old B' }]);
    expect(all(db, 'SELECT card_id, qty FROM deck_cards ORDER BY card_id')).toEqual([{ card_id: 'c1', qty: 2 }, { card_id: 'c2', qty: 1 }]);
    expect(one(db, 'SELECT qty FROM collection').qty).toBe(3);
    const ids = all(db, 'SELECT sync_id FROM decks').map((r) => r.sync_id as string);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((i) => /^[0-9a-f]{32}$/.test(i))).toBe(true);
    expect(one(db, "SELECT updated_at FROM decks WHERE id = 1").updated_at).toBe('2026-01-02T03:04:05.000Z');
    expect(one(db, 'SELECT updated_at FROM collection').updated_at).toBe('2026-01-02T03:04:05.000Z');
    expect(one(db, 'SELECT updated_at FROM collection_prints').updated_at).toBe('2026-01-02T03:04:05.000Z');
    expect(one(db, 'SELECT updated_at FROM wishlist').updated_at).toBe('2026-03-04T05:06:07.000Z');
    expect(all(db, 'SELECT updated_at FROM deck_cards ORDER BY deck_id')).toEqual([{ updated_at: '2026-01-02T03:04:05.000Z' }, { updated_at: '2026-02-03T04:05:06.000Z' }]); // a deck card starts with its deck's stamp
    expect(tombs(db)).toEqual([]); // migrating is not deleting
  });

  it('can be run again without changing anything', () => {
    const db = v10();
    migrate(db);
    const before = JSON.stringify([all(db, 'SELECT * FROM decks'), all(db, 'SELECT * FROM deck_cards'), all(db, 'SELECT * FROM collection')]);
    migrate(db);
    expect(JSON.stringify([all(db, 'SELECT * FROM decks'), all(db, 'SELECT * FROM deck_cards'), all(db, 'SELECT * FROM collection')])).toBe(before);
  });
});

describe('stamps and deletion records', () => {
  it('stamps a collection row when it is added or changed, and remembers its deletion until it comes back', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO collection (card_id, qty) VALUES (?, ?)').run('c1', 1);
    const first = one(db, 'SELECT updated_at FROM collection').updated_at as string;
    expect(first).toMatch(ISO);
    db.prepare('UPDATE collection SET qty = 2 WHERE card_id = ?').run('c1');
    expect((one(db, 'SELECT updated_at FROM collection').updated_at as string) >= first).toBe(true);
    db.prepare('DELETE FROM collection WHERE card_id = ?').run('c1');
    expect(tombs(db)).toEqual(['collection:c1']);
    db.prepare('INSERT INTO collection (card_id, qty) VALUES (?, ?)').run('c1', 1);
    expect(tombs(db)).toEqual([]);
  });

  it('does the same through an upsert, which is how most of the app writes', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO collection (card_id, qty) VALUES ('c1', 1)").run();
    db.prepare("UPDATE collection SET updated_at = '2000-01-01T00:00:00.000Z'").run();
    db.prepare("INSERT INTO collection (card_id, qty) VALUES ('c1', 5) ON CONFLICT (card_id) DO UPDATE SET qty = excluded.qty, updated_at = datetime('now')").run();
    expect(one(db, 'SELECT qty, updated_at FROM collection')).toMatchObject({ qty: 5 });
    expect(one(db, 'SELECT updated_at FROM collection').updated_at).toMatch(ISO); // the app's own datetime('now') is replaced by the ISO stamp
    expect((one(db, 'SELECT updated_at FROM collection').updated_at as string) > '2000-01-01').toBe(true);
  });

  it('covers printings and the wishlist the same way', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO collection_prints (card_id, printing_id, finish, qty) VALUES ('c1', 'p1', 'foil', 1)").run();
    db.prepare("INSERT INTO wishlist (card_id, want) VALUES ('c2', 3)").run();
    expect(one(db, 'SELECT updated_at FROM collection_prints').updated_at).toMatch(ISO);
    expect(one(db, 'SELECT updated_at FROM wishlist').updated_at).toMatch(ISO);
    db.exec("DELETE FROM collection_prints; DELETE FROM wishlist");
    expect(tombs(db)).toEqual(['print:p1|foil', 'wish:c2']);
  });

  it('gives every new deck its own id and stamps its cards, bumping the deck whenever they change', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO decks (name, format) VALUES ('A', 'commander')").run();
    db.prepare("INSERT INTO decks (name, format) VALUES ('B', 'modern')").run();
    const decks = all(db, 'SELECT id, sync_id FROM decks ORDER BY id');
    expect(decks[0]!.sync_id).toMatch(/^[0-9a-f]{32}$/);
    expect(decks[0]!.sync_id).not.toBe(decks[1]!.sync_id);

    db.prepare("UPDATE decks SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = 1").run();
    db.prepare("INSERT INTO deck_cards (deck_id, card_id, board, qty) VALUES (1, 'c1', 'main', 1)").run();
    expect(one(db, 'SELECT updated_at FROM deck_cards').updated_at).toMatch(ISO);
    expect((one(db, 'SELECT updated_at FROM decks WHERE id = 1').updated_at as string) > '2000-01-01').toBe(true); // an edit to its cards is an edit to the deck

    db.prepare("DELETE FROM deck_cards WHERE deck_id = 1 AND card_id = 'c1'").run();
    expect(tombs(db)).toEqual([`deckcard:${decks[0]!.sync_id}|c1|main`]);
    db.prepare("INSERT INTO deck_cards (deck_id, card_id, board, qty) VALUES (1, 'c1', 'main', 1)").run();
    expect(tombs(db)).toEqual([]);
  });

  it('renaming a deck stamps it; deleting one leaves a single record for the deck, not one per card', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO decks (name) VALUES ('A')").run();
    const sid = one(db, 'SELECT sync_id FROM decks').sync_id as string;
    db.prepare("INSERT INTO deck_cards (deck_id, card_id, board, qty) VALUES (1, 'c1', 'main', 1), (1, 'c2', 'main', 1)").run();
    db.prepare("UPDATE decks SET updated_at = '2000-01-01T00:00:00.000Z'").run();
    db.prepare("UPDATE decks SET name = 'Renamed' WHERE id = 1").run();
    expect((one(db, 'SELECT updated_at FROM decks').updated_at as string) > '2000-01-01').toBe(true);
    db.prepare('DELETE FROM decks WHERE id = 1').run();
    expect(tombs(db)).toEqual([`deck:${sid}`]);
    expect(one(db, 'SELECT count(*) AS n FROM deck_cards').n).toBe(0);
  });

  it('stands down while a sync is applying, so remote changes keep the stamps they arrived with', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO meta (key, value) VALUES ('sync_applying', '1')").run();
    db.prepare("INSERT INTO collection (card_id, qty, updated_at) VALUES ('c1', 2, '2020-05-05T05:05:05.000Z')").run();
    db.prepare("INSERT INTO decks (name, sync_id, updated_at) VALUES ('Remote', 'abc', '2020-06-06T06:06:06.000Z')").run();
    expect(one(db, 'SELECT updated_at FROM collection').updated_at).toBe('2020-05-05T05:05:05.000Z');
    expect(one(db, 'SELECT updated_at FROM decks').updated_at).toBe('2020-06-06T06:06:06.000Z');
    db.exec("DELETE FROM collection");
    expect(tombs(db)).toEqual([]);
    db.exec("DELETE FROM meta WHERE key = 'sync_applying'");
    db.exec("INSERT INTO collection (card_id, qty) VALUES ('c9', 1); DELETE FROM collection");
    expect(tombs(db)).toEqual(['collection:c9']); // and back to normal afterwards
  });

  it('gives a deck added while applying an id even if the remote one lacked it', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO meta (key, value) VALUES ('sync_applying', '1')").run();
    db.prepare("INSERT INTO decks (name) VALUES ('No id')").run();
    expect(one(db, 'SELECT sync_id FROM decks').sync_id).toMatch(/^[0-9a-f]{32}$/);
  });
});
