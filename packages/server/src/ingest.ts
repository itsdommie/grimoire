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
    set_code, layout, digital, edhrec_rank, usd, image_url, scryfall_uri
  ) VALUES (
    :id, :name, :manaCost, :cmc, :typeLine, :oracleText, :colors, :colorsCount, :colorIdentity, :identityCount,
    :producedMana, :keywords, :power, :toughness, :loyalty, :powerN, :toughnessN, :loyaltyN, :rarity, :rarityN,
    :setCode, :layout, :digital, :edhrecRank, :usd, :imageUrl, :scryfallUri
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
        digital: raw.digital ? 1 : 0, edhrecRank: card.edhrecRank, usd: card.usd, imageUrl: card.imageUrl, scryfallUri: card.scryfallUri,
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
