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
  /** Cheapest paper printing in USD and its set, when cheapest-printing prices are enabled. */
  usdMin?: number | null;
  usdMinSet?: string | null;
  /** How many copies the user owns (set by the server; absent for cards built without a collection). */
  owned?: number;
  /** How many copies sit in decks (all of them; a Commander sideboard doesn't count). `owned - inDecks` is what's spare. */
  inDecks?: number;
}

/** A card a line of scanned text might be naming. */
export interface CardMatchCandidate {
  card: Card;
  /** 0 to 1: how close the text is to the card's name. */
  score: number;
  line: string;
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
  format: import('./formats.js').FormatId;
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
  /** Present when the import was asked to also add the deck's cards to the collection. */
  addedToCollection?: AddToCollectionResult;
}

// ------------------------------------------------------------- card data

export interface DataStatus {
  /** empty: nothing downloaded yet. ready: card pool loaded. updating: a download/import is running. error: the last update failed. */
  state: 'empty' | 'ready' | 'updating' | 'error';
  cardCount: number;
  /** Scryfall's `updated_at` for the bulk file currently loaded. */
  bulkUpdatedAt: string | null;
  progress?: { phase: 'checking' | 'downloading' | 'importing'; item?: 'cards' | 'rulings' | 'tags' | 'prices' | 'rules' | 'names'; received?: number; total?: number; cards?: number };
  error?: string;
  /** Cheapest-printing prices (an optional 79 MB download). */
  prices?: { enabled: boolean; updatedAt: string | null };
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
  /** True when copies sitting in your other decks were not counted as available. */
  excludedOtherDecks: boolean;
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

export interface AddToCollectionResult {
  /** Copies added and distinct cards touched (basic lands are skipped). */
  added: number;
  unique: number;
  summary: CollectionSummary;
}

// ------------------------------------------------------------ card detail

export interface Ruling { source: string; publishedAt: string; comment: string }
export interface TagInfo { slug: string; label: string; description: string | null; cards: number }
export interface KeywordInfo { term: string; definition: string; rule: string | null }
export interface CardDetail { card: Card; rulings: Ruling[]; tags: TagInfo[]; keywords: KeywordInfo[] }

// ----------------------------------------------------------------- backup

/** Everything the user created, in a form that survives card-data updates (cards are referenced by oracle id, with names as a fallback). */
export interface UserDataBackup {
  app: 'grimoire';
  /** Backup format version, independent of the database schema. */
  version: 1;
  exportedAt: string;
  decks: Array<{ name: string; format: string; cards: Array<{ id: string; name: string; board: 'commander' | 'main' | 'sideboard'; qty: number }> }>;
  collection: Array<{ id: string; name: string; qty: number }>;
}

export interface RestoreResult {
  decks: number;
  deckCards: number;
  collectionCards: number;
  collectionCopies: number;
  /** Cards that couldn't be found in the current card data (by id or name). */
  unresolved: string[];
}

// -------------------------------------------------------------- semantic search

export interface SemanticStatus {
  /** off: not set up. downloading / building: working. ready: usable (pending > 0 means some cards aren't indexed yet). */
  state: 'off' | 'downloading' | 'building' | 'ready' | 'error';
  enabled: boolean;
  indexed: number;
  total: number;
  /** Cards that are new or changed since they were indexed. */
  pending: number;
  /** `what` says which download is running: the language model, or the pre-built card index. */
  progress?: { phase: 'downloading' | 'building'; what?: 'model' | 'index'; received?: number; total?: number; done?: number; of?: number };
  error?: string;
  model: string;
}

// ------------------------------------------------------------------- rules

export interface RulesStatus { loaded: boolean; effective: string | null; rules: number; glossary: number }
export interface RuleHit { id: string; kind: 'group' | 'rule' | 'subrule'; section: number; sectionTitle: string; text: string }
export interface RulesSearchResult { rules: RuleHit[]; glossary: Array<{ term: string; definition: string; rule: string | null }>; exact: RuleHit | null }
export interface RuleDetail { rule: RuleHit; ancestors: RuleHit[]; children: RuleHit[] }
export interface RulesToc { sections: Array<{ num: number; title: string; groups: Array<{ id: string; title: string }> }> }
