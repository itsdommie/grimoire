import { describe, expect, it } from 'vitest';
import { openDb, type NodeDb as Db } from './db.js';
import { applyItems, exportItems, mergeItems, parseSnapshot, runSync, SyncConflict, SyncFormatError, type SyncItem, type SyncStore } from './sync.js';

const SID_A = 'a'.repeat(32), SID_B = 'b'.repeat(32);
const t = (n: number) => `2026-03-${String(n).padStart(2, '0')}T12:00:00.000Z`;
const item = (kind: SyncItem['kind'], key: string, at: string, value: SyncItem['value']): SyncItem => ({ kind, key, at, value });
const coll = (id: string, qty: number, at: string) => item('collection', id, at, { qty });
const gone = (kind: SyncItem['kind'], key: string, at: string) => item(kind, key, at, null);

/** A shared file in memory, standing in for Google Drive or a synced folder. */
class MemoryStore implements SyncStore {
  text: string | null = null; version = 0; conflicts = 0; writes = 0;
  async read() { return this.text === null ? null : { text: this.text, version: String(this.version) }; }
  async write(text: string, expect: string | null) {
    if (this.conflicts > 0) { this.conflicts--; throw new SyncConflict('someone else wrote'); }
    if ((expect ?? null) !== (this.text === null ? null : String(this.version))) throw new SyncConflict('stale');
    this.text = text; this.writes++; return String(++this.version);
  }
}

const device = () => openDb(':memory:');
const run = (db: Db, store: SyncStore, name = 'dev') => runSync(db, store, name);
const sql = (db: Db, q: string, ...p: Array<string | number>) => db.prepare(q).run(...p);
const rows = (db: Db, q: string) => db.prepare(q).all() as Array<Record<string, unknown>>;
/** Everything that should agree between devices, in a comparable form. */
const state = (db: Db) => exportItems(db).map((i) => `${i.kind}|${i.key}|${i.at}|${JSON.stringify(i.value)}`).sort();
const stamp = (db: Db, table: string, where: string, at: string) => { sql(db, "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_applying', '1')"); sql(db, `UPDATE ${table} SET updated_at = ? WHERE ${where}`, at); sql(db, "DELETE FROM meta WHERE key = 'sync_applying'"); };
const names = (db: Db) => rows(db, 'SELECT name FROM decks ORDER BY name').map((r) => r.name);
const deckCards = (db: Db, name: string) => rows(db, `SELECT dc.card_id AS c, dc.board AS b, dc.qty AS q FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id WHERE d.name = '${name}' ORDER BY dc.card_id`).map((r) => `${r.c}:${r.b}:${r.q}`);

describe('merging', () => {
  it('keeps the newest change of each item, and everything that only one side has', () => {
    const merged = mergeItems([coll('x', 1, t(1)), coll('only-a', 4, t(1))], [coll('x', 5, t(2)), coll('only-b', 2, t(1))]);
    expect(Object.fromEntries(merged.map((i) => [i.key, (i.value as { qty: number }).qty]))).toEqual({ x: 5, 'only-a': 4, 'only-b': 2 });
  });

  it('lets a later deletion beat an earlier edit, and a later edit beat an earlier deletion', () => {
    expect(mergeItems([coll('x', 3, t(1))], [gone('collection', 'x', t(2))])[0]!.value).toBeNull();
    expect(mergeItems([gone('collection', 'x', t(1))], [coll('x', 3, t(2))])[0]!.value).toEqual({ qty: 3 });
  });

  it('keeps the data when an edit and a deletion are stamped the same moment', () => {
    expect(mergeItems([coll('x', 3, t(1))], [gone('collection', 'x', t(1))])[0]!.value).toEqual({ qty: 3 });
    expect(mergeItems([gone('collection', 'x', t(1))], [coll('x', 3, t(1))])[0]!.value).toEqual({ qty: 3 });
  });

  it('gives the same result in either order, and merging the result again changes nothing', () => {
    const a = [coll('x', 1, t(1)), coll('y', 2, t(3)), gone('wish', 'z', t(2)), coll('same', 1, t(5))];
    const b = [coll('x', 9, t(2)), gone('collection', 'y', t(2)), item('wish', 'z', t(2), { want: 2 }), coll('same', 2, t(5))];
    const ab = mergeItems(a, b), ba = mergeItems(b, a);
    const key = (l: SyncItem[]) => JSON.stringify([...l].sort((p, q) => (p.kind + p.key).localeCompare(q.kind + q.key)));
    expect(key(ab)).toBe(key(ba));
    expect(key(mergeItems(ab, a))).toBe(key(ab));
    expect(key(mergeItems(ab, ab))).toBe(key(ab));
    expect(key(mergeItems(mergeItems(a, b), mergeItems(b, a)))).toBe(key(ab));
  });
});

describe('reading a file from another device', () => {
  const file = (items: unknown[], extra: object = {}) => JSON.stringify({ app: 'brewhall-sync', version: 1, writtenAt: t(1), device: 'd', items, ...extra });
  const NOW = new Date('2026-03-10T00:00:00.000Z');

  it('refuses things that are not sync files, and files from a newer Brewhall, with a message a person can act on', () => {
    expect(() => parseSnapshot('not json')).toThrow(SyncFormatError);
    expect(() => parseSnapshot('{"app":"other"}')).toThrow(/isn't a Brewhall sync file/);
    expect(() => parseSnapshot(file([], { version: 2 }))).toThrow(/newer Brewhall/);
    expect(() => parseSnapshot('{"app":"brewhall-sync","version":1}')).toThrow(/missing its items/);
  });

  it('drops items that are malformed instead of trusting them, and says how many', () => {
    const good = [coll('c1', 2, t(1)), item('print', 'p1|foil', t(1), { card: 'c1', qty: 1 }), item('deck', SID_A, t(1), { name: 'Deck', format: 'modern', created: t(1) }), item('deckcard', `${SID_A}|c1|main`, t(1), { qty: 1 }), gone('wish', 'c9', t(1))];
    const bad = [
      coll('c1', -1, t(1)), coll('c1', 1.5, t(1)), coll('c1', 100000, t(1)), coll('', 1, t(1)), coll('c1', 1, 'yesterday'),
      item('print', 'p1|shiny', t(1), { card: 'c1', qty: 1 }), item('print', 'p1', t(1), { card: 'c1', qty: 1 }),
      item('deck', 'not-hex', t(1), { name: 'x' }), item('deck', SID_A, t(1), { name: '' }),
      item('deckcard', `${SID_A}|c1|nowhere`, t(1), { qty: 1 }), item('deckcard', 'short', t(1), { qty: 1 }),
      { kind: 'mystery', key: 'k', at: t(1), value: null }, 'a string', null, { kind: 'collection', at: t(1), value: { qty: 1 } },
    ];
    const r = parseSnapshot(file([...good, ...bad]), NOW);
    expect(r.snapshot.items).toHaveLength(good.length);
    expect(r.dropped).toBe(bad.length);
  });

  it('turns an unknown format into Commander rather than refusing the deck', () => {
    const r = parseSnapshot(file([item('deck', SID_A, t(1), { name: 'D', format: 'who-knows', created: t(1) })]), NOW);
    expect(r.snapshot.items[0]!.value).toMatchObject({ format: 'commander' });
  });

  it('pulls back stamps from the future, so a device with a wrong clock cannot win every merge from then on', () => {
    const r = parseSnapshot(file([coll('c1', 1, '2099-01-01T00:00:00.000Z')]), NOW);
    expect(r.snapshot.items[0]!.at <= '2026-03-10T00:05:00.000Z').toBe(true);
    expect(r.snapshot.items[0]!.at > '2026-03-10T00:00:00.000Z').toBe(true);
  });
});

describe('applying changes from another device', () => {
  it('creates a deck with its cards, keeping the stamps they arrived with and the deck\'s own id', () => {
    const db = device();
    const n = applyItems(db, [
      item('deck', SID_A, t(3), { name: 'Remote deck', format: 'modern', created: t(1) }),
      item('deckcard', `${SID_A}|c1|main`, t(4), { qty: 3 }),
      item('deckcard', `${SID_A}|c2|sideboard`, t(5), { qty: 1 }),
    ]);
    expect(n).toBe(3);
    expect(rows(db, 'SELECT name, format, sync_id, created_at, updated_at FROM decks')).toEqual([{ name: 'Remote deck', format: 'modern', sync_id: SID_A, created_at: t(1), updated_at: t(3) }]);
    expect(rows(db, 'SELECT card_id, qty, updated_at FROM deck_cards ORDER BY card_id')).toEqual([{ card_id: 'c1', qty: 3, updated_at: t(4) }, { card_id: 'c2', qty: 1, updated_at: t(5) }]);
    expect(rows(db, 'SELECT * FROM sync_tombstones')).toEqual([]);
    expect(rows(db, "SELECT * FROM meta WHERE key = 'sync_applying'")).toEqual([]); // the triggers are back on
  });

  it('is a no-op when there is nothing new, and says so', () => {
    const db = device();
    const items = [coll('c1', 2, t(1)), item('wish', 'c2', t(1), { want: 1 })];
    expect(applyItems(db, items)).toBe(2);
    expect(applyItems(db, items)).toBe(0);
    expect(applyItems(db, mergeItems(exportItems(db), items))).toBe(0);
  });

  it('deletes what the other device deleted, and remembers it so it is not brought back', () => {
    const db = device();
    applyItems(db, [coll('c1', 2, t(1)), item('deck', SID_A, t(1), { name: 'D', format: 'commander', created: t(1) }), item('deckcard', `${SID_A}|c1|main`, t(1), { qty: 1 })]);
    applyItems(db, [gone('collection', 'c1', t(2)), gone('deck', SID_A, t(2))]);
    expect(rows(db, 'SELECT * FROM collection')).toEqual([]);
    expect(rows(db, 'SELECT * FROM decks')).toEqual([]);
    expect(rows(db, 'SELECT * FROM deck_cards')).toEqual([]);
    expect(rows(db, 'SELECT kind, key, deleted_at FROM sync_tombstones ORDER BY kind')).toEqual([{ kind: 'collection', key: 'c1', deleted_at: t(2) }, { kind: 'deck', key: SID_A, deleted_at: t(2) }]);
  });

  it('leaves out cards of a deck that is deleted or that this device was never told about', () => {
    const db = device();
    expect(applyItems(db, [item('deckcard', `${SID_A}|c1|main`, t(1), { qty: 1 })])).toBe(0);
    expect(rows(db, 'SELECT * FROM deck_cards')).toEqual([]);
  });

  it('trims printings that would outnumber the card\'s total after merging, and that trim syncs on', () => {
    const db = device();
    applyItems(db, [coll('c1', 3, t(1)), item('print', 'p1|foil', t(1), { card: 'c1', qty: 2 }), item('print', 'p2|nonfoil', t(2), { card: 'c1', qty: 1 })]);
    // the other device lowered the total to 1 (and never knew of these printings): 3 recorded copies cannot stand
    applyItems(db, [coll('c1', 1, t(5))]);
    const left = rows(db, 'SELECT printing_id, finish, qty FROM collection_prints');
    expect(left.reduce((n, r) => n + (r.qty as number), 0)).toBe(1);
    expect(left).toEqual([{ printing_id: 'p2', finish: 'nonfoil', qty: 1 }]); // the oldest record gave way first
    expect(rows(db, 'SELECT key FROM sync_tombstones').map((r) => r.key)).toEqual(['p1|foil']); // and the removal is a local change that will travel
  });
});

describe('syncing two devices through one shared file', () => {
  const seed = (db: Db) => {
    sql(db, "INSERT INTO collection (card_id, qty) VALUES ('c1', 2), ('c2', 1)");
    sql(db, "INSERT INTO wishlist (card_id, want) VALUES ('w1', 3)");
    sql(db, "INSERT INTO decks (name, format) VALUES ('Elves', 'commander')");
    sql(db, "INSERT INTO deck_cards (deck_id, card_id, board, qty) VALUES (1, 'c1', 'commander', 1), (1, 'c2', 'main', 1)");
    // Long ago, so that anything the test does next is strictly newer (two changes in the same millisecond would tie).
    sql(db, "INSERT INTO meta (key, value) VALUES ('sync_applying', '1')");
    for (const table of ['collection', 'wishlist', 'decks', 'deck_cards', 'collection_prints']) sql(db, `UPDATE ${table} SET updated_at = ?`, t(1));
    sql(db, "DELETE FROM meta WHERE key = 'sync_applying'");
  };

  it('carries everything to a second device, decks and all', async () => {
    const store = new MemoryStore(), a = device(), b = device();
    seed(a);
    expect(await run(a, store, 'A')).toMatchObject({ pushed: true, pulled: 0 });
    const r = await run(b, store, 'B');
    expect(r).toMatchObject({ pushed: false, dropped: 0 });
    expect(r.pulled).toBeGreaterThan(0);
    expect(state(b)).toEqual(state(a));
    expect(names(b)).toEqual(['Elves']);
    expect(deckCards(b, 'Elves')).toEqual(['c1:commander:1', 'c2:main:1']);
    expect(rows(b, 'SELECT qty FROM collection WHERE card_id = \'c1\'')).toEqual([{ qty: 2 }]);
  });

  it('syncing again with nothing new changes nothing and writes nothing', async () => {
    const store = new MemoryStore(), a = device();
    seed(a);
    await run(a, store);
    const writes = store.writes;
    expect(await run(a, store)).toMatchObject({ pulled: 0, pushed: false });
    expect(store.writes).toBe(writes);
  });

  it('merges changes made on both devices between syncs, and they end up agreeing', async () => {
    const store = new MemoryStore(), a = device(), b = device();
    seed(a);
    await run(a, store, 'A'); await run(b, store, 'B');
    // meanwhile, on A: more copies of c1, a card taken out of the deck, a new deck. On B: a card added to the same deck, the wishlist emptied.
    sql(a, "UPDATE collection SET qty = 5 WHERE card_id = 'c1'"); stamp(a, 'collection', "card_id = 'c1'", t(20));
    sql(a, "DELETE FROM deck_cards WHERE card_id = 'c2'");
    sql(a, "INSERT INTO decks (name, format) VALUES ('New on A', 'modern')");
    sql(b, "INSERT INTO deck_cards (deck_id, card_id, board, qty) VALUES (1, 'c3', 'main', 4)");
    sql(b, 'DELETE FROM wishlist');
    await run(a, store, 'A'); await run(b, store, 'B'); await run(a, store, 'A');
    expect(state(b)).toEqual(state(a));
    expect(names(a)).toEqual(['Elves', 'New on A']);
    expect(deckCards(a, 'Elves')).toEqual(['c1:commander:1', 'c3:main:4']); // c2 gone (A), c3 added (B): both changes kept
    expect(rows(a, 'SELECT qty FROM collection WHERE card_id = \'c1\'')).toEqual([{ qty: 5 }]);
    expect(rows(a, 'SELECT * FROM wishlist')).toEqual([]);
  });

  it('carries a deck deletion to the other device', async () => {
    const store = new MemoryStore(), a = device(), b = device();
    seed(a);
    await run(a, store); await run(b, store);
    sql(a, 'DELETE FROM decks WHERE id = 1');
    await run(a, store); await run(b, store);
    expect(names(b)).toEqual([]);
    expect(rows(b, 'SELECT * FROM deck_cards')).toEqual([]);
    expect(state(b)).toEqual(state(a));
  });

  it('when the same item is changed on both devices, the later change wins on both', async () => {
    const store = new MemoryStore(), a = device(), b = device();
    seed(a);
    await run(a, store); await run(b, store);
    sql(a, "UPDATE collection SET qty = 7 WHERE card_id = 'c1'"); stamp(a, 'collection', "card_id = 'c1'", t(21));
    sql(b, "UPDATE collection SET qty = 9 WHERE card_id = 'c1'"); stamp(b, 'collection', "card_id = 'c1'", t(22));
    await run(a, store); await run(b, store); await run(a, store);
    expect(rows(a, "SELECT qty FROM collection WHERE card_id = 'c1'")).toEqual([{ qty: 9 }]);
    expect(rows(b, "SELECT qty FROM collection WHERE card_id = 'c1'")).toEqual([{ qty: 9 }]);
  });

  it('renames and format changes travel too', async () => {
    const store = new MemoryStore(), a = device(), b = device();
    seed(a);
    await run(a, store); await run(b, store);
    sql(b, "UPDATE decks SET name = 'Renamed', format = 'modern' WHERE id = 1");
    await run(b, store); await run(a, store);
    expect(rows(a, 'SELECT name, format FROM decks')).toEqual([{ name: 'Renamed', format: 'modern' }]);
  });

  it('three devices converge however they take turns', async () => {
    const store = new MemoryStore(), d = [device(), device(), device()];
    seed(d[0]!);
    await run(d[0]!, store); await run(d[1]!, store); await run(d[2]!, store);
    sql(d[0]!, "UPDATE collection SET qty = 3 WHERE card_id = 'c2'"); stamp(d[0]!, 'collection', "card_id = 'c2'", t(23));
    sql(d[1]!, "INSERT INTO wishlist (card_id, want) VALUES ('w2', 1)");
    sql(d[2]!, "DELETE FROM collection WHERE card_id = 'c1'");
    for (const i of [2, 0, 1, 2, 1, 0, 2]) await run(d[i]!, store, `d${i}`);
    expect(state(d[1]!)).toEqual(state(d[0]!));
    expect(state(d[2]!)).toEqual(state(d[0]!));
    expect(rows(d[0]!, 'SELECT card_id FROM collection ORDER BY card_id')).toEqual([{ card_id: 'c2' }]);
  });

  it('merges again when another device writes the file in between, a few times over, then gives up with a clear error', async () => {
    const store = new MemoryStore(), a = device();
    seed(a);
    store.conflicts = 2;
    expect(await run(a, store)).toMatchObject({ pushed: true });
    const b = device(); seed(b);
    store.conflicts = 10;
    await expect(run(b, store)).rejects.toThrow(/Try again/);
  });

  it('does not resurrect a deletion after it has been synced, even by a device that still has the item', async () => {
    const store = new MemoryStore(), a = device(), b = device();
    seed(a);
    await run(a, store); await run(b, store);
    sql(a, "DELETE FROM collection WHERE card_id = 'c2'");
    await run(a, store);
    await run(b, store); // b still has c2 until now: the deletion is newer than b's copy, so it goes
    expect(rows(b, "SELECT * FROM collection WHERE card_id = 'c2'")).toEqual([]);
    await run(a, store);
    expect(rows(a, "SELECT * FROM collection WHERE card_id = 'c2'")).toEqual([]);
  });

  it('gives a clear error for a file that is not a sync file, and changes nothing', async () => {
    const store = new MemoryStore(), a = device();
    seed(a); store.text = '{"hello":"world"}';
    const before = state(a);
    await expect(run(a, store)).rejects.toThrow(SyncFormatError);
    expect(state(a)).toEqual(before);
    expect(store.text).toBe('{"hello":"world"}'); // and the file is left alone
  });

  it('handles a big collection quickly', async () => {
    const store = new MemoryStore(), a = device(), b = device();
    a.exec('BEGIN');
    const ins = a.prepare('INSERT INTO collection (card_id, qty) VALUES (?, 1)');
    for (let i = 0; i < 8000; i++) ins.run(`card-${i}`);
    a.exec('COMMIT');
    const t0 = performance.now();
    await run(a, store); await run(b, store);
    expect(rows(b, 'SELECT count(*) AS n FROM collection')).toEqual([{ n: 8000 }]);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
