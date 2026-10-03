import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA_VERSION, migrate } from './schema.js';
import { seedAliases } from './names.js';

export * from './schema.js';

/** A node:sqlite connection (it satisfies `Db`, and also has `close`). */
export type NodeDb = DatabaseSync;

export const dbPathFor = (dataDir: string) => resolve(dataDir, 'grimoire.db');

/**
 * Before upgrading an existing database that holds user data, keep a copy of that data next to it, so a bad migration can never
 * cost anyone their decks. Only the three newest copies are kept.
 */
function backupBeforeMigrating(db: DatabaseSync, path: string): void {
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

export function openDb(path: string, opts: { readonly?: boolean } = {}): NodeDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const existed = path !== ':memory:' && existsSync(path);
  const db = new DatabaseSync(path, { readOnly: opts.readonly ?? false });
  if (!opts.readonly) {
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    if (existed) backupBeforeMigrating(db, path);
    migrate(db);
    seedAliases(db);
  }
  return db;
}
