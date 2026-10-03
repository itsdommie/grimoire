import type { Db } from './db.js';
import { compileQuery, SearchError, termsOf, type Card, type CardDetail, type SearchResponse, type TagInfo } from '@grimoire/shared';

export type Order = 'name' | 'cmc' | 'edhrec' | 'usd';

const ORDER_SQL: Record<Order, string> = {
  name: 'name COLLATE NOCASE ASC',
  cmc: 'cmc ASC, name COLLATE NOCASE ASC',
  edhrec: 'edhrec_rank IS NULL, edhrec_rank ASC, name COLLATE NOCASE ASC',
  usd: 'usd IS NULL, usd DESC, name COLLATE NOCASE ASC',
};

/** Every card query selects the owned count too, so any Card handed out knows how many copies the user has. */
export const CARD_SELECT = 'SELECT cards.*, COALESCE((SELECT qty FROM collection WHERE collection.card_id = cards.id), 0) AS owned FROM cards';

export interface Row {
  id: string; name: string; mana_cost: string; cmc: number; type_line: string; oracle_text: string;
  colors: number; color_identity: number; produced_mana: number; keywords: string;
  power: string | null; toughness: string | null; loyalty: string | null;
  rarity: string; set_code: string; layout: string; edhrec_rank: number | null; usd: number | null;
  image_url: string | null; image_url_back: string | null; scryfall_uri: string; owned: number;
}

export function rowToCard(db: Db, r: Row): Card {
  const legalities: Record<string, string> = {};
  for (const l of db.prepare('SELECT format, status FROM legality WHERE card_id = ?').all(r.id) as Array<{ format: string; status: string }>) {
    legalities[l.format] = l.status;
  }
  return {
    id: r.id, name: r.name, manaCost: r.mana_cost, cmc: r.cmc, typeLine: r.type_line, oracleText: r.oracle_text,
    colors: r.colors, colorIdentity: r.color_identity, producedMana: r.produced_mana,
    keywords: r.keywords ? r.keywords.split(' ') : [],
    power: r.power, toughness: r.toughness, loyalty: r.loyalty, rarity: r.rarity, setCode: r.set_code,
    layout: r.layout, edhrecRank: r.edhrec_rank, usd: r.usd, imageUrl: r.image_url, imageUrlBack: r.image_url_back, scryfallUri: r.scryfall_uri,
    legalities, owned: r.owned,
  };
}

export interface SearchOptions { query: string; order?: Order; limit?: number; offset?: number }

/** Throws SearchError (from @grimoire/shared) on a malformed query. */
export function searchCards(db: Db, opts: SearchOptions): SearchResponse {
  const { where, params } = compileQuery(opts.query);
  validateTags(db, opts.query);
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const order = ORDER_SQL[opts.order ?? 'name'];

  const total = (db.prepare(`SELECT count(*) AS n FROM cards WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`${CARD_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as Row[];
  return { total, cards: rows.map((r) => rowToCard(db, r)) };
}

export function getCardByName(db: Db, name: string): Card | null {
  const row = db.prepare(`${CARD_SELECT} WHERE name = ? COLLATE NOCASE`).get(name) as Row | undefined;
  return row ? rowToCard(db, row) : null;
}

export function getCardsByIds(db: Db, ids: readonly string[]): Map<string, Card> {
  const out = new Map<string, Card>();
  const stmt = db.prepare(`${CARD_SELECT} WHERE id = ?`);
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
  const exact = db.prepare(`${CARD_SELECT} WHERE name = ? COLLATE NOCASE`).get(norm) as Row | undefined;
  const row = exact ?? (db.prepare(`${CARD_SELECT} WHERE name LIKE ? ESCAPE '\\' ORDER BY length(name) LIMIT 1`).get(`${norm.replace(/[\\%_]/g, (m) => `\\${m}`)} // %`) as Row | undefined);
  return row ? rowToCard(db, row) : null;
}

/** otag:foo for a tag that doesn't exist would silently match nothing, so say so instead. */
function validateTags(db: Db, query: string): void {
  const wanted = termsOf(query).filter((t) => t.key === 'otag' || t.key === 'function' || t.key === 'oracletag');
  if (wanted.length === 0) return;
  const known = db.prepare('SELECT 1 FROM tags WHERE slug = ? UNION SELECT 1 FROM tag_aliases WHERE alias = ? LIMIT 1');
  const any = db.prepare('SELECT 1 FROM tags LIMIT 1').get();
  if (!any) throw new SearchError('Function tags (otag:) aren\'t downloaded yet. Use "Check for card updates" at the bottom of the page.');
  for (const t of wanted) {
    const slug = t.value.toLowerCase();
    if (!known.get(slug, slug)) throw new SearchError(`Unknown function tag "${t.value}". Try otag:ramp, otag:removal, otag:sweeper or otag:draw.`);
  }
}

// Tags that label how a card is written rather than what it does; showing them on a card is just noise.
const NOISE_TAGS = new Set(['alliteration', 'namesake-spell', 'single-english-word-name', 'unique-type-line', 'activated-ability', 'triggered-ability', 'intervening-if-clause', 'french-vanilla', 'virtual-vanilla', 'virtual-french-vanilla', 'drawback', 'delayed-trigger', 'cast-trigger-you', 'repeatable-crime', 'cheaper-than-mv', 'more-expensive-than-mv', 'alternative-cost', 'multiple-targets']);

export function getCardDetail(db: Db, id: string): CardDetail | null {
  const card = getCardsByIds(db, [id]).get(id);
  if (!card) return null;
  const rulings = (db.prepare('SELECT source, published_at, comment FROM rulings WHERE oracle_id = ? ORDER BY published_at, rowid').all(id) as unknown as Array<{ source: string; published_at: string; comment: string }>)
    .map((r) => ({ source: r.source, publishedAt: r.published_at, comment: r.comment }));
  const tags = (db.prepare(`SELECT t.slug, t.label, t.description, t.cards FROM card_tags ct JOIN tags t ON t.slug = ct.tag
      WHERE ct.card_id = ? AND t.cards >= 25 AND t.slug NOT LIKE 'cycle-%' ORDER BY t.cards DESC`).all(id) as unknown as TagInfo[])
    .filter((t) => !NOISE_TAGS.has(t.slug)).slice(0, 16);
  return { card, rulings, tags };
}
