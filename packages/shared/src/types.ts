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
  /** Back face image of a double-faced card (transform / modal), else null. */
  imageUrlBack?: string | null;
  scryfallUri: string;
  legalities: Record<string, string>;
  /** How many copies the user owns (set by the server; absent for cards built without a collection). */
  owned?: number;
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

// ------------------------------------------------------------- card data

export interface DataStatus {
  /** empty: nothing downloaded yet. ready: card pool loaded. updating: a download/import is running. error: the last update failed. */
  state: 'empty' | 'ready' | 'updating' | 'error';
  cardCount: number;
  /** Scryfall's `updated_at` for the bulk file currently loaded. */
  bulkUpdatedAt: string | null;
  progress?: { phase: 'checking' | 'downloading' | 'importing'; item?: 'cards' | 'rulings' | 'tags'; received?: number; total?: number; cards?: number };
  error?: string;
  /** Something optional failed (rulings or tags) while the core card data is fine. */
  warning?: string;
  /** The loaded data predates this app version (older shape, or extras not fetched yet): the UI refreshes it automatically. */
  outdated?: boolean;
  /** Set after an update check: true if Scryfall had nothing newer. */
  upToDate?: boolean;
}

// ------------------------------------------------------------ collection

export interface CollectionSummary {
  unique: number;
  total: number;
  /** Rough value in USD: Scryfall's price for its featured printing of each card, times quantity. */
  valueUsd: number;
  /** Distinct cards with no price. */
  unpriced: number;
}

export interface CollectionImportResult {
  format: import('./collection.js').CollectionFormat;
  /** Copies added (or set, when replacing). */
  imported: number;
  unique: number;
  /** Names that didn't match any card. */
  unresolved: string[];
  skipped: string[];
  summary: CollectionSummary;
}

export interface MissingCard {
  card: Card;
  need: number;
  owned: number;
  missing: number;
  /** USD for the missing copies, or null if the card has no price. */
  costUsd: number | null;
}

export interface MissingReport {
  /** Non-basic cards in the deck / how many of them you own. */
  needed: number;
  have: number;
  missing: MissingCard[];
  totalUsd: number;
  unpriced: number;
}

export interface CommanderIdea {
  commander: Card;
  /** Owned cards (other than the commander) that are legal in Commander and within its colour identity. */
  playable: number;
  /** Of those, how many are not lands. */
  spells: number;
}

// ------------------------------------------------------------ card detail

export interface Ruling { source: string; publishedAt: string; comment: string }
export interface TagInfo { slug: string; label: string; description: string | null; cards: number }
export interface CardDetail { card: Card; rulings: Ruling[]; tags: TagInfo[] }
