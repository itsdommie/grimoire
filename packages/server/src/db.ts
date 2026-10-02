import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;

/** Development default: <repo>/data. The desktop app passes the per-user app-data directory instead. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_DATA_DIR = process.env.GRIMOIRE_DATA_DIR ?? resolve(repoRoot, 'data');
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
  usd            REAL,
  image_url      TEXT,
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

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function openDb(path = dbPathFor(DEFAULT_DATA_DIR), opts: { readonly?: boolean } = {}): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly: opts.readonly ?? false });
  if (!opts.readonly) {
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
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
