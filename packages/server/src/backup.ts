import type { RestoreResult, UserDataBackup } from '@grimoire/shared';
import { BOARDS, asFormat, type Board } from '@grimoire/shared';
import { getCardsByIds, resolveCardName } from './cards.js';
import { transaction, type Db } from './schema.js';
import { isFinish } from './printings.js';
import { BadRequestError } from './decks.js';

export function exportUserData(db: Db): UserDataBackup {
  const names = new Map<string, string>();
  const nameOf = (id: string) => {
    if (!names.has(id)) names.set(id, getCardsByIds(db, [id]).get(id)?.name ?? '');
    return names.get(id)!;
  };
  const decks = (db.prepare('SELECT id, name, format FROM decks ORDER BY id').all() as unknown as Array<{ id: number; name: string; format: string }>).map((d) => ({
    name: d.name,
    format: d.format,
    cards: (db.prepare('SELECT card_id, board, qty FROM deck_cards WHERE deck_id = ? ORDER BY board, card_id').all(d.id) as unknown as Array<{ card_id: string; board: Board; qty: number }>)
      .map((c) => ({ id: c.card_id, name: nameOf(c.card_id), board: c.board, qty: c.qty })),
  }));
  const prints = new Map<string, Array<{ id: string; set: string; collector: string; finish: 'nonfoil' | 'foil' | 'etched'; qty: number }>>();
  for (const p of db.prepare(`SELECT cp.card_id, cp.printing_id, cp.finish, cp.qty, COALESCE(p.set_code, '') AS set_code, COALESCE(p.collector, '') AS collector
      FROM collection_prints cp LEFT JOIN printings p ON p.id = cp.printing_id ORDER BY cp.card_id, cp.printing_id, cp.finish`).all() as unknown as Array<{ card_id: string; printing_id: string; finish: 'nonfoil' | 'foil' | 'etched'; qty: number; set_code: string; collector: string }>) {
    prints.set(p.card_id, [...(prints.get(p.card_id) ?? []), { id: p.printing_id, set: p.set_code, collector: p.collector, finish: p.finish, qty: p.qty }]);
  }
  const collection = (db.prepare('SELECT card_id, qty FROM collection ORDER BY card_id').all() as unknown as Array<{ card_id: string; qty: number }>)
    .map((c) => ({ id: c.card_id, name: nameOf(c.card_id), qty: c.qty, ...(prints.has(c.card_id) ? { prints: prints.get(c.card_id)! } : {}) }));
  const wishlist = (db.prepare('SELECT card_id, want FROM wishlist ORDER BY card_id').all() as unknown as Array<{ card_id: string; want: number }>)
    .map((w) => ({ id: w.card_id, name: nameOf(w.card_id), want: w.want }));
  return { app: 'brewhall', version: 1, exportedAt: new Date().toISOString(), decks, collection, ...(wishlist.length > 0 ? { wishlist } : {}) };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 9999;

/** Check the shape of an uploaded backup, with errors a person can act on. */
export function parseBackup(raw: unknown): UserDataBackup {
  if (!isObj(raw) || (raw.app !== 'brewhall' && raw.app !== 'grimoire')) throw new BadRequestError("This doesn't look like a Brewhall backup file.");
  if (raw.version !== 1) throw new BadRequestError(`This backup is version ${String(raw.version)}, which this version of Brewhall can't read.`);
  if (!Array.isArray(raw.decks) || !Array.isArray(raw.collection)) throw new BadRequestError('The backup is missing its decks or collection.');
  for (const d of raw.decks) {
    if (!isObj(d) || typeof d.name !== 'string' || !Array.isArray(d.cards)) throw new BadRequestError('A deck in the backup is malformed.');
    for (const c of d.cards) if (!isObj(c) || typeof c.id !== 'string' || !BOARDS.includes(c.board as Board) || !posInt(c.qty)) throw new BadRequestError(`A card in the deck "${d.name}" is malformed.`);
  }
  for (const c of raw.collection) {
    if (!isObj(c) || typeof c.id !== 'string' || !posInt(c.qty)) throw new BadRequestError('A collection entry in the backup is malformed.');
    if (c.prints !== undefined && (!Array.isArray(c.prints) || c.prints.some((p) => !isObj(p) || typeof p.id !== 'string' || !isFinish(p.finish) || !posInt(p.qty)))) throw new BadRequestError('A printing in the backup is malformed.');
  }
  if (raw.wishlist !== undefined && (!Array.isArray(raw.wishlist) || raw.wishlist.some((w) => !isObj(w) || typeof w.id !== 'string' || !posInt(w.want)))) throw new BadRequestError('A wishlist entry in the backup is malformed.');
  return raw as unknown as UserDataBackup;
}

/**
 * Restore a backup. `merge` adds the backup's decks as new decks and adds its collection to yours; `replace` wipes both first.
 * Cards are matched by oracle id, then by name (in case Scryfall ever changes an id).
 */
export function restoreUserData(db: Db, raw: unknown, mode: 'merge' | 'replace'): RestoreResult {
  const backup = parseBackup(raw);
  const unresolved = new Set<string>();
  const resolve = (id: string, name: string): string | null => {
    if (getCardsByIds(db, [id]).has(id)) return id;
    const byName = name ? resolveCardName(db, name) : null;
    if (byName) return byName.id;
    unresolved.add(name || id);
    return null;
  };

  const result: RestoreResult = { decks: 0, deckCards: 0, collectionCards: 0, collectionCopies: 0, wishlist: 0, unresolved: [] };
  transaction(db, () => {
    if (mode === 'replace') { db.exec('DELETE FROM deck_cards; DELETE FROM decks; DELETE FROM collection; DELETE FROM collection_prints; DELETE FROM wishlist;'); }
    const insertDeck = db.prepare('INSERT INTO decks (name, format) VALUES (?, ?)');
    const insertCard = db.prepare('INSERT INTO deck_cards (deck_id, card_id, board, qty) VALUES (?, ?, ?, ?) ON CONFLICT (deck_id, card_id, board) DO UPDATE SET qty = qty + excluded.qty');
    for (const d of backup.decks) {
      const deckId = Number(insertDeck.run(d.name.trim() || 'Restored deck', asFormat(d.format)).lastInsertRowid);
      result.decks++;
      for (const c of d.cards) {
        const id = resolve(c.id, c.name);
        if (!id) continue;
        insertCard.run(deckId, id, c.board, c.qty);
        result.deckCards += c.qty;
      }
    }
    const addPrint = db.prepare(`INSERT INTO collection_prints (card_id, printing_id, finish, qty) VALUES (?, ?, ?, ?)
      ON CONFLICT (printing_id, finish) DO UPDATE SET qty = MIN(?, collection_prints.qty + excluded.qty), updated_at = datetime('now')`);
    const upsert = db.prepare('INSERT INTO collection (card_id, qty) VALUES (?, ?) ON CONFLICT (card_id) DO UPDATE SET qty = MIN(9999, collection.qty + excluded.qty), updated_at = datetime(\'now\')');
    for (const c of backup.collection) {
      const id = resolve(c.id, c.name);
      if (!id) continue;
      upsert.run(id, c.qty);
      result.collectionCards++;
      result.collectionCopies += c.qty;
      // Which printings those copies were (by Scryfall id: it names the printing whether or not the printings list has loaded yet).
      let assigned = 0;
      for (const p of c.prints ?? []) {
        const qty = Math.min(p.qty, c.qty - assigned);
        if (qty <= 0) break;
        addPrint.run(id, p.id, p.finish, qty, 9999);
        assigned += qty;
      }
    }
    // Merging keeps whichever want is higher: the backup should never make a wish smaller.
    const wish = db.prepare("INSERT INTO wishlist (card_id, want) VALUES (?, ?) ON CONFLICT (card_id) DO UPDATE SET want = MAX(wishlist.want, excluded.want), updated_at = datetime('now')");
    for (const w of backup.wishlist ?? []) {
      const id = resolve(w.id, w.name);
      if (!id) continue;
      wish.run(id, w.want);
      result.wishlist++;
    }
  });
  result.unresolved = [...unresolved];
  return result;
}
