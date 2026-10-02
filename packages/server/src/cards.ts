import type { Db } from './db.js';
import { compileQuery, type Card, type SearchResponse } from '@grimoire/shared';

export type Order = 'name' | 'cmc' | 'edhrec' | 'usd';

const ORDER_SQL: Record<Order, string> = {
  name: 'name COLLATE NOCASE ASC',
  cmc: 'cmc ASC, name COLLATE NOCASE ASC',
  edhrec: 'edhrec_rank IS NULL, edhrec_rank ASC, name COLLATE NOCASE ASC',
  usd: 'usd IS NULL, usd DESC, name COLLATE NOCASE ASC',
};

interface Row {
  id: string; name: string; mana_cost: string; cmc: number; type_line: string; oracle_text: string;
  colors: number; color_identity: number; produced_mana: number; keywords: string;
  power: string | null; toughness: string | null; loyalty: string | null;
  rarity: string; set_code: string; layout: string; edhrec_rank: number | null; usd: number | null;
  image_url: string | null; scryfall_uri: string;
}

function rowToCard(db: Db, r: Row): Card {
  const legalities: Record<string, string> = {};
  for (const l of db.prepare('SELECT format, status FROM legality WHERE card_id = ?').all(r.id) as Array<{ format: string; status: string }>) {
    legalities[l.format] = l.status;
  }
  return {
    id: r.id, name: r.name, manaCost: r.mana_cost, cmc: r.cmc, typeLine: r.type_line, oracleText: r.oracle_text,
    colors: r.colors, colorIdentity: r.color_identity, producedMana: r.produced_mana,
    keywords: r.keywords ? r.keywords.split(' ') : [],
    power: r.power, toughness: r.toughness, loyalty: r.loyalty, rarity: r.rarity, setCode: r.set_code,
    layout: r.layout, edhrecRank: r.edhrec_rank, usd: r.usd, imageUrl: r.image_url, scryfallUri: r.scryfall_uri,
    legalities,
  };
}

export interface SearchOptions { query: string; order?: Order; limit?: number; offset?: number }

/** Throws SearchError (from @grimoire/shared) on a malformed query. */
export function searchCards(db: Db, opts: SearchOptions): SearchResponse {
  const { where, params } = compileQuery(opts.query);
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const order = ORDER_SQL[opts.order ?? 'name'];

  const total = (db.prepare(`SELECT count(*) AS n FROM cards WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`SELECT * FROM cards WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as Row[];
  return { total, cards: rows.map((r) => rowToCard(db, r)) };
}

export function getCardByName(db: Db, name: string): Card | null {
  const row = db.prepare('SELECT * FROM cards WHERE name = ? COLLATE NOCASE').get(name) as Row | undefined;
  return row ? rowToCard(db, row) : null;
}

export function getCardsByIds(db: Db, ids: readonly string[]): Map<string, Card> {
  const out = new Map<string, Card>();
  const stmt = db.prepare('SELECT * FROM cards WHERE id = ?');
  for (const id of ids) {
    const row = stmt.get(id) as Row | undefined;
    if (row) out.set(id, rowToCard(db, row));
  }
  return out;
}

/**
 * Resolve a card name from a pasted list. Case-insensitive; accepts a bare front-face
 * name for multi-faced cards ("Fire" for "Fire // Ice") and "A / B" as "A // B".
 */
export function resolveCardName(db: Db, name: string): Card | null {
  const norm = name.replace(/\s*\/{1,2}\s*/g, ' // ').trim();
  const exact = db.prepare('SELECT * FROM cards WHERE name = ? COLLATE NOCASE').get(norm) as Row | undefined;
  const row = exact ?? (db.prepare("SELECT * FROM cards WHERE name LIKE ? ESCAPE '\\' ORDER BY length(name) LIMIT 1").get(`${norm.replace(/[\\%_]/g, (m) => `\\${m}`)} // %`) as Row | undefined);
  return row ? rowToCard(db, row) : null;
}
