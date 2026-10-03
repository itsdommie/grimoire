/**
 * The database layer that needs no Node modules: the schema, migrations and `transaction`. The desktop server opens a file with
 * node:sqlite (db.ts); the Android app runs the same code on SQLite compiled to WASM. Both just have to look like `Db`.
 */
export interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id             TEXT PRIMARY KEY,       -- Scryfall oracle_id
  name           TEXT NOT NULL,
  mana_cost      TEXT NOT NULL DEFAULT '',
  cmc            REAL NOT NULL DEFAULT 0,
  type_line      TEXT NOT NULL DEFAULT '',
  oracle_text    TEXT NOT NULL DEFAULT '',
  colors         INTEGER NOT NULL DEFAULT 0,
  colors_count   INTEGER NOT NULL DEFAULT 0,
  color_identity INTEGER NOT NULL DEFAULT 0,
  identity_count INTEGER NOT NULL DEFAULT 0,
  produced_mana  INTEGER NOT NULL DEFAULT 0,
  keywords       TEXT NOT NULL DEFAULT '',  -- space-joined, lower-case matching via LIKE
  power          TEXT,
  toughness      TEXT,
  loyalty        TEXT,
  power_n        REAL,
  toughness_n    REAL,
  loyalty_n      REAL,
  rarity         TEXT NOT NULL,
  rarity_n       INTEGER NOT NULL,
  set_code       TEXT NOT NULL,
  layout         TEXT NOT NULL,
  digital        INTEGER NOT NULL DEFAULT 0,
  edhrec_rank    INTEGER,
  usd            REAL,                   -- price of Scryfall's featured printing
  usd_min        REAL,                   -- cheapest paper printing (only when prices are enabled)
  usd_min_set    TEXT,
  image_url      TEXT,
  image_url_back TEXT,                   -- back face of transform / modal double-faced cards
  scryfall_uri   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_name ON cards(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS cards_cmc ON cards(cmc);
CREATE INDEX IF NOT EXISTS cards_edhrec ON cards(edhrec_rank);

CREATE TABLE IF NOT EXISTS legality (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  format  TEXT NOT NULL,
  status  TEXT NOT NULL,
  PRIMARY KEY (card_id, format)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS legality_format ON legality(format, status);

-- Decks reference cards by oracle id without a foreign key: re-ingesting replaces the cards table.
CREATE TABLE IF NOT EXISTS decks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  format     TEXT NOT NULL DEFAULT 'commander',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deck_cards (
  deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  board   TEXT NOT NULL CHECK (board IN ('commander','main','sideboard')),
  qty     INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (deck_id, card_id, board)
) WITHOUT ROWID;

-- Looking up which decks use a card (the "spare copies" maths) goes by card, not by deck.
CREATE INDEX IF NOT EXISTS deck_cards_card ON deck_cards(card_id);

-- What the user owns, by oracle id (printings and foils are not distinguished). Not a foreign key: re-ingest replaces cards.
CREATE TABLE IF NOT EXISTS collection (
  card_id    TEXT PRIMARY KEY,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Extra Scryfall data: official rulings, and community "Oracle Tags" (function labels such as ramp or removal).
CREATE TABLE IF NOT EXISTS rulings (
  oracle_id    TEXT NOT NULL,
  source       TEXT NOT NULL,
  published_at TEXT NOT NULL,
  comment      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rulings_oracle ON rulings(oracle_id);
CREATE TABLE IF NOT EXISTS tags (slug TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT, cards INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tag_edges (parent TEXT NOT NULL, child TEXT NOT NULL, PRIMARY KEY (parent, child)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tag_aliases (alias TEXT PRIMARY KEY, slug TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS card_tags (card_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (card_id, tag)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS card_tags_tag ON card_tags(tag);

-- Semantic search: one int8-quantised embedding per card (hash = the text it was computed from, so edits re-embed).
CREATE TABLE IF NOT EXISTS embeddings (card_id TEXT PRIMARY KEY, hash INTEGER NOT NULL, vec BLOB NOT NULL) WITHOUT ROWID;

-- The Comprehensive Rules (downloaded from Wizards), with full-text search over rules and the glossary.
CREATE TABLE IF NOT EXISTS rule_sections (num INTEGER PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, kind TEXT NOT NULL, section INTEGER NOT NULL, parent TEXT, text TEXT NOT NULL, ord INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rules_parent ON rules(parent, ord);
CREATE TABLE IF NOT EXISTS glossary (term TEXT PRIMARY KEY COLLATE NOCASE, definition TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS rules_fts USING fts5(text, id UNINDEXED, tokenize = 'porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS glossary_fts USING fts5(term, definition, tokenize = 'porter unicode61 remove_diacritics 2');

-- Other names a card goes by (Universes Beyond printings, e.g. "Avengers Monitoring Station" is Herald's Horn), so imports and searches find it.
CREATE TABLE IF NOT EXISTS card_aliases (alias TEXT PRIMARY KEY COLLATE NOCASE, card_id TEXT NOT NULL) WITHOUT ROWID;
-- Every paper printing of every card (Scryfall's Default Cards, trimmed), so a scanned or imported card can be a specific printing.
-- Replaced wholesale by each printings update; the user's own records of printings live in collection_prints and never depend on it.
CREATE TABLE IF NOT EXISTS sets (code TEXT PRIMARY KEY, name TEXT NOT NULL, released TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS printings (
  id          TEXT PRIMARY KEY,                  -- Scryfall's id for this printing
  card_id     TEXT NOT NULL,                     -- oracle id
  set_code    TEXT NOT NULL,
  collector   TEXT NOT NULL,                     -- "21", "21★", "21a"
  released    TEXT,
  finishes    INTEGER NOT NULL DEFAULT 1,        -- bits: 1 nonfoil, 2 foil, 4 etched
  usd         REAL, usd_foil REAL, usd_etched REAL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS printings_card ON printings(card_id);
CREATE INDEX IF NOT EXISTS printings_set ON printings(set_code, collector);

-- Which printing (and finish) each owned copy is, when known. A breakdown of the collection table, which stays the total per card:
-- the copies here are always part of that total, and the rest are copies whose printing nobody has said.
CREATE TABLE IF NOT EXISTS collection_prints (
  card_id     TEXT NOT NULL,
  printing_id TEXT NOT NULL,
  finish      TEXT NOT NULL CHECK (finish IN ('nonfoil','foil','etched')),
  qty         INTEGER NOT NULL CHECK (qty > 0),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (printing_id, finish)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS collection_prints_card ON collection_prints(card_id);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * Bump when the schema or the shape of imported data changes. User data (decks, collection) lives in the same file and must
 * survive upgrades, so structural changes go through `migrate` as additive steps rather than dropping tables.
 */
export const SCHEMA_VERSION = 8;

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).some((c) => c.name === column);
}

/** Bring an existing database up to date. Every step is idempotent, so it's safe on fresh and partially upgraded files. */
export function migrate(db: Db): void {
  db.exec(SCHEMA);
  // v2: back-face images for double-faced cards.
  if (!hasColumn(db, 'cards', 'image_url_back')) db.exec('ALTER TABLE cards ADD COLUMN image_url_back TEXT');
  // v4: cheapest-printing prices.
  if (!hasColumn(db, 'cards', 'usd_min')) db.exec('ALTER TABLE cards ADD COLUMN usd_min REAL');
  if (!hasColumn(db, 'cards', 'usd_min_set')) db.exec('ALTER TABLE cards ADD COLUMN usd_min_set TEXT');
  // v8: each set's type (core, commander, promo, ...), from the printings data.
  if (!hasColumn(db, 'sets', 'kind')) db.exec('ALTER TABLE sets ADD COLUMN kind TEXT');
  const current = (db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }).user_version;
  if (current < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Run `fn` in a transaction (node:sqlite has no built-in helper). Not re-entrant. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
