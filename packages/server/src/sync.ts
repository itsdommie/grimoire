import { asFormat, BOARDS } from '@grimoire/shared';
import { trimPrints } from './collection.js';
import { isFinish } from './printings.js';
import { transaction, type Db } from './schema.js';

// Syncing a person's decks, collection and wishlist between devices.
//
// Every piece of user data is an *item* with a key and the time it last changed, and a deletion is an item with no value (a tombstone).
// Two devices' items are merged by keeping, for each key, whichever change is newest. That is safe to repeat and gives the same result
// whichever device merges first, so devices that sync through a shared file always end up agreeing. The cost of keeping it that simple:
// when two devices change the *same* item between syncs, the later change wins (add Sol Ring on your phone and on your PC and you
// get the later total, not both). Different items never clash: a card added to a deck on one device and another removed on the other
// both survive.

export type SyncKind = 'collection' | 'print' | 'wish' | 'deck' | 'deckcard';
const KINDS: readonly SyncKind[] = ['deck', 'deckcard', 'collection', 'print', 'wish']; // the order they are applied in: decks before their cards
export interface SyncItem {
  kind: SyncKind;
  /** collection/wish: oracle id. print: `printingId|finish`. deck: the deck's sync id. deckcard: `deckSyncId|oracleId|board`. */
  key: string;
  /** When it last changed, ISO with milliseconds. */
  at: string;
  /** null: it was deleted at `at`. */
  value: Record<string, unknown> | null;
}
export interface SyncSnapshot { app: 'brewhall-sync'; version: 1; writtenAt: string; device: string; items: SyncItem[] }

const MAX_QTY = 9999;
const MAX_ITEMS = 500_000;
/** A device whose clock is wrong must not be able to win every merge from then on: stamps further ahead than this are pulled back. */
const FUTURE_SLACK_MS = 5 * 60_000;
/** How long a deletion is remembered. A device that was offline for longer than this may bring a deleted item back. */
export const TOMBSTONE_DAYS = 90;

const iso = (s: string) => (s.includes('T') ? s : `${s.replace(' ', 'T')}.000Z`);

// ------------------------------------------------------------------------------------------------------------- reading the database

export function exportItems(db: Db): SyncItem[] {
  const items: SyncItem[] = [];
  const all = <T>(sql: string) => db.prepare(sql).all() as unknown as T[];
  for (const r of all<{ sync_id: string; name: string; format: string; created_at: string; updated_at: string }>('SELECT sync_id, name, format, created_at, updated_at FROM decks WHERE sync_id IS NOT NULL')) {
    items.push({ kind: 'deck', key: r.sync_id, at: iso(r.updated_at), value: { name: r.name, format: r.format, created: iso(r.created_at) } });
  }
  for (const r of all<{ sid: string; card_id: string; board: string; qty: number; updated_at: string }>('SELECT d.sync_id AS sid, dc.card_id, dc.board, dc.qty, dc.updated_at FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id WHERE d.sync_id IS NOT NULL')) {
    items.push({ kind: 'deckcard', key: `${r.sid}|${r.card_id}|${r.board}`, at: iso(r.updated_at), value: { qty: r.qty } });
  }
  for (const r of all<{ card_id: string; qty: number; updated_at: string }>('SELECT card_id, qty, updated_at FROM collection')) items.push({ kind: 'collection', key: r.card_id, at: iso(r.updated_at), value: { qty: r.qty } });
  for (const r of all<{ card_id: string; printing_id: string; finish: string; qty: number; updated_at: string }>('SELECT card_id, printing_id, finish, qty, updated_at FROM collection_prints')) {
    items.push({ kind: 'print', key: `${r.printing_id}|${r.finish}`, at: iso(r.updated_at), value: { card: r.card_id, qty: r.qty } });
  }
  for (const r of all<{ card_id: string; want: number; updated_at: string }>('SELECT card_id, want, updated_at FROM wishlist')) items.push({ kind: 'wish', key: r.card_id, at: iso(r.updated_at), value: { want: r.want } });
  for (const r of all<{ kind: SyncKind; key: string; deleted_at: string }>('SELECT kind, key, deleted_at FROM sync_tombstones')) items.push({ kind: r.kind, key: r.key, at: iso(r.deleted_at), value: null });
  return items;
}

export function exportSnapshot(db: Db, device: string, now = new Date()): SyncSnapshot {
  return { app: 'brewhall-sync', version: 1, writtenAt: now.toISOString(), device, items: exportItems(db) };
}

// ------------------------------------------------------------------------------------------------------------------------- merging

const idOf = (i: SyncItem) => `${i.kind}\u0000${i.key}`;
const sameValue = (a: SyncItem['value'], b: SyncItem['value']) => JSON.stringify(a) === JSON.stringify(b);

/** Whether `a` beats `b` as the current state of one item: the newer change; on a tie, the item over its deletion (keep data); else a fixed order. */
function beats(a: SyncItem, b: SyncItem): boolean {
  if (a.at !== b.at) return a.at > b.at;
  if ((a.value === null) !== (b.value === null)) return a.value !== null;
  return JSON.stringify(a.value) >= JSON.stringify(b.value);
}

/** The newest change of every item across both lists. Order doesn't matter and merging the result again changes nothing. */
export function mergeItems(a: readonly SyncItem[], b: readonly SyncItem[]): SyncItem[] {
  const out = new Map<string, SyncItem>();
  for (const item of [...a, ...b]) {
    const cur = out.get(idOf(item));
    if (!cur || beats(item, cur)) out.set(idOf(item), item);
  }
  return [...out.values()];
}

// -------------------------------------------------------------------------------------------------------------- reading a remote file

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_QTY;
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function cleanItem(raw: unknown, ceiling: string): SyncItem | null {
  if (!isObj(raw) || !KINDS.includes(raw.kind as SyncKind) || !str(raw.key, 200) || typeof raw.at !== 'string' || !ISO.test(raw.at)) return null;
  const kind = raw.kind as SyncKind;
  const at = raw.at > ceiling ? ceiling : raw.at;
  const key = raw.key as string;
  if (raw.value === null) return { kind, key, at, value: null };
  const v = raw.value;
  if (!isObj(v)) return null;
  switch (kind) {
    case 'collection': return posInt(v.qty) ? { kind, key, at, value: { qty: v.qty } } : null;
    case 'wish': return posInt(v.want) ? { kind, key, at, value: { want: v.want } } : null;
    case 'print': {
      const [pid, finish, ...rest] = key.split('|');
      return pid && isFinish(finish) && rest.length === 0 && str(v.card) && posInt(v.qty) ? { kind, key, at, value: { card: v.card, qty: v.qty } } : null;
    }
    case 'deck': return /^[0-9a-f]{32}$/.test(key) && str(v.name) ? { kind, key, at, value: { name: v.name, format: asFormat(v.format), created: typeof v.created === 'string' && ISO.test(v.created) ? v.created : at } } : null;
    case 'deckcard': {
      const [sid, card, board, ...rest] = key.split('|');
      return sid && /^[0-9a-f]{32}$/.test(sid) && card && (BOARDS as readonly string[]).includes(board ?? '') && rest.length === 0 && posInt(v.qty) ? { kind, key, at, value: { qty: v.qty } } : null;
    }
  }
}

export class SyncFormatError extends Error {}

/** Read a sync file someone (or some other device) wrote. Bad items are dropped, not trusted; a file from the future is refused. */
export function parseSnapshot(text: string, now = new Date()): { snapshot: SyncSnapshot; dropped: number } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SyncFormatError("The sync file isn't readable (it is not valid JSON)."); }
  if (!isObj(raw) || raw.app !== 'brewhall-sync') throw new SyncFormatError("That file isn't a Brewhall sync file.");
  if (raw.version !== 1) throw new SyncFormatError(`That sync file is from a newer Brewhall (format ${String(raw.version)}). Update this app, then sync again.`);
  if (!Array.isArray(raw.items)) throw new SyncFormatError('The sync file is missing its items.');
  if (raw.items.length > MAX_ITEMS) throw new SyncFormatError('The sync file is too large to be a Brewhall sync file.');
  const ceiling = new Date(now.getTime() + FUTURE_SLACK_MS).toISOString();
  const items: SyncItem[] = [];
  for (const r of raw.items) { const i = cleanItem(r, ceiling); if (i) items.push(i); }
  return { snapshot: { app: 'brewhall-sync', version: 1, writtenAt: typeof raw.writtenAt === 'string' ? raw.writtenAt : '', device: typeof raw.device === 'string' ? raw.device.slice(0, 64) : '', items }, dropped: raw.items.length - items.length };
}

// ----------------------------------------------------------------------------------------------------------------- applying to the database

/**
 * Make the database match `merged` (the result of merging this device's items with the other side's), keeping each item's own timestamp.
 * Returns how many items changed here. Cards of a deck that is deleted, or that this device has never heard of, are left out.
 */
export function applyItems(db: Db, merged: readonly SyncItem[]): number {
  const local = new Map(exportItems(db).map((i) => [idOf(i), i]));
  const todo = merged.filter((m) => { const l = local.get(idOf(m)); return !l || l.at !== m.at || !sameValue(l.value, m.value); });
  if (todo.length === 0) return 0;
  let changed = 0;
  transaction(db, () => {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_applying', '1')").run(); // the triggers stand down (and this is undone with the transaction if anything fails)
    const st = {
      setTomb: db.prepare('INSERT OR REPLACE INTO sync_tombstones (kind, key, deleted_at) VALUES (?, ?, ?)'),
      clearTomb: db.prepare('DELETE FROM sync_tombstones WHERE kind = ? AND key = ?'),
      deckId: db.prepare('SELECT id FROM decks WHERE sync_id = ?'),
      deckUpdate: db.prepare('UPDATE decks SET name = ?, format = ?, updated_at = ? WHERE id = ?'),
      deckInsert: db.prepare('INSERT INTO decks (name, format, created_at, updated_at, sync_id) VALUES (?, ?, ?, ?, ?)'),
      deckCardsDelete: db.prepare('DELETE FROM deck_cards WHERE deck_id = ?'),
      deckDelete: db.prepare('DELETE FROM decks WHERE id = ?'),
      deckCardPut: db.prepare('INSERT INTO deck_cards (deck_id, card_id, board, qty, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (deck_id, card_id, board) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at'),
      deckCardDelete: db.prepare('DELETE FROM deck_cards WHERE deck_id = ? AND card_id = ? AND board = ?'),
      collectionPut: db.prepare('INSERT INTO collection (card_id, qty, updated_at) VALUES (?, ?, ?) ON CONFLICT (card_id) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at'),
      collectionDelete: db.prepare('DELETE FROM collection WHERE card_id = ?'),
      wishPut: db.prepare('INSERT INTO wishlist (card_id, want, updated_at) VALUES (?, ?, ?) ON CONFLICT (card_id) DO UPDATE SET want = excluded.want, updated_at = excluded.updated_at'),
      wishDelete: db.prepare('DELETE FROM wishlist WHERE card_id = ?'),
      printPut: db.prepare('INSERT INTO collection_prints (card_id, printing_id, finish, qty, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (printing_id, finish) DO UPDATE SET card_id = excluded.card_id, qty = excluded.qty, updated_at = excluded.updated_at'),
      printDelete: db.prepare('DELETE FROM collection_prints WHERE printing_id = ? AND finish = ?'),
    };
    const deckId = (sid: string) => (st.deckId.get(sid) as { id: number } | undefined)?.id;
    for (const kind of KINDS) {
      for (const m of todo) {
        if (m.kind !== kind) continue;
        const v = m.value;
        if (kind === 'deck') {
          const id = deckId(m.key);
          if (v) {
            if (id !== undefined) st.deckUpdate.run(v.name as string, v.format as string, m.at, id);
            else st.deckInsert.run(v.name as string, v.format as string, v.created as string, m.at, m.key);
            st.clearTomb.run('deck', m.key);
          } else {
            if (id !== undefined) { st.deckCardsDelete.run(id); st.deckDelete.run(id); }
            st.setTomb.run('deck', m.key, m.at);
          }
        } else if (kind === 'deckcard') {
          const [sid, card, board] = m.key.split('|') as [string, string, string];
          const id = deckId(sid);
          if (id === undefined) continue; // its deck is gone, or is one this device has not been told about
          if (v) { st.deckCardPut.run(id, card, board, v.qty as number, m.at); st.clearTomb.run('deckcard', m.key); }
          else { st.deckCardDelete.run(id, card, board); st.setTomb.run('deckcard', m.key, m.at); }
        } else if (kind === 'collection') {
          if (v) { st.collectionPut.run(m.key, v.qty as number, m.at); st.clearTomb.run('collection', m.key); }
          else { st.collectionDelete.run(m.key); st.setTomb.run('collection', m.key, m.at); }
        } else if (kind === 'wish') {
          if (v) { st.wishPut.run(m.key, v.want as number, m.at); st.clearTomb.run('wish', m.key); }
          else { st.wishDelete.run(m.key); st.setTomb.run('wish', m.key, m.at); }
        } else {
          const [pid, finish] = m.key.split('|') as [string, string];
          if (v) { st.printPut.run(v.card as string, pid, finish, v.qty as number, m.at); st.clearTomb.run('print', m.key); }
          else { st.printDelete.run(pid, finish); st.setTomb.run('print', m.key, m.at); }
        }
        changed++;
      }
    }
    db.prepare("DELETE FROM meta WHERE key = 'sync_applying'").run();
    reconcilePrints(db);
  });
  return changed;
}

/**
 * Copies with a known printing can't outnumber the card's total. Each side kept that true on its own, but merging a card's total from one
 * device with its printings from the other can break it, so trim the oldest printing records (as lowering a total does). This is an
 * ordinary local change: it is stamped now, so it reaches the other devices at their next sync.
 */
function reconcilePrints(db: Db): void {
  const rows = db.prepare(`SELECT cp.card_id AS card_id, COALESCE(c.qty, 0) AS owned FROM collection_prints cp LEFT JOIN collection c ON c.card_id = cp.card_id
    GROUP BY cp.card_id HAVING SUM(cp.qty) > COALESCE(c.qty, 0)`).all() as unknown as Array<{ card_id: string; owned: number }>;
  for (const r of rows) trimPrints(db, r.card_id, r.owned);
}

/** Forget deletions older than `TOMBSTONE_DAYS` (everything they could still tell another device has long since been synced). */
export function pruneTombstones(db: Db, now = new Date()): number {
  const cutoff = new Date(now.getTime() - TOMBSTONE_DAYS * 864e5).toISOString();
  return Number(db.prepare('DELETE FROM sync_tombstones WHERE deleted_at < ?').run(cutoff).changes);
}

// --------------------------------------------------------------------------------------------------------------------------- one sync

/** Where the shared file lives. A store only has to read and write one text file, and notice if someone else wrote it in between. */
export interface SyncStore {
  /** The file's text and a version that changes whenever it is rewritten; null if it has not been written yet. */
  read(): Promise<{ text: string; version: string } | null>;
  /** Replace the file, but only if it is still at `expect` (null: still absent). Throws SyncConflict if not. Returns the new version. */
  write(text: string, expect: string | null): Promise<string>;
}
/** Someone else wrote the file after we read it. */
export class SyncConflict extends Error {}

export interface SyncResult {
  /** Items that changed on this device. */
  pulled: number;
  /** Whether the shared file was updated. */
  pushed: boolean;
  /** Items in the remote file that were unusable and ignored. */
  dropped: number;
  at: string;
}

/**
 * Bring this device and the shared file into agreement: read the file, merge, apply what is new here, and write the file back if it lacked
 * anything. If another device wrote in between, merge again (a few times), which is safe because merging is repeatable.
 */
export async function runSync(db: Db, store: SyncStore, device: string, opts: { now?: () => Date } = {}): Promise<SyncResult> {
  const now = opts.now ?? (() => new Date());
  let pulled = 0, dropped = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await store.read();
    let remoteItems: SyncItem[] = [];
    if (remote) {
      const p = parseSnapshot(remote.text, now());
      const cutoff = new Date(now().getTime() - TOMBSTONE_DAYS * 864e5).toISOString();
      remoteItems = p.snapshot.items.filter((i) => i.value !== null || i.at >= cutoff); // (a deletion that old is forgotten here too, or it would be re-added every sync)
      dropped = p.dropped;
    }
    pruneTombstones(db, now());
    pulled += applyItems(db, mergeItems(exportItems(db), remoteItems));
    const out = exportSnapshot(db, device, now());
    // The file needs rewriting if this device knows anything it lacks (it never needs to hold less than the file does).
    const known = new Map(remoteItems.map((i) => [idOf(i), i]));
    const behind = !remote || out.items.some((i) => { const r = known.get(idOf(i)); return !r || r.at !== i.at || !sameValue(r.value, i.value); });
    if (!behind) return { pulled, pushed: false, dropped, at: out.writtenAt };
    try { await store.write(JSON.stringify(out), remote?.version ?? null); return { pulled, pushed: true, dropped, at: out.writtenAt }; }
    catch (e) { if (!(e instanceof SyncConflict)) throw e; }
  }
  throw new SyncConflict('Another device kept changing the shared file while this one was syncing. Try again in a moment.');
}
