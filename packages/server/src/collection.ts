import { compileQuery, copiesInDecksSql, isBasicLand, parseCollection, reservesCopies, type AddToCollectionResult, type Card, type CollectionImportResult, type CollectionSummary, type CommanderIdea, type MissingCard, type MissingReport } from '@grimoire/shared';
import { getCardsByIds, resolveCardName } from './cards.js';
import { transaction, type Db } from './schema.js';
import { getDeck, BadRequestError } from './decks.js';
import { collectorDigits } from '@grimoire/shared';
import { isFinish, maskToFinishes, type Finish } from './printings.js';

export function collectionSummary(db: Db): CollectionSummary {
  const row = db.prepare(`SELECT count(*) AS unique_cards, COALESCE(sum(collection.qty), 0) AS total,
      COALESCE(sum(collection.qty * COALESCE(cards.usd_min, cards.usd)), 0) AS value, COALESCE(sum(COALESCE(cards.usd_min, cards.usd) IS NULL), 0) AS unpriced
    FROM collection JOIN cards ON cards.id = collection.card_id`).get() as unknown as { unique_cards: number; total: number; value: number; unpriced: number };
  return { unique: row.unique_cards, total: row.total, valueUsd: Math.round(row.value * 100) / 100, unpriced: row.unpriced };
}

const MAX_QTY = 9999;

/** Import a collection export (ManaBox/Moxfield/Archidekt/Deckbox CSV or a plain list). `replace` swaps the whole collection; `merge` adds. */
export function importCollection(db: Db, text: string, mode: 'merge' | 'replace'): CollectionImportResult {
  const parsed = parseCollection(text);
  if (parsed.rows.length === 0) throw new BadRequestError('No cards found. Paste a CSV export or a list like "4 Sol Ring".');

  const totals = new Map<string, number>();
  const assigned = new Map<string, { cardId: string; printingId: string; finish: Finish; qty: number }>(); // copies the file ties to a printing
  const unresolved = new Set<string>();
  const lookups = new Map<string, string | null>(); // exports repeat names (one row per printing), so resolve each name once
  const printingLookups = new Map<string, { id: string; finishes: Finish[] } | null>();
  for (const row of parsed.rows) {
    const key = row.name.toLowerCase();
    let id = lookups.get(key);
    if (id === undefined) { id = resolveCardName(db, row.name)?.id ?? null; lookups.set(key, id); }
    if (!id) { unresolved.add(row.name); continue; }
    totals.set(id, (totals.get(id) ?? 0) + row.qty);
    // A set code and collector number name the printing; the finish says foil or not. Without them the copies are just the card's.
    if (row.scryfallId || (row.set && row.collector)) {
      const pkey = `${id}|${row.scryfallId ?? ''}|${row.set ?? ''}|${row.collector ?? ''}`;
      let p = printingLookups.get(pkey);
      if (p === undefined) {
        // The printing's own id is exact; the set and collector number are the next best thing.
        p = (row.scryfallId ? findPrintingById(db, id, row.scryfallId) : null) ?? (row.set && row.collector ? findPrinting(db, id, row.set, row.collector) : null);
        printingLookups.set(pkey, p);
      }
      if (p) {
        const want: Finish = row.finish ?? 'nonfoil';
        const finish = p.finishes.includes(want) ? want : p.finishes[0] ?? 'nonfoil';
        const akey = `${p.id}|${finish}`;
        const cur = assigned.get(akey);
        assigned.set(akey, { cardId: id, printingId: p.id, finish, qty: (cur?.qty ?? 0) + row.qty });
      }
    }
  }
  if (totals.size === 0) throw new BadRequestError(`None of the ${parsed.rows.length} rows matched a card. Is this a collection export?`);

  let imported = 0;
  let withPrinting = 0;
  transaction(db, () => {
    if (mode === 'replace') db.exec('DELETE FROM collection; DELETE FROM collection_prints;');
    const upsert = db.prepare(`INSERT INTO collection (card_id, qty) VALUES (?, ?)
      ON CONFLICT (card_id) DO UPDATE SET qty = MIN(?, collection.qty + excluded.qty), updated_at = datetime('now')`);
    for (const [id, qty] of totals) { upsert.run(id, Math.min(qty, MAX_QTY), MAX_QTY); imported += qty; }
    const addPrint = db.prepare(`INSERT INTO collection_prints (card_id, printing_id, finish, qty) VALUES (?, ?, ?, ?)
      ON CONFLICT (printing_id, finish) DO UPDATE SET qty = MIN(?, collection_prints.qty + excluded.qty), updated_at = datetime('now')`);
    for (const a of assigned.values()) { addPrint.run(a.cardId, a.printingId, a.finish, Math.min(a.qty, MAX_QTY), MAX_QTY); withPrinting += a.qty; }
  });
  return { format: parsed.format, imported, unique: totals.size, unresolved: [...unresolved], skipped: parsed.skipped, withPrinting, summary: collectionSummary(db) };
}

export function setOwned(db: Db, cardId: string, qty: number): void {
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) throw new BadRequestError(`qty must be a whole number from 0 to ${MAX_QTY}`);
  if (getCardsByIds(db, [cardId]).size === 0) throw new BadRequestError('Unknown card');
  transaction(db, () => {
    if (qty === 0) db.prepare('DELETE FROM collection WHERE card_id = ?').run(cardId);
    else db.prepare(`INSERT INTO collection (card_id, qty) VALUES (?, ?) ON CONFLICT (card_id) DO UPDATE SET qty = excluded.qty, updated_at = datetime('now')`).run(cardId, qty);
    trimPrints(db, cardId, qty);
  });
}

/** After the card's total went down: copies with a known printing can't outnumber the total, so the oldest records give way first. */
function trimPrints(db: Db, cardId: string, total: number): void {
  let excess = (db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM collection_prints WHERE card_id = ?').get(cardId) as { n: number }).n - total;
  if (excess <= 0) return;
  const rows = db.prepare('SELECT printing_id, finish, qty FROM collection_prints WHERE card_id = ? ORDER BY updated_at ASC, printing_id, finish').all(cardId) as Array<{ printing_id: string; finish: Finish; qty: number }>;
  for (const r of rows) {
    if (excess <= 0) break;
    const take = Math.min(r.qty, excess);
    excess -= take;
    if (take === r.qty) db.prepare('DELETE FROM collection_prints WHERE printing_id = ? AND finish = ?').run(r.printing_id, r.finish);
    else db.prepare('UPDATE collection_prints SET qty = qty - ? WHERE printing_id = ? AND finish = ?').run(take, r.printing_id, r.finish);
  }
}

/** A printing by its Scryfall id, if it is a printing of this card. */
export function findPrintingById(db: Db, cardId: string, printingId: string): { id: string; finishes: Finish[] } | null {
  const r = db.prepare('SELECT id, finishes FROM printings WHERE id = ? AND card_id = ?').get(printingId, cardId) as { id: string; finishes: number } | undefined;
  return r ? { id: r.id, finishes: maskToFinishes(r.finishes) } : null;
}

/** The printing of a card in a set with a collector number (digits compared, so "0021" finds "21"), if there is exactly one. */
export function findPrinting(db: Db, cardId: string, set: string, collector: string): { id: string; finishes: Finish[] } | null {
  const rows = db.prepare('SELECT id, collector, finishes FROM printings WHERE card_id = ? AND set_code = ?').all(cardId, set.toLowerCase()) as Array<{ id: string; collector: string; finishes: number }>;
  const exact = rows.filter((r) => r.collector.toLowerCase() === collector.toLowerCase());
  const digits = collectorDigits(collector);
  const sameDigits = rows.filter((r) => digits !== '' && collectorDigits(r.collector) === digits);
  // "0400" is "400" rather than "400★" or "400a": the plain number wins when it is the only one.
  const plain = sameDigits.filter((r) => /^\d+$/.test(r.collector));
  const pick = exact.length === 1 ? exact : plain.length === 1 ? plain : sameDigits;
  return pick.length === 1 ? { id: pick[0]!.id, finishes: maskToFinishes(pick[0]!.finishes) } : null;
}

/**
 * Say how many copies you own of one printing in one finish. By default the card's total moves by the same amount, so setting a
 * printing to 3 when you owned 1 makes the card's total 2 higher (the scanner: you picked up another card). With `claim`, copies
 * of the card that had no printing recorded are used up first, so the total only grows once every copy has one (the card
 * detail: "one of the copies I already have is this printing").
 */
export function setOwnedPrinting(db: Db, printingId: string, finish: Finish, qty: number, opts: { claim?: boolean } = {}): void {
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) throw new BadRequestError(`qty must be a whole number from 0 to ${MAX_QTY}`);
  if (!isFinish(finish)) throw new BadRequestError('finish must be nonfoil, foil or etched');
  const p = db.prepare('SELECT card_id, finishes FROM printings WHERE id = ?').get(printingId) as { card_id: string; finishes: number } | undefined;
  if (!p) throw new BadRequestError('Unknown printing');
  if (qty > 0 && !maskToFinishes(p.finishes).includes(finish)) throw new BadRequestError(`That printing doesn't come in ${finish}`);
  transaction(db, () => {
    const old = (db.prepare('SELECT qty FROM collection_prints WHERE printing_id = ? AND finish = ?').get(printingId, finish) as { qty: number } | undefined)?.qty ?? 0;
    const total = (db.prepare('SELECT qty FROM collection WHERE card_id = ?').get(p.card_id) as { qty: number } | undefined)?.qty ?? 0;
    const assigned = (db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM collection_prints WHERE card_id = ?').get(p.card_id) as { n: number }).n;
    const next = Math.min(MAX_QTY, Math.max(0, opts.claim ? Math.max(total, assigned - old + qty) : total + qty - old));
    if (qty === 0) db.prepare('DELETE FROM collection_prints WHERE printing_id = ? AND finish = ?').run(printingId, finish);
    else db.prepare(`INSERT INTO collection_prints (card_id, printing_id, finish, qty) VALUES (?, ?, ?, ?)
      ON CONFLICT (printing_id, finish) DO UPDATE SET qty = excluded.qty, updated_at = datetime('now')`).run(p.card_id, printingId, finish, qty);
    if (next === 0) db.prepare('DELETE FROM collection WHERE card_id = ?').run(p.card_id);
    else db.prepare(`INSERT INTO collection (card_id, qty) VALUES (?, ?) ON CONFLICT (card_id) DO UPDATE SET qty = excluded.qty, updated_at = datetime('now')`).run(p.card_id, next);
  });
}

export function clearCollection(db: Db): void {
  db.exec('DELETE FROM collection; DELETE FROM collection_prints;');
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Add a deck's cards to the collection, for decks that live outside the collection export (built decks, say). A separate step from
 * importing a collection, so it only ever adds. Basic lands and a Commander deck's maybeboard are skipped.
 */
export function addDeckToCollection(db: Db, deckId: number): AddToCollectionResult {
  const { entries, deck } = getDeck(db, deckId);
  const totals = new Map<string, number>();
  for (const { card, qty, board } of entries) {
    if (isBasicLand(card) || !reservesCopies(deck.format, board)) continue;
    totals.set(card.id, (totals.get(card.id) ?? 0) + qty);
  }
  let added = 0;
  transaction(db, () => {
    const upsert = db.prepare(`INSERT INTO collection (card_id, qty) VALUES (?, ?)
      ON CONFLICT (card_id) DO UPDATE SET qty = MIN(?, collection.qty + excluded.qty), updated_at = datetime('now')`);
    for (const [id, qty] of totals) { upsert.run(id, Math.min(qty, MAX_QTY), MAX_QTY); added += qty; }
  });
  return { added, unique: totals.size, summary: collectionSummary(db) };
}

/** Copies of each card sitting in decks other than `deckId`. */
function copiesInOtherDecks(db: Db, deckId: number): Map<string, number> {
  const rows = db.prepare(`SELECT dc.card_id AS id, SUM(dc.qty) AS n FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
    WHERE d.id != ? AND (dc.board != 'sideboard' OR d.format != 'commander') GROUP BY dc.card_id`).all(deckId) as unknown as Array<{ id: string; n: number }>;
  return new Map(rows.map((r) => [r.id, r.n]));
}

/**
 * What a deck still needs from the collection, with a rough price. Basic lands are treated as free and always available.
 * With `excludeOtherDecks`, copies that other decks are using don't count as owned, so the report says what building this deck
 * would take without breaking those apart (5 Sol Rings with 4 in other decks leaves 1 for this one).
 */
export function deckMissing(db: Db, deckId: number, opts: { excludeOtherDecks?: boolean } = {}): MissingReport {
  const { entries, deck } = getDeck(db, deckId);
  const elsewhere = opts.excludeOtherDecks ? copiesInOtherDecks(db, deckId) : new Map<string, number>();
  const sideboardCounts = deck.format !== 'commander'; // in Commander the sideboard is a maybeboard; in 60-card formats you need those cards too
  let needed = 0, have = 0, totalUsd = 0, unpriced = 0;
  const missing: MissingCard[] = [];
  for (const { card, qty, board } of entries) {
    if ((board === 'sideboard' && !sideboardCounts) || isBasicLand(card)) continue;
    const owned = Math.max(0, (card.owned ?? 0) - (elsewhere.get(card.id) ?? 0));
    needed += qty;
    have += Math.min(qty, owned);
    const short = Math.max(0, qty - owned);
    if (short === 0) continue;
    const price = card.usdMin ?? card.usd;
    const costUsd = price === null || price === undefined ? null : round2(price * short);
    if (costUsd === null) unpriced++; else totalUsd += costUsd;
    missing.push({ card, need: qty, owned, missing: short, costUsd });
  }
  missing.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.card.name.localeCompare(b.card.name));
  return { needed, have, missing, totalUsd: round2(totalUsd), unpriced, excludedOtherDecks: !!opts.excludeOtherDecks };
}

/**
 * Owned commanders ranked by how many of your other cards could go in their deck. With `spareOnly`, only copies no deck is using
 * count (a commander already leading a deck, or a card whose every copy is in a deck, is left out), so a new deck doesn't break
 * an existing one apart.
 */
export function commanderIdeas(db: Db, limit = 24, spareOnly = false): CommanderIdea[] {
  const { where, params } = compileQuery(`is:commander f:commander ${spareOnly ? 'spare>0' : 'owned>0'}`);
  const commanders = db.prepare(`SELECT cards.id AS id, cards.color_identity AS ci, cards.name AS name FROM cards WHERE ${where}`).all(...params) as unknown as Array<{ id: string; ci: number; name: string }>;
  if (commanders.length === 0) return [];
  // Load the cards that could go in a deck once, then count per commander in memory: a correlated SQL count per commander
  // re-scanned the whole collection each time and took seconds for a collection of a few thousand cards.
  const pool = db.prepare(`SELECT cards.id AS id, cards.color_identity AS ci, cards.type_line LIKE '%Land%' AS land
    FROM collection col JOIN cards ON cards.id = col.card_id
    WHERE EXISTS (SELECT 1 FROM legality l WHERE l.card_id = cards.id AND l.format = 'commander' AND l.status IN ('legal', 'restricted'))
      ${spareOnly ? `AND col.qty > ${copiesInDecksSql('cards.id', [])}` : ''}`).all() as unknown as Array<{ id: string; ci: number; land: number }>;
  const rows = commanders.map((c) => {
    let playable = 0, spells = 0;
    for (const k of pool) {
      if (k.id === c.id || (k.ci | c.ci) !== c.ci) continue;
      playable++;
      if (!k.land) spells++;
    }
    return { id: c.id, name: c.name, playable, spells };
  }).sort((a, b) => b.playable - a.playable || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).slice(0, limit);
  const cards = getCardsByIds(db, rows.map((r) => r.id));
  return rows.flatMap((r) => { const commander = cards.get(r.id) as Card | undefined; return commander ? [{ commander, playable: r.playable, spells: r.spells }] : []; });
}
