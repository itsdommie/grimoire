import type { RestoreResult, UserDataBackup } from '@grimoire/shared';
import { BOARDS, type Board } from '@grimoire/shared';
import { getCardsByIds, resolveCardName } from './cards.js';
import { transaction, type Db } from './db.js';
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
  const collection = (db.prepare('SELECT card_id, qty FROM collection ORDER BY card_id').all() as unknown as Array<{ card_id: string; qty: number }>)
    .map((c) => ({ id: c.card_id, name: nameOf(c.card_id), qty: c.qty }));
  return { app: 'grimoire', version: 1, exportedAt: new Date().toISOString(), decks, collection };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 9999;

/** Check the shape of an uploaded backup, with errors a person can act on. */
export function parseBackup(raw: unknown): UserDataBackup {
  if (!isObj(raw) || raw.app !== 'grimoire') throw new BadRequestError("This doesn't look like a Grimoire backup file.");
  if (raw.version !== 1) throw new BadRequestError(`This backup is version ${String(raw.version)}, which this version of Grimoire can't read.`);
  if (!Array.isArray(raw.decks) || !Array.isArray(raw.collection)) throw new BadRequestError('The backup is missing its decks or collection.');
  for (const d of raw.decks) {
    if (!isObj(d) || typeof d.name !== 'string' || !Array.isArray(d.cards)) throw new BadRequestError('A deck in the backup is malformed.');
    for (const c of d.cards) if (!isObj(c) || typeof c.id !== 'string' || !BOARDS.includes(c.board as Board) || !posInt(c.qty)) throw new BadRequestError(`A card in the deck "${d.name}" is malformed.`);
  }
  for (const c of raw.collection) if (!isObj(c) || typeof c.id !== 'string' || !posInt(c.qty)) throw new BadRequestError('A collection entry in the backup is malformed.');
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

  const result: RestoreResult = { decks: 0, deckCards: 0, collectionCards: 0, collectionCopies: 0, unresolved: [] };
  transaction(db, () => {
    if (mode === 'replace') { db.exec('DELETE FROM deck_cards; DELETE FROM decks; DELETE FROM collection;'); }
    const insertDeck = db.prepare('INSERT INTO decks (name, format) VALUES (?, ?)');
    const insertCard = db.prepare('INSERT INTO deck_cards (deck_id, card_id, board, qty) VALUES (?, ?, ?, ?) ON CONFLICT (deck_id, card_id, board) DO UPDATE SET qty = qty + excluded.qty');
    for (const d of backup.decks) {
      const deckId = Number(insertDeck.run(d.name.trim() || 'Restored deck', d.format || 'commander').lastInsertRowid);
      result.decks++;
      for (const c of d.cards) {
        const id = resolve(c.id, c.name);
        if (!id) continue;
        insertCard.run(deckId, id, c.board, c.qty);
        result.deckCards += c.qty;
      }
    }
    const upsert = db.prepare('INSERT INTO collection (card_id, qty) VALUES (?, ?) ON CONFLICT (card_id) DO UPDATE SET qty = MIN(9999, collection.qty + excluded.qty), updated_at = datetime(\'now\')');
    for (const c of backup.collection) {
      const id = resolve(c.id, c.name);
      if (!id) continue;
      upsert.run(id, c.qty);
      result.collectionCards++;
      result.collectionCopies += c.qty;
    }
  });
  result.unresolved = [...unresolved];
  return result;
}
