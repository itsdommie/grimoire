import { collectorDigits, type Card, type SetCard, type SetDetail, type SetSummary } from '@grimoire/shared';
import { getCardsByIds } from './cards.js';
import { maskToFinishes, printingImageUrl } from './printings.js';
import type { Db } from './schema.js';

// Browsing by set, with how much of each you own. Built on the printings tables, so it needs the printings data (the app loads it with
// the card data) and says nothing for a set it has no printings of.

interface SummaryRow { code: string; name: string; released: string | null; kind: string | null; cards: number; owned: number; here: number }

const SUMMARY_SQL = `
  SELECT s.code AS code, s.name AS name, s.released AS released, s.kind AS kind,
         count(DISTINCT p.card_id) AS cards,
         count(DISTINCT CASE WHEN c.qty > 0 THEN p.card_id END) AS owned,
         count(DISTINCT CASE WHEN cp.printing_id IS NOT NULL THEN p.card_id END) AS here
  FROM sets s
  JOIN printings p ON p.set_code = s.code
  LEFT JOIN collection c ON c.card_id = p.card_id
  LEFT JOIN collection_prints cp ON cp.printing_id = p.id`;

const toSummary = (r: SummaryRow): SetSummary => ({ code: r.code, name: r.name, released: r.released || null, kind: r.kind || null, cards: r.cards, owned: r.owned, ownedHere: r.here });

/** Every set with printings, newest first. `q` narrows by name or code. */
export function listSets(db: Db, q = ''): SetSummary[] {
  const rows = db.prepare(`${SUMMARY_SQL} GROUP BY s.code`).all() as unknown as SummaryRow[];
  const needle = q.trim().toLowerCase();
  return rows
    .filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.code.toLowerCase() === needle)
    .sort((a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.name.localeCompare(b.name))
    .map(toSummary);
}

/** `nofoil`: cards that come in foil in this set and that you have no foil copy of (recorded as this set's printing). */
export type SetFilter = 'all' | 'owned' | 'missing' | 'nofoil';

const priceOf = (r: { usd: number | null; usd_foil: number | null; usd_etched: number | null }) => [r.usd, r.usd_foil, r.usd_etched].filter((n): n is number => !!n && n > 0).sort((a, b) => a - b)[0] ?? null;
const byCollector = (a: { collector: string }, b: { collector: string }) => Number(collectorDigits(a.collector) || Infinity) - Number(collectorDigits(b.collector) || Infinity) || a.collector.localeCompare(b.collector);

/** One set's cards in collector-number order, with what you own and what the rest would cost. */
export function getSet(db: Db, code: string, opts: { filter?: SetFilter; limit?: number; offset?: number } = {}): SetDetail | null {
  const row = db.prepare(`${SUMMARY_SQL} WHERE s.code = ? GROUP BY s.code`).get(code.toLowerCase()) as SummaryRow | undefined;
  if (!row) return null;

  const printings = db.prepare('SELECT id, card_id, collector, finishes, usd, usd_foil, usd_etched FROM printings WHERE set_code = ?').all(row.code) as unknown as Array<{ id: string; card_id: string; collector: string; finishes: number; usd: number | null; usd_foil: number | null; usd_etched: number | null }>;
  const owned = new Map((db.prepare('SELECT card_id, qty FROM collection').all() as unknown as Array<{ card_id: string; qty: number }>).map((r) => [r.card_id, r.qty]));
  const here = new Map<string, number>();
  for (const r of db.prepare('SELECT cp.card_id AS card_id, sum(cp.qty) AS n FROM collection_prints cp JOIN printings p ON p.id = cp.printing_id WHERE p.set_code = ? GROUP BY cp.card_id').all(row.code) as unknown as Array<{ card_id: string; n: number }>) here.set(r.card_id, r.n);

  const foilHere = new Map<string, number>();
  for (const r of db.prepare("SELECT cp.card_id AS card_id, sum(cp.qty) AS n FROM collection_prints cp JOIN printings p ON p.id = cp.printing_id WHERE p.set_code = ? AND cp.finish IN ('foil', 'etched') GROUP BY cp.card_id").all(row.code) as unknown as Array<{ card_id: string; n: number }>) foilHere.set(r.card_id, r.n);

  // One entry per card: the printing with the lowest collector number stands for it, and the cheapest price of any of its printings counts.
  const byCard = new Map<string, { first: (typeof printings)[number]; usd: number | null; variants: number; foilable: boolean }>();
  for (const p of printings) {
    const cur = byCard.get(p.card_id);
    const price = priceOf(p);
    const foilable = (p.finishes & 6) !== 0; // foil or etched
    if (!cur) byCard.set(p.card_id, { first: p, usd: price, variants: 1, foilable });
    else {
      cur.variants++;
      if (foilable) cur.foilable = true;
      if (byCollector(p, cur.first) < 0) cur.first = p;
      if (price !== null && (cur.usd === null || price < cur.usd)) cur.usd = price;
    }
  }

  let missingUsd = 0, priced = 0, unpriced = 0;
  for (const [cardId, e] of byCard) {
    if (owned.get(cardId)) continue;
    if (e.usd === null) unpriced++; else { missingUsd += e.usd; priced++; }
  }

  let foilPossible = 0, foilOwned = 0;
  for (const [id, e] of byCard) if (e.foilable) { foilPossible++; if (foilHere.get(id)) foilOwned++; }

  const filter = opts.filter ?? 'all';
  const keep = (id: string, e: { foilable: boolean }) => filter === 'all' || (filter === 'nofoil' ? e.foilable && !foilHere.get(id) : (filter === 'owned') === !!owned.get(id));
  const entries = [...byCard.entries()].filter(([id, e]) => keep(id, e)).sort((a, b) => byCollector(a[1].first, b[1].first));
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const page = entries.slice(offset, offset + limit);
  const cards = getCardsByIds(db, page.map(([id]) => id));
  return {
    set: toSummary(row),
    missingUsd: priced > 0 ? Math.round(missingUsd * 100) / 100 : null,
    unpriced,
    foils: { possible: foilPossible, owned: foilOwned },
    total: entries.length,
    cards: page.flatMap(([id, e]): SetCard[] => {
      const card: Card | undefined = cards.get(id);
      return card ? [{ card, printingId: e.first.id, collector: e.first.collector, imageUrl: printingImageUrl(e.first.id), finish: maskToFinishes(e.first.finishes)[0] ?? 'nonfoil', usd: e.usd, variants: e.variants, copiesHere: here.get(id) ?? 0, foilable: e.foilable, foilCopies: foilHere.get(id) ?? 0 }] : [];
    }),
  };
}
