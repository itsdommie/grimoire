import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type Db = DatabaseSync;

export const dbPathFor = (dataDir: string) => resolve(dataDir, 'grimoire.db');

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

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * Bump when the schema or the shape of imported data changes. User data (decks, collection) lives in the same file and must
 * survive upgrades, so structural changes go through `migrate` as additive steps rather than dropping tables.
 */
export const SCHEMA_VERSION = 4;

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
  const current = (db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }).user_version;
  if (current < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * Before upgrading an existing database that holds user data, keep a copy of that data next to it, so a bad migration can never
 * cost anyone their decks. Only the three newest copies are kept.
 */
function backupBeforeMigrating(db: Db, path: string): void {
  const version = (db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }).user_version;
  if (version >= SCHEMA_VERSION) return;
  const hasUserData = ['decks', 'collection'].some((t) => {
    try { return !!db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get(); } catch { return false; }
  });
  if (!hasUserData) return;
  const dir = resolve(dirname(path), 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = resolve(dir, `user-data-before-v${SCHEMA_VERSION}-${stamp}.db`).replace(/'/g, "''");
  // Only the user's own tables: card data is re-downloadable and would make every copy ~100 MB.
  db.exec(`ATTACH DATABASE '${file}' AS bak`);
  try {
    for (const t of ['decks', 'deck_cards', 'collection']) {
      try { db.exec(`CREATE TABLE bak.${t} AS SELECT * FROM main.${t}`); } catch { /* table didn't exist in this old version */ }
    }
  } finally {
    db.exec('DETACH DATABASE bak');
  }
  const old = readdirSync(dir).filter((f) => f.startsWith('user-data-before-')).sort().slice(0, -3);
  for (const f of old) rmSync(resolve(dir, f), { force: true });
}

export function openDb(path: string, opts: { readonly?: boolean } = {}): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const existed = path !== ':memory:' && existsSync(path);
  const db = new DatabaseSync(path, { readOnly: opts.readonly ?? false });
  if (!opts.readonly) {
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    if (existed) backupBeforeMigrating(db, path);
    migrate(db);
  }
  return db;
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
