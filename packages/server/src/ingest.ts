import { transaction, type Db } from './db.js';
import { mapCard, num, popcount, RARITY_ORDER, type ScryfallCard } from './scryfall.js';

/**
 * Replace the card pool with the cards in a Scryfall JSONL stream (one card object per line).
 * Runs in a single transaction, so readers on other connections keep seeing the old pool until commit.
 * Decks reference cards by oracle id (no FK), so they survive the replacement.
 */
export async function loadJsonl(db: Db, lines: AsyncIterable<string>, onProgress?: (cards: number) => void): Promise<number> {
  const insertCard = db.prepare(`INSERT INTO cards (
    id, name, mana_cost, cmc, type_line, oracle_text, colors, colors_count, color_identity, identity_count,
    produced_mana, keywords, power, toughness, loyalty, power_n, toughness_n, loyalty_n, rarity, rarity_n,
    set_code, layout, digital, edhrec_rank, usd, image_url, image_url_back, scryfall_uri
  ) VALUES (
    :id, :name, :manaCost, :cmc, :typeLine, :oracleText, :colors, :colorsCount, :colorIdentity, :identityCount,
    :producedMana, :keywords, :power, :toughness, :loyalty, :powerN, :toughnessN, :loyaltyN, :rarity, :rarityN,
    :setCode, :layout, :digital, :edhrecRank, :usd, :imageUrl, :imageUrlBack, :scryfallUri
  )`);
  const insertLegality = db.prepare('INSERT INTO legality (card_id, format, status) VALUES (?, ?, ?)');

  let count = 0;
  // BEGIN/COMMIT spans awaits on purpose: this connection is private to the update (see DataManager).
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM legality; DELETE FROM cards;');
    for await (const line of lines) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line) as ScryfallCard;
      const card = mapCard(raw);
      if (!card) continue;
      insertCard.run({
        id: card.id, name: card.name, manaCost: card.manaCost, cmc: card.cmc, typeLine: card.typeLine, oracleText: card.oracleText,
        colors: card.colors, colorsCount: popcount(card.colors), colorIdentity: card.colorIdentity, identityCount: popcount(card.colorIdentity),
        producedMana: card.producedMana, keywords: card.keywords.join(' '),
        power: card.power, toughness: card.toughness, loyalty: card.loyalty,
        powerN: num(card.power ?? undefined), toughnessN: num(card.toughness ?? undefined), loyaltyN: num(card.loyalty ?? undefined),
        rarity: card.rarity, rarityN: RARITY_ORDER[card.rarity] ?? 0, setCode: card.setCode, layout: card.layout,
        digital: raw.digital ? 1 : 0, edhrecRank: card.edhrecRank, usd: card.usd, imageUrl: card.imageUrl, imageUrlBack: card.imageUrlBack ?? null, scryfallUri: card.scryfallUri,
      });
      for (const [format, status] of Object.entries(card.legalities)) {
        if (status !== 'not_legal') insertLegality.run(card.id, format, status);
      }
      count++;
      if (count % 2000 === 0) onProgress?.(count);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  onProgress?.(count);
  return count;
}

export { transaction };

/** Replace the rulings table from Scryfall's rulings JSONL. Returns the number of rulings kept (those for cards we have). */
export async function loadRulings(db: Db, lines: AsyncIterable<string>, onProgress?: (n: number) => void): Promise<number> {
  const known = new Set((db.prepare('SELECT id FROM cards').all() as unknown as Array<{ id: string }>).map((r) => r.id));
  const insert = db.prepare('INSERT INTO rulings (oracle_id, source, published_at, comment) VALUES (?, ?, ?, ?)');
  let count = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM rulings');
    for await (const line of lines) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { oracle_id?: string; source?: string; published_at?: string; comment?: string };
      if (!r.oracle_id || !known.has(r.oracle_id) || !r.comment) continue;
      insert.run(r.oracle_id, r.source ?? 'scryfall', r.published_at ?? '', r.comment);
      if (++count % 5000 === 0) onProgress?.(count);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return count;
}

interface RawTag { id: string; slug: string; label: string; description?: string | null; child_ids?: string[]; aliases?: string[]; taggings?: Array<{ oracle_id: string }> }

/** Replace Oracle Tags (Scryfall's community function labels) and their parent/child hierarchy. Returns the number of tags. */
export async function loadTags(db: Db, lines: AsyncIterable<string>, onProgress?: (n: number) => void): Promise<number> {
  const known = new Set((db.prepare('SELECT id FROM cards').all() as unknown as Array<{ id: string }>).map((r) => r.id));
  const tags: RawTag[] = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    tags.push(JSON.parse(line) as RawTag);
    if (tags.length % 500 === 0) onProgress?.(tags.length);
  }
  const slugOf = new Map(tags.map((t) => [t.id, t.slug]));
  const insertTag = db.prepare('INSERT INTO tags (slug, label, description, cards) VALUES (?, ?, ?, ?)');
  const insertEdge = db.prepare('INSERT OR IGNORE INTO tag_edges (parent, child) VALUES (?, ?)');
  const insertAlias = db.prepare('INSERT OR IGNORE INTO tag_aliases (alias, slug) VALUES (?, ?)');
  const insertCardTag = db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag) VALUES (?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM card_tags; DELETE FROM tag_edges; DELETE FROM tag_aliases; DELETE FROM tags;');
    for (const t of tags) {
      const ids = (t.taggings ?? []).map((g) => g.oracle_id).filter((id) => known.has(id));
      insertTag.run(t.slug, t.label, t.description ?? null, ids.length);
      for (const c of t.child_ids ?? []) { const child = slugOf.get(c); if (child) insertEdge.run(t.slug, child); }
      for (const a of t.aliases ?? []) insertAlias.run(a.toLowerCase(), t.slug);
      for (const id of ids) insertCardTag.run(id, t.slug);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return tags.length;
}
