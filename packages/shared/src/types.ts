export interface Card {
  id: string; // Scryfall oracle_id
  name: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  oracleText: string;
  colors: number; // bitmask, see colors.ts
  colorIdentity: number;
  producedMana: number;
  keywords: string[];
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  rarity: string;
  setCode: string;
  layout: string;
  edhrecRank: number | null;
  usd: number | null;
  imageUrl: string | null;
  scryfallUri: string;
  legalities: Record<string, string>;
}

export interface SearchResponse {
  total: number;
  cards: Card[];
  error?: string;
}

// ------------------------------------------------------------------ decks

export interface DeckSummary {
  id: number;
  name: string;
  format: 'commander';
  cardCount: number;
  updatedAt: string;
}

export interface DeckDetail {
  deck: DeckSummary;
  entries: import('./deck.js').DeckEntry[];
  issues: import('./deck.js').Issue[];
}

export interface ImportResult extends DeckDetail {
  /** Lines whose card name could not be found, as written in the pasted list. */
  unresolved: string[];
}
