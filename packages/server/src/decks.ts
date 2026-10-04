import { transaction, type Db } from './schema.js';
import { BOARDS, FORMATS, asFormat, isFormatId, parseDeckList, validateDeck, type Board, type DeckEntry, type FormatId } from '@grimoire/shared';
import type { DeckDetail, DeckSummary, ImportResult } from '@grimoire/shared';
import { getCardsByIds, resolveCardName } from './cards.js';

interface DeckRow { id: number; name: string; format: string; updated_at: string; card_count: number }

const SUMMARY_SQL = `SELECT d.id, d.name, d.format, d.updated_at,
  COALESCE((SELECT SUM(qty) FROM deck_cards c WHERE c.deck_id = d.id AND c.board != 'sideboard'), 0) AS card_count
  FROM decks d`;

const toSummary = (r: DeckRow): DeckSummary => ({ id: r.id, name: r.name, format: asFormat(r.format), cardCount: r.card_count, updatedAt: r.updated_at });

export class NotFoundError extends Error {}
export class BadRequestError extends Error {}

export function listDecks(db: Db): DeckSummary[] {
  return (db.prepare(`${SUMMARY_SQL} ORDER BY d.updated_at DESC, d.id DESC`).all() as unknown as DeckRow[]).map(toSummary);
}

function requireFormat(format: unknown): FormatId {
  if (!isFormatId(format)) throw new BadRequestError(`Unknown format "${String(format)}"`);
  return format;
}

export function createDeck(db: Db, name: string, format: FormatId = 'commander'): DeckSummary {
  const trimmed = name.trim();
  if (!trimmed) throw new BadRequestError('Deck name is required');
  const { lastInsertRowid } = db.prepare('INSERT INTO decks (name, format) VALUES (?, ?)').run(trimmed, requireFormat(format));
  return getSummary(db, Number(lastInsertRowid));
}

function getSummary(db: Db, id: number): DeckSummary {
  const row = db.prepare(`${SUMMARY_SQL} WHERE d.id = ?`).get(id) as DeckRow | undefined;
  if (!row) throw new NotFoundError(`Deck ${id} not found`);
  return toSummary(row);
}

const touch = (db: Db, id: number) => db.prepare("UPDATE decks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);

export function renameDeck(db: Db, id: number, name: string): DeckSummary {
  return updateDeck(db, id, { name });
}

/** Rename a deck and/or change its format. Leaving Commander moves the commander(s) to the main deck, as there is no command zone. */
export function updateDeck(db: Db, id: number, changes: { name?: string; format?: string }): DeckSummary {
  getSummary(db, id);
  const name = changes.name === undefined ? undefined : changes.name.trim();
  if (name === '') throw new BadRequestError('Deck name is required');
  const format = changes.format === undefined ? undefined : requireFormat(changes.format);
  transaction(db, () => {
    if (name !== undefined) db.prepare('UPDATE decks SET name = ? WHERE id = ?').run(name, id);
    if (format !== undefined) {
      db.prepare('UPDATE decks SET format = ? WHERE id = ?').run(format, id);
      if (!FORMATS[format].commander) {
        db.prepare(`INSERT INTO deck_cards (deck_id, card_id, board, qty) SELECT deck_id, card_id, 'main', qty FROM deck_cards WHERE deck_id = ? AND board = 'commander'
          ON CONFLICT (deck_id, card_id, board) DO UPDATE SET qty = deck_cards.qty + excluded.qty`).run(id);
        db.prepare("DELETE FROM deck_cards WHERE deck_id = ? AND board = 'commander'").run(id);
      }
    }
    touch(db, id);
  });
  return getSummary(db, id);
}

export function deleteDeck(db: Db, id: number): void {
  if (db.prepare('DELETE FROM decks WHERE id = ?').run(id).changes === 0) throw new NotFoundError(`Deck ${id} not found`);
}

export function getDeck(db: Db, id: number): DeckDetail {
  const deck = getSummary(db, id);
  const rows = db.prepare('SELECT card_id, board, qty FROM deck_cards WHERE deck_id = ?').all(id) as unknown as Array<{ card_id: string; board: Board; qty: number }>;
  const cards = getCardsByIds(db, rows.map((r) => r.card_id));
  // Cards that vanished from the card pool (e.g. removed from Scryfall) are skipped.
  const entries: DeckEntry[] = rows.flatMap((r) => {
    const card = cards.get(r.card_id);
    return card ? [{ card, qty: r.qty, board: r.board }] : [];
  });
  entries.sort((a, b) => a.card.name.localeCompare(b.card.name));
  return { deck, entries, issues: validateDeck(entries, deck.format) };
}

/** Set the quantity of a card on a board (0 removes it). Commander-zone cards are exclusive to that board. */
/**
 * Set how many copies of a card are on a board (0 removes them). The main deck and sideboard are independent (a 60-card deck can run
 * 4 main + 2 sideboard), but the command zone is exclusive: a commander isn't also in the 99. With `move`, the card's copies on every
 * other board are removed, so the call relocates it instead of adding a second stack.
 */
export function setCardQty(db: Db, deckId: number, cardId: string, board: Board, qty: number, opts: { move?: boolean } = {}): DeckDetail {
  if (!BOARDS.includes(board)) throw new BadRequestError(`Unknown board "${board}"`);
  if (!Number.isInteger(qty) || qty < 0 || qty > 99) throw new BadRequestError('qty must be an integer from 0 to 99');
  getSummary(db, deckId);
  if (!getCardsByIds(db, [cardId]).size) throw new NotFoundError(`Card ${cardId} not found`);
  transaction(db, () => {
    if (qty === 0) {
      db.prepare('DELETE FROM deck_cards WHERE deck_id = ? AND card_id = ? AND board = ?').run(deckId, cardId, board);
    } else {
      if (board === 'commander' || opts.move) db.prepare('DELETE FROM deck_cards WHERE deck_id = ? AND card_id = ? AND board != ?').run(deckId, cardId, board);
      else db.prepare("DELETE FROM deck_cards WHERE deck_id = ? AND card_id = ? AND board = 'commander'").run(deckId, cardId);
      db.prepare(`INSERT INTO deck_cards (deck_id, card_id, board, qty) VALUES (?, ?, ?, ?)
        ON CONFLICT (deck_id, card_id, board) DO UPDATE SET qty = excluded.qty`).run(deckId, cardId, board, qty);
    }
    touch(db, deckId);
  });
  return getDeck(db, deckId);
}

/** Import a pasted list into a new deck (or replace the contents of `deckId`). */
export function importDeck(db: Db, text: string, opts: { name?: string; deckId?: number; format?: string }): ImportResult {
  const lines = parseDeckList(text);
  if (lines.length === 0) throw new BadRequestError('No cards found in the pasted list');

  const merged = new Map<string, { qty: number; board: Board }>(); // key: cardId|board
  const unresolved: string[] = [];
  for (const line of lines) {
    const card = resolveCardName(db, line.name);
    if (!card) { unresolved.push(line.name); continue; }
    const key = `${card.id}|${line.board}`;
    const cur = merged.get(key);
    merged.set(key, { qty: Math.min((cur?.qty ?? 0) + line.qty, 99), board: line.board });
  }

  const id = transaction(db, () => {
    const deckId = opts.deckId ?? createDeck(db, opts.name?.trim() || 'Imported deck', opts.format === undefined ? undefined : requireFormat(opts.format)).id;
    if (opts.deckId !== undefined) {
      getSummary(db, deckId);
      db.prepare('DELETE FROM deck_cards WHERE deck_id = ?').run(deckId);
    }
    const insert = db.prepare('INSERT INTO deck_cards (deck_id, card_id, board, qty) VALUES (?, ?, ?, ?)');
    // The main deck and sideboard can both hold a card (4 + 2), but a commander isn't also in the 99: the command zone wins.
    const commanders = new Set<string>();
    for (const board of BOARDS) {
      for (const [key, v] of merged) {
        const cardId = key.split('|')[0]!;
        if (v.board !== board) continue;
        if (board !== 'commander' && commanders.has(cardId)) continue;
        if (board === 'commander') commanders.add(cardId);
        insert.run(deckId, cardId, board, v.qty);
      }
    }
    touch(db, deckId);
    return deckId;
  });

  return { ...getDeck(db, id), unresolved };
}
