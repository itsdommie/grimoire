import type Database from 'better-sqlite3';
import { BOARDS, parseDeckList, validateCommander, type Board, type DeckEntry } from '@grimoire/shared';
import type { DeckDetail, DeckSummary, ImportResult } from '@grimoire/shared';
import { getCardsByIds, resolveCardName } from './cards.js';

interface DeckRow { id: number; name: string; format: 'commander'; updated_at: string; card_count: number }

const SUMMARY_SQL = `SELECT d.id, d.name, d.format, d.updated_at,
  COALESCE((SELECT SUM(qty) FROM deck_cards c WHERE c.deck_id = d.id AND c.board != 'sideboard'), 0) AS card_count
  FROM decks d`;

const toSummary = (r: DeckRow): DeckSummary => ({ id: r.id, name: r.name, format: r.format, cardCount: r.card_count, updatedAt: r.updated_at });

export class NotFoundError extends Error {}
export class BadRequestError extends Error {}

export function listDecks(db: Database.Database): DeckSummary[] {
  return (db.prepare(`${SUMMARY_SQL} ORDER BY d.updated_at DESC, d.id DESC`).all() as DeckRow[]).map(toSummary);
}

export function createDeck(db: Database.Database, name: string): DeckSummary {
  const trimmed = name.trim();
  if (!trimmed) throw new BadRequestError('Deck name is required');
  const { lastInsertRowid } = db.prepare('INSERT INTO decks (name) VALUES (?)').run(trimmed);
  return getSummary(db, Number(lastInsertRowid));
}

function getSummary(db: Database.Database, id: number): DeckSummary {
  const row = db.prepare(`${SUMMARY_SQL} WHERE d.id = ?`).get(id) as DeckRow | undefined;
  if (!row) throw new NotFoundError(`Deck ${id} not found`);
  return toSummary(row);
}

const touch = (db: Database.Database, id: number) => db.prepare("UPDATE decks SET updated_at = datetime('now') WHERE id = ?").run(id);

export function renameDeck(db: Database.Database, id: number, name: string): DeckSummary {
  const trimmed = name.trim();
  if (!trimmed) throw new BadRequestError('Deck name is required');
  getSummary(db, id);
  db.prepare("UPDATE decks SET name = ?, updated_at = datetime('now') WHERE id = ?").run(trimmed, id);
  return getSummary(db, id);
}

export function deleteDeck(db: Database.Database, id: number): void {
  if (db.prepare('DELETE FROM decks WHERE id = ?').run(id).changes === 0) throw new NotFoundError(`Deck ${id} not found`);
}

export function getDeck(db: Database.Database, id: number): DeckDetail {
  const deck = getSummary(db, id);
  const rows = db.prepare('SELECT card_id, board, qty FROM deck_cards WHERE deck_id = ?').all(id) as Array<{ card_id: string; board: Board; qty: number }>;
  const cards = getCardsByIds(db, rows.map((r) => r.card_id));
  // Cards that vanished from the card pool (e.g. removed from Scryfall) are skipped.
  const entries: DeckEntry[] = rows.flatMap((r) => {
    const card = cards.get(r.card_id);
    return card ? [{ card, qty: r.qty, board: r.board }] : [];
  });
  entries.sort((a, b) => a.card.name.localeCompare(b.card.name));
  return { deck, entries, issues: validateCommander(entries) };
}

/** Set the quantity of a card on a board (0 removes it). Commander-zone cards are exclusive to that board. */
export function setCardQty(db: Database.Database, deckId: number, cardId: string, board: Board, qty: number): DeckDetail {
  if (!BOARDS.includes(board)) throw new BadRequestError(`Unknown board "${board}"`);
  if (!Number.isInteger(qty) || qty < 0 || qty > 99) throw new BadRequestError('qty must be an integer from 0 to 99');
  getSummary(db, deckId);
  if (!getCardsByIds(db, [cardId]).size) throw new NotFoundError(`Card ${cardId} not found`);
  db.transaction(() => {
    if (qty === 0) {
      db.prepare('DELETE FROM deck_cards WHERE deck_id = ? AND card_id = ? AND board = ?').run(deckId, cardId, board);
    } else {
      // A card lives on one board at a time: moving it replaces its other rows.
      db.prepare('DELETE FROM deck_cards WHERE deck_id = ? AND card_id = ? AND board != ?').run(deckId, cardId, board);
      db.prepare(`INSERT INTO deck_cards (deck_id, card_id, board, qty) VALUES (?, ?, ?, ?)
        ON CONFLICT (deck_id, card_id, board) DO UPDATE SET qty = excluded.qty`).run(deckId, cardId, board, qty);
    }
    touch(db, deckId);
  })();
  return getDeck(db, deckId);
}

/** Import a pasted list into a new deck (or replace the contents of `deckId`). */
export function importDeck(db: Database.Database, text: string, opts: { name?: string; deckId?: number }): ImportResult {
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

  const id = db.transaction(() => {
    const deckId = opts.deckId ?? createDeck(db, opts.name?.trim() || 'Imported deck').id;
    if (opts.deckId !== undefined) {
      getSummary(db, deckId);
      db.prepare('DELETE FROM deck_cards WHERE deck_id = ?').run(deckId);
    }
    const insert = db.prepare('INSERT INTO deck_cards (deck_id, card_id, board, qty) VALUES (?, ?, ?, ?)');
    // If the same card was listed on two boards, keep the first (commander > main > sideboard).
    const seen = new Set<string>();
    for (const board of BOARDS) {
      for (const [key, v] of merged) {
        const cardId = key.split('|')[0]!;
        if (v.board !== board || seen.has(cardId)) continue;
        seen.add(cardId);
        insert.run(deckId, cardId, board, v.qty);
      }
    }
    touch(db, deckId);
    return deckId;
  })();

  return { ...getDeck(db, id), unresolved };
}
