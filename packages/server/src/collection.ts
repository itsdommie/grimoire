import { compileQuery, isBasicLand, parseCollection, type Card, type CollectionImportResult, type CollectionSummary, type CommanderIdea, type MissingCard, type MissingReport } from '@grimoire/shared';
import { getCardsByIds, resolveCardName } from './cards.js';
import { transaction, type Db } from './db.js';
import { getDeck, BadRequestError } from './decks.js';

export function collectionSummary(db: Db): CollectionSummary {
  const row = db.prepare(`SELECT count(*) AS unique_cards, COALESCE(sum(collection.qty), 0) AS total,
      COALESCE(sum(collection.qty * cards.usd), 0) AS value, COALESCE(sum(cards.usd IS NULL), 0) AS unpriced
    FROM collection JOIN cards ON cards.id = collection.card_id`).get() as unknown as { unique_cards: number; total: number; value: number; unpriced: number };
  return { unique: row.unique_cards, total: row.total, valueUsd: Math.round(row.value * 100) / 100, unpriced: row.unpriced };
}

const MAX_QTY = 9999;

/** Import a collection export (ManaBox/Moxfield/Archidekt/Deckbox CSV or a plain list). `replace` swaps the whole collection; `merge` adds. */
export function importCollection(db: Db, text: string, mode: 'merge' | 'replace'): CollectionImportResult {
  const parsed = parseCollection(text);
  if (parsed.rows.length === 0) throw new BadRequestError('No cards found. Paste a CSV export or a list like "4 Sol Ring".');

  const totals = new Map<string, number>();
  const unresolved = new Set<string>();
  const lookups = new Map<string, string | null>(); // exports repeat names (one row per printing), so resolve each name once
  for (const row of parsed.rows) {
    const key = row.name.toLowerCase();
    let id = lookups.get(key);
    if (id === undefined) { id = resolveCardName(db, row.name)?.id ?? null; lookups.set(key, id); }
    if (!id) { unresolved.add(row.name); continue; }
    totals.set(id, (totals.get(id) ?? 0) + row.qty);
  }
  if (totals.size === 0) throw new BadRequestError(`None of the ${parsed.rows.length} rows matched a card. Is this a collection export?`);

  let imported = 0;
  transaction(db, () => {
    if (mode === 'replace') db.exec('DELETE FROM collection');
    const upsert = db.prepare(`INSERT INTO collection (card_id, qty) VALUES (?, ?)
      ON CONFLICT (card_id) DO UPDATE SET qty = MIN(?, collection.qty + excluded.qty), updated_at = datetime('now')`);
    for (const [id, qty] of totals) { upsert.run(id, Math.min(qty, MAX_QTY), MAX_QTY); imported += qty; }
  });
  return { format: parsed.format, imported, unique: totals.size, unresolved: [...unresolved], skipped: parsed.skipped, summary: collectionSummary(db) };
}

export function setOwned(db: Db, cardId: string, qty: number): void {
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) throw new BadRequestError(`qty must be a whole number from 0 to ${MAX_QTY}`);
  if (getCardsByIds(db, [cardId]).size === 0) throw new BadRequestError('Unknown card');
  if (qty === 0) db.prepare('DELETE FROM collection WHERE card_id = ?').run(cardId);
  else db.prepare(`INSERT INTO collection (card_id, qty) VALUES (?, ?) ON CONFLICT (card_id) DO UPDATE SET qty = excluded.qty, updated_at = datetime('now')`).run(cardId, qty);
}

export function clearCollection(db: Db): void {
  db.exec('DELETE FROM collection');
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What a deck still needs from the collection, with a rough price. Basic lands are treated as free and always available. */
export function deckMissing(db: Db, deckId: number): MissingReport {
  const { entries } = getDeck(db, deckId);
  let needed = 0, have = 0, totalUsd = 0, unpriced = 0;
  const missing: MissingCard[] = [];
  for (const { card, qty, board } of entries) {
    if (board === 'sideboard' || isBasicLand(card)) continue;
    const owned = card.owned ?? 0;
    needed += qty;
    have += Math.min(qty, owned);
    const short = Math.max(0, qty - owned);
    if (short === 0) continue;
    const costUsd = card.usd === null ? null : round2(card.usd * short);
    if (costUsd === null) unpriced++; else totalUsd += costUsd;
    missing.push({ card, need: qty, owned, missing: short, costUsd });
  }
  missing.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.card.name.localeCompare(b.card.name));
  return { needed, have, missing, totalUsd: round2(totalUsd), unpriced };
}

/** Owned commanders ranked by how many of your other cards could go in their deck. */
export function commanderIdeas(db: Db, limit = 24): CommanderIdea[] {
  const { where, params } = compileQuery('is:commander f:commander owned>0');
  const rows = db.prepare(`SELECT cards.id AS id,
      (SELECT count(*) FROM collection col JOIN cards k ON k.id = col.card_id
         WHERE k.id != cards.id AND (k.color_identity | cards.color_identity) = cards.color_identity
           AND EXISTS (SELECT 1 FROM legality l WHERE l.card_id = k.id AND l.format = 'commander' AND l.status IN ('legal', 'restricted'))) AS playable,
      (SELECT count(*) FROM collection col JOIN cards k ON k.id = col.card_id
         WHERE k.id != cards.id AND k.type_line NOT LIKE '%Land%' AND (k.color_identity | cards.color_identity) = cards.color_identity
           AND EXISTS (SELECT 1 FROM legality l WHERE l.card_id = k.id AND l.format = 'commander' AND l.status IN ('legal', 'restricted'))) AS spells
    FROM cards WHERE ${where} ORDER BY playable DESC, cards.name COLLATE NOCASE LIMIT ?`).all(...params, limit) as unknown as Array<{ id: string; playable: number; spells: number }>;
  const cards = getCardsByIds(db, rows.map((r) => r.id));
  return rows.flatMap((r) => { const commander = cards.get(r.id) as Card | undefined; return commander ? [{ commander, playable: r.playable, spells: r.spells }] : []; });
}
