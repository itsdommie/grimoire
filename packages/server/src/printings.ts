import { boundedDistance, collectorDigits, type Finish, type PrintingHints, type PrintingIdentification, type PrintingInfo } from '@grimoire/shared';
import { transaction, type Db } from './schema.js';

/**
 * Printings: the specific cards behind a card name (Sol Ring has dozens). Scryfall's Oracle Cards file has one per card, so the full
 * list comes from its per-printing file, trimmed by CI to a compact file the app downloads (see `PrintingsFile`).
 */
export type { Finish };
export const FINISHES: readonly Finish[] = ['nonfoil', 'foil', 'etched'];
const FINISH_BIT: Record<Finish, number> = { nonfoil: 1, foil: 2, etched: 4 };

export const finishesToMask = (finishes: readonly string[] | undefined): number => (finishes ?? []).reduce((m, f) => m | (FINISH_BIT[f as Finish] ?? 0), 0);
export const maskToFinishes = (mask: number): Finish[] => FINISHES.filter((f) => mask & FINISH_BIT[f]);
export const isFinish = (v: unknown): v is Finish => typeof v === 'string' && (FINISHES as readonly string[]).includes(v);

/** The part of a Scryfall printing we read. */
export interface RawPrinting {
  id?: string;
  oracle_id?: string;
  set?: string;
  set_name?: string;
  set_type?: string;
  collector_number?: string;
  released_at?: string;
  layout?: string;
  digital?: boolean;
  games?: string[];
  finishes?: string[];
  prices?: { usd?: string | null; usd_foil?: string | null; usd_etched?: string | null };
}

const SKIP_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series', 'vanguard', 'scheme', 'planar', 'host']);

/** One row of the compact file: [id, oracleId, set, collector, finishesMask, usd, usdFoil, usdEtched, released]. Prices are 0 when unknown. */
export type PrintingRow = [id: string, cardId: string, set: string, collector: string, finishes: number, usd: number, usdFoil: number, usdEtched: number, released: string];
export const PRINTINGS_FORMAT = 2;
export interface PrintingsFile {
  version: string;
  /** 2 added each set's type. Absent means 1. */
  format?: number;
  /** [code, name, released, type]. (Older files stop after the date.) */
  sets: Array<[string, string, string] | [string, string, string, string]>;
  rows: PrintingRow[];
}

const price = (p: string | null | undefined) => { const n = Number.parseFloat(p ?? ''); return Number.isFinite(n) && n > 0 ? n : 0; };

/** A printing you could hold in your hand: not digital-only, not a token or art card. */
export function printingRow(p: RawPrinting): PrintingRow | null {
  if (!p.id || !p.oracle_id || !p.set || !p.collector_number) return null;
  if (p.digital || (p.games && !p.games.includes('paper')) || (p.layout && SKIP_LAYOUTS.has(p.layout))) return null;
  const finishes = finishesToMask(p.finishes) || FINISH_BIT.nonfoil;
  return [p.id, p.oracle_id, p.set, p.collector_number, finishes, price(p.prices?.usd), price(p.prices?.usd_foil), price(p.prices?.usd_etched), p.released_at ?? ''];
}

/** Stream a per-printing JSONL file (Scryfall's Default Cards) into the compact file. */
export async function collectPrintings(lines: AsyncIterable<string>, version: string): Promise<PrintingsFile> {
  const sets = new Map<string, [string, string, string, string]>();
  const rows: PrintingRow[] = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line) as RawPrinting;
    const row = printingRow(raw);
    if (!row) continue;
    rows.push(row);
    const cur = sets.get(row[2]);
    if (!cur) sets.set(row[2], [row[2], raw.set_name ?? row[2], row[8], raw.set_type ?? '']);
    else if (row[8] && (!cur[2] || row[8] < cur[2])) cur[2] = row[8];
  }
  rows.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[8] < b[8] ? -1 : a[8] > b[8] ? 1 : a[0] < b[0] ? -1 : 1));
  return { version, format: PRINTINGS_FORMAT, sets: [...sets.values()].sort((a, b) => a[0].localeCompare(b[0])), rows };
}

export function parsePrintingsFile(text: string): PrintingsFile {
  const data = JSON.parse(text) as Partial<PrintingsFile>;
  if (typeof data.version !== 'string' || !Array.isArray(data.sets) || !Array.isArray(data.rows)) throw new Error("that isn't a card printings file");
  return data as PrintingsFile;
}

/** Replace the printings (for cards we have). Returns how many were kept. The user's collection records are not touched. */
export function loadPrintings(db: Db, file: PrintingsFile): number {
  const known = new Set((db.prepare('SELECT id FROM cards').all() as Array<{ id: string }>).map((r) => r.id));
  const insert = db.prepare('INSERT OR REPLACE INTO printings (id, card_id, set_code, collector, released, finishes, usd, usd_foil, usd_etched) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertSet = db.prepare('INSERT OR REPLACE INTO sets (code, name, released, kind) VALUES (?, ?, ?, ?)');
  let kept = 0;
  transaction(db, () => {
    // Build the indexes once at the end rather than keeping them up to date through 100,000 inserts: about a third faster, which
    // matters most on a phone.
    db.exec('DELETE FROM printings; DELETE FROM sets; DROP INDEX IF EXISTS printings_card; DROP INDEX IF EXISTS printings_set;');
    for (const [code, name, released, kind] of file.sets) insertSet.run(code, name, released, kind || null);
    for (const [id, cardId, set, collector, finishes, usd, usdFoil, usdEtched, released] of file.rows) {
      if (!known.has(cardId)) continue;
      insert.run(id, cardId, set, collector, released || null, finishes, usd || null, usdFoil || null, usdEtched || null);
      kept++;
    }
    db.exec('CREATE INDEX printings_card ON printings(card_id); CREATE INDEX printings_set ON printings(set_code, collector);');
  });
  return kept;
}

/** Where Scryfall serves a printing's picture. The path is made from the id, so nothing else needs storing. */
export function printingImageUrl(id: string, face: 'front' | 'back' = 'front'): string {
  return `https://cards.scryfall.io/normal/${face}/${id[0]}/${id[1]}/${id}.jpg`;
}

// ------------------------------------------------------------------ queries

interface PrintingDbRow {
  id: string; card_id: string; set_code: string; collector: string; released: string | null; finishes: number;
  usd: number | null; usd_foil: number | null; usd_etched: number | null; set_name: string;
}

const PRINTING_SELECT = `SELECT p.id, p.card_id, p.set_code, p.collector, p.released, p.finishes, p.usd, p.usd_foil, p.usd_etched,
  COALESCE(s.name, upper(p.set_code)) AS set_name FROM printings p LEFT JOIN sets s ON s.code = p.set_code`;

function toInfo(db: Db, r: PrintingDbRow, hasBack: boolean): PrintingInfo {
  const owned: Record<Finish, number> = { nonfoil: 0, foil: 0, etched: 0 };
  for (const o of db.prepare('SELECT finish, qty FROM collection_prints WHERE printing_id = ?').all(r.id) as Array<{ finish: Finish; qty: number }>) owned[o.finish] = o.qty;
  return {
    id: r.id, cardId: r.card_id, set: r.set_code, setName: r.set_name, collector: r.collector, released: r.released, finishes: maskToFinishes(r.finishes),
    usd: r.usd, usdFoil: r.usd_foil, usdEtched: r.usd_etched, imageUrl: printingImageUrl(r.id), imageUrlBack: hasBack ? printingImageUrl(r.id, 'back') : null, owned,
  };
}

const hasBackImage = (db: Db, cardId: string) => !!(db.prepare('SELECT 1 FROM cards WHERE id = ? AND image_url_back IS NOT NULL').get(cardId));

/** Every printing of a card, newest first, with how many of each you own. */
export function listPrintings(db: Db, cardId: string): PrintingInfo[] {
  const back = hasBackImage(db, cardId);
  const rows = db.prepare(`${PRINTING_SELECT} WHERE p.card_id = ?`).all(cardId) as unknown as PrintingDbRow[];
  return rows
    .sort((a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.set_code.localeCompare(b.set_code) || Number(collectorDigits(a.collector)) - Number(collectorDigits(b.collector)) || a.collector.localeCompare(b.collector))
    .map((r) => toInfo(db, r, back));
}

export function getPrinting(db: Db, id: string): PrintingInfo | null {
  const r = db.prepare(`${PRINTING_SELECT} WHERE p.id = ?`).get(id) as PrintingDbRow | undefined;
  return r ? toInfo(db, r, hasBackImage(db, r.card_id)) : null;
}

/**
 * Which printing is this card, given what was read off it? Set code and collector number settle it for modern cards. A set code
 * read slightly wrong (one letter off) still counts if it points to exactly one set this card was printed in. Older cards only
 * give a copyright year, which narrows the list; if it is still not one printing the caller shows the choices.
 */
export function identifyPrinting(db: Db, cardId: string, hints: PrintingHints): PrintingIdentification {
  const all = listPrintings(db, cardId);
  const one = (list: PrintingInfo[], basis: PrintingIdentification['basis']): PrintingIdentification => ({ printing: list.length === 1 ? list[0]! : null, candidates: list, basis });
  const byNumber = (list: PrintingInfo[]) => {
    if (!hints.number) return list;
    const exact = list.filter((p) => collectorDigits(p.collector) === hints.number);
    return exact;
  };
  // Prefer the plain number over "21★" or "21a" when the same digits appear more than once in a set.
  const prefer = (list: PrintingInfo[]) => (list.length > 1 ? (list.filter((p) => /^\d+$/.test(p.collector)).length === 1 ? list.filter((p) => /^\d+$/.test(p.collector)) : list) : list);

  if (hints.set) {
    let inSet = all.filter((p) => p.set === hints.set);
    if (inSet.length === 0) {
      const near = [...new Set(all.map((p) => p.set))].filter((s) => boundedDistance(s, hints.set!, 1) <= 1);
      if (near.length === 1) inSet = all.filter((p) => p.set === near[0]);
    }
    if (inSet.length > 0) {
      if (hints.number) {
        const exact = byNumber(inSet);
        if (exact.length > 0) return one(prefer(exact), 'set-and-number');
      }
      return one(inSet, 'set');
    }
  }
  if (hints.number) {
    const numbered = byNumber(all);
    if (numbered.length > 0 && numbered.length < all.length) return one(prefer(numbered), 'number');
  }
  if (hints.year) {
    const inYear = all.filter((p) => p.released?.startsWith(String(hints.year)));
    if (inYear.length > 0) return one(inYear, 'year');
  }
  return { printing: null, candidates: all, basis: 'none' };
}
