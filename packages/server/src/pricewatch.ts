import type { Card, PriceMover, PriceReport } from '@grimoire/shared';
import { getCardsByIds } from './cards.js';
import { transaction, type Db } from './schema.js';

// Price watch. Scryfall only gives today's price, so history has to be recorded: for each card you care about (in your collection, on your
// wishlist or in a deck) a row is stored when its price differs from the last one stored. A card's price on a given day is then the latest
// row on or before it. Nothing shows until prices have moved, which for Scryfall's data takes days.

const DAY = 864e5;
const today = () => new Date().toISOString().slice(0, 10);
const dayAgo = (from: string, days: number) => new Date(Date.parse(`${from}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The cards being watched: everything in the collection, on the wishlist or in a deck. */
const WATCHED_SQL = `SELECT card_id FROM collection UNION SELECT card_id FROM wishlist UNION SELECT card_id FROM deck_cards`;

/** Record today's price of every watched card whose price has changed since the last record. Safe to call as often as you like. */
export function snapshotPrices(db: Db, day = today()): number {
  const rows = db.prepare(`SELECT c.id AS id, ROUND(COALESCE(c.usd_min, c.usd), 2) AS price,
      (SELECT price FROM price_history h WHERE h.card_id = c.id AND h.day <= ? ORDER BY h.day DESC LIMIT 1) AS last
    FROM cards c WHERE c.id IN (${WATCHED_SQL}) AND COALESCE(c.usd_min, c.usd) IS NOT NULL`).all(day) as unknown as Array<{ id: string; price: number; last: number | null }>;
  const put = db.prepare('INSERT OR REPLACE INTO price_history (card_id, day, price) VALUES (?, ?, ?)');
  let written = 0;
  transaction(db, () => {
    for (const r of rows) if (r.last === null || r.last !== r.price) { put.run(r.id, day, r.price); written++; }
  });
  return written;
}

export type PriceScope = 'all' | 'collection' | 'wishlist';

/**
 * How watched cards' prices have moved over the last `days` days, biggest effect on you first. The effect is the change times the copies
 * you own (or, for a card you only want, the copies still to find), so a $5 rise on a playset matters more than a $20 rise on a card you
 * don't have. `then` is the price on the first day of the window, or the earliest we recorded if we have not watched that long.
 */
export function getPriceReport(db: Db, opts: { days?: number; scope?: PriceScope; limit?: number; now?: string } = {}): PriceReport {
  const now = opts.now ?? today();
  const days = Math.min(Math.max(Math.round(opts.days ?? 30), 1), 730);
  const scope = opts.scope ?? 'all';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const cutoff = dayAgo(now, days);

  const qty = new Map((db.prepare('SELECT card_id, qty FROM collection').all() as unknown as Array<{ card_id: string; qty: number }>).map((r) => [r.card_id, r.qty]));
  const want = new Map((db.prepare('SELECT card_id, want FROM wishlist').all() as unknown as Array<{ card_id: string; want: number }>).map((r) => [r.card_id, r.want]));
  const inScope = (id: string) => (scope === 'collection' ? qty.has(id) : scope === 'wishlist' ? want.has(id) : true);

  const rows = db.prepare(`SELECT c.id AS id, ROUND(COALESCE(c.usd_min, c.usd), 2) AS price,
      COALESCE((SELECT price FROM price_history h WHERE h.card_id = c.id AND h.day <= ? ORDER BY h.day DESC LIMIT 1),
               (SELECT price FROM price_history h WHERE h.card_id = c.id ORDER BY h.day ASC LIMIT 1)) AS then_price
    FROM cards c WHERE c.id IN (${WATCHED_SQL}) AND COALESCE(c.usd_min, c.usd) IS NOT NULL`).all(cutoff) as unknown as Array<{ id: string; price: number; then_price: number | null }>;
  const first = (db.prepare('SELECT min(day) AS day FROM price_history').get() as unknown as { day: string | null }).day;

  const watched = rows.filter((r) => inScope(r.id));
  const movers: Array<{ id: string; then: number; now: number; copies: number }> = [];
  let valueNow = 0, valueThen = 0;
  for (const r of watched) {
    const owned = qty.get(r.id) ?? 0;
    if (r.then_price !== null && owned > 0 && scope !== 'wishlist') { valueNow += r.price * owned; valueThen += r.then_price * owned; }
    if (r.then_price === null || r.then_price === r.price) continue;
    const copies = scope === 'wishlist' ? Math.max(0, (want.get(r.id) ?? 0) - owned) : owned > 0 ? owned : Math.max(0, (want.get(r.id) ?? 0) - owned);
    movers.push({ id: r.id, then: r.then_price, now: r.price, copies: Math.max(copies, 1) });
  }
  movers.sort((a, b) => Math.abs((b.now - b.then) * b.copies) - Math.abs((a.now - a.then) * a.copies) || a.id.localeCompare(b.id));
  const shown = movers.slice(0, limit);
  const cards = getCardsByIds(db, shown.map((m) => m.id));
  const toMover = (m: (typeof movers)[number]): PriceMover[] => {
    const card: Card | undefined = cards.get(m.id);
    if (!card) return [];
    const change = round2(m.now - m.then);
    return [{ card, then: m.then, now: m.now, change, pct: m.then > 0 ? Math.round(((m.now - m.then) / m.then) * 1000) / 10 : null, owned: qty.get(m.id) ?? 0, wanted: want.get(m.id) ?? 0, effectUsd: round2(change * m.copies) }];
  };
  const all = shown.flatMap(toMover);
  return {
    days,
    since: first,
    tracked: watched.length,
    valueNow: round2(valueNow),
    valueThen: round2(valueThen),
    up: all.filter((m) => m.change > 0),
    down: all.filter((m) => m.change < 0),
  };
}
