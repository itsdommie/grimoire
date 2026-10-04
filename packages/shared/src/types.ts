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
  /** The printing of this card you most recently added to your collection, when you have said which it is. Its art replaces the default. */
  ownedPrinting?: OwnedPrinting;
}

export type Finish = 'nonfoil' | 'foil' | 'etched';

export interface OwnedPrinting {
  id: string;
  set: string;
  collector: string;
  finish: Finish;
}

/** One printing of a card: a specific set and collector number, with how many of it you own. */
export interface PrintingInfo {
  id: string;
  cardId: string;
  set: string;
  setName: string;
  collector: string;
  released: string | null;
  finishes: Finish[];
  usd: number | null;
  usdFoil: number | null;
  usdEtched: number | null;
  imageUrl: string;
  imageUrlBack: string | null;
  owned: Record<Finish, number>;
}

/** What the scanner made of the bottom of a card: the printing if it is certain, else the printings it could be. */
export interface PrintingIdentification {
  printing: PrintingInfo | null;
  candidates: PrintingInfo[];
  /** What narrowed it down: both set code and number, just one of them, the copyright year, or nothing. */
  basis: 'set-and-number' | 'set' | 'number' | 'year' | 'none';
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
  progress?: { phase: 'checking' | 'downloading' | 'importing'; item?: 'cards' | 'rulings' | 'tags' | 'prices' | 'rules' | 'names' | 'printings'; received?: number; total?: number; cards?: number };
  error?: string;
  /** Cheapest-printing prices (an optional 79 MB download). */
  prices?: { enabled: boolean; updatedAt: string | null };
  /** Something optional failed (rulings or tags) while the core card data is fine. */
  warning?: string;
  /** The loaded data predates this app version (older shape, or extras not fetched yet): the UI refreshes it automatically. */
  outdated?: boolean;
  /** Set after an update check: true if Scryfall had nothing newer. */
  upToDate?: boolean;
  /** A card update is waiting to be downloaded (the Android app doesn't fetch big files over mobile data on its own). Size in bytes. */
  available?: { size: number };
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
  /** Copies that were matched to a specific printing (the file named a set and collector number). */
  withPrinting?: number;
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
export interface CardDetail {
  card: Card; rulings: Ruling[]; tags: TagInfo[]; keywords: KeywordInfo[];
  /** Copies you want in total (0 when the card is not on your wishlist). */
  wanted: number;
}

// ---------------------------------------------------------------------- sync

export interface SyncStatus {
  /** Whether this app can keep decks, collection and wishlist in step with other devices at all (a build without sync, or the web dev server). */
  available: boolean;
  /** Syncing through a folder that something else (Dropbox, Syncthing...) keeps in step: desktop only. */
  folderSupported: boolean;
  /** Whether Google sign-in is set up in this build. */
  googleSupported: boolean;
  provider: 'google' | 'folder' | null;
  folderPath: string | null;
  /** The signed-in Google account, when there is one. */
  account: string | null;
  /** Google has signed this device out (or never finished signing in): the person has to sign in again. */
  needsSignIn: boolean;
  running: boolean;
  /** The last successful sync. */
  lastAt: string | null;
  /** What it changed on this device, and whether it updated the shared copy. */
  lastPulled: number;
  lastPushed: boolean;
  /** Why the last attempt failed, in words a person can act on. */
  error: string | null;
}

// ------------------------------------------------------------- deck suggestions

export interface RoleSuggestions {
  role: string;
  label: string;
  /** Copies of this role already in the deck, and the advice for it (Commander only), as the analysis reports them. */
  inDeck: number;
  target?: { min: number; max: number };
  status?: 'short' | 'ok' | 'high';
  /** How many owned cards could fill this role (the list below is the best few). */
  total: number;
  cards: Card[];
}
export interface DeckSuggestions {
  /** The deck has nothing to take its colours from yet (no commander, or no spells). */
  needsMore: boolean;
  /** Owned cards that are legal, in the deck's colours and not already in it. */
  pool: number;
  roles: RoleSuggestions[];
}

// -------------------------------------------------------------- price watch

export interface PriceMover {
  card: Card;
  /** Price at the start of the window (or the earliest we recorded), and now. USD, each card at its cheapest printing. */
  then: number;
  now: number;
  change: number;
  /** Percent change; null when it started at 0. */
  pct: number | null;
  owned: number;
  wanted: number;
  /** What the change means for you: the change times the copies you own (or still need, for a card you only want). */
  effectUsd: number;
}
export interface PriceReport {
  days: number;
  /** The first day any price was recorded (null before the first snapshot): history can't go back further than this. */
  since: string | null;
  /** Cards being watched (in the collection, on the wishlist or in a deck) that have a price. */
  tracked: number;
  /** What the watched cards you own were worth at the start of the window and are now. */
  valueNow: number;
  valueThen: number;
  up: PriceMover[];
  down: PriceMover[];
}

// ---------------------------------------------------------------- banlists

export interface BanlistFormat { id: string; label: string; banned: number; restricted: number }
export interface BanlistReport {
  format: BanlistFormat;
  banned: Card[];
  /** Vintage and a few others allow one copy of a restricted card. */
  restricted: Card[];
}

// ----------------------------------------------------------------- wishlist

export interface WishlistItem {
  card: Card;
  /** Copies you want to own in total. */
  want: number;
  owned: number;
  /** Copies still to find: what you want, less what you own now. 0 means you have them all. */
  need: number;
  /** USD for the copies still needed, at the card's cheapest printing; null when it has no price. */
  costUsd: number | null;
}
export interface WishlistReport {
  /** Cards you still need copies of first (dearest first), then the ones you have since got. */
  items: WishlistItem[];
  /** Items with copies still to find. */
  open: number;
  totalUsd: number;
  unpriced: number;
}

// ----------------------------------------------------------------- backup

/** Everything the user created, in a form that survives card-data updates (cards are referenced by oracle id, with names as a fallback). */
export interface UserDataBackup {
  app: 'grimoire';
  /** Backup format version, independent of the database schema. */
  version: 1;
  exportedAt: string;
  decks: Array<{ name: string; format: string; cards: Array<{ id: string; name: string; board: 'commander' | 'main' | 'sideboard'; qty: number }> }>;
  /** `prints`: which printings (and finishes) some of the copies are. Optional, so backups made before printings existed still restore. */
  collection: Array<{ id: string; name: string; qty: number; prints?: Array<{ id: string; set: string; collector: string; finish: Finish; qty: number }> }>;
  /** Optional, so backups made before the wishlist existed still restore. `want` is the copies wanted in total. */
  wishlist?: Array<{ id: string; name: string; want: number }>;
}

export interface RestoreResult {
  decks: number;
  deckCards: number;
  collectionCards: number;
  collectionCopies: number;
  /** Wishlist entries restored. */
  wishlist: number;
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

// ----------------------------------------------------------------- advisor

/** The optional Claude advisor: a chat whose answers are built from lookups in the local card database. */
export interface AdvisorStatus {
  /** An API key is available (stored by the app, or supplied through the environment). */
  configured: boolean;
  source: 'stored' | 'environment' | null;
  /** The app can keep a key for you (the desktop app, in the operating system's keychain). */
  canStore: boolean;
  model: string;
  models: Array<{ id: string; label: string }>;
}
export interface AdvisorMessage { role: 'user' | 'assistant'; content: string }
export interface AdvisorReply {
  reply: string;
  /** Cards the answer names that the advisor actually looked up in your card database (so they are real). */
  cards: Array<{ id: string; name: string; imageUrl: string | null }>;
  /** How many database lookups it made to answer. */
  lookups: number;
}

// -------------------------------------------------------------------- sets

export interface SetSummary {
  code: string;
  name: string;
  released: string | null;
  /** Scryfall's set type ("core", "expansion", "commander", "masters", "promo", ...); null until the printings data that carries it is loaded. */
  kind: string | null;
  /** Different cards printed in the set. */
  cards: number;
  /** Of those, cards you own in any printing. */
  owned: number;
  /** Of those, cards you have recorded as this set's printing. */
  ownedHere: number;
}
export interface SetCard {
  card: Card;
  /** The printing shown for this card in this set (the lowest collector number; some sets print a card several times). */
  printingId: string;
  collector: string;
  imageUrl: string;
  /** The finish a click on "own" records: nonfoil when the printing comes that way, else foil or etched. */
  finish: Finish;
  /** Cheapest price among the card's printings in this set, any finish (null when none is known). */
  usd: number | null;
  /** How many printings of this card the set has. */
  variants: number;
  /** Copies you have recorded as a printing from this set. */
  copiesHere: number;
  /** The card comes in foil (or etched) in this set. */
  foilable: boolean;
  /** Of the copies recorded from this set, how many are foil or etched. */
  foilCopies: number;
}
export interface SetDetail {
  set: SetSummary;
  /** About what it would cost to buy every card you don't own from the set, at the cheapest price in the set (null when no prices are loaded). */
  missingUsd: number | null;
  /** Cards you don't own whose price is unknown. */
  unpriced: number;
  /** Foil completion: cards that come in foil in this set, and how many of those you have a foil copy of (recorded as this set's printing). */
  foils: { possible: number; owned: number };
  /** Cards matching the filter (the page below is part of these). */
  total: number;
  cards: SetCard[];
}
