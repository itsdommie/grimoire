import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CARD_DATA_FILE, CARD_DATA_MANIFEST, CARD_DATA_TABLES, CARD_DATA_META, type CardDataManifest } from './carddata.js';
import { DATA_VERSION } from './data.js';
import { SCHEMA_VERSION } from './schema.js';

/**
 * Make the file the Android app downloads from a fully ingested database (Node only; CI and `cli carddata`): a copy holding just the
 * card tables, without indexes (the app keeps its own, so they would only add download size) or any of the user's data.
 */
export function buildCardData(sourceDb: string, outDir: string, opts: { minCards?: number } = {}): CardDataManifest {
  mkdirSync(outDir, { recursive: true });
  const work = resolve(outDir, 'card-data.db');
  rmSync(work, { force: true });
  const src = new DatabaseSync(sourceDb, { readOnly: true });
  src.exec(`VACUUM INTO '${work.replace(/'/g, "''")}'`);
  src.close();

  const db = new DatabaseSync(work);
  const keep = new Set<string>([...CARD_DATA_TABLES, 'rules_fts', 'glossary_fts', 'meta']);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
  for (const t of tables) {
    if (keep.has(t) || t.startsWith('rules_fts_') || t.startsWith('glossary_fts_') || t === 'sqlite_sequence' || t.startsWith('sqlite_stat')) continue;
    db.exec(`DROP TABLE "${t}"`); // the user's tables and the semantic embeddings
  }
  for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as Array<{ name: string }>) db.exec(`DROP INDEX "${r.name}"`);
  db.exec(`DELETE FROM meta WHERE key NOT IN (${CARD_DATA_META.map((k) => `'${k}'`).join(', ')})`);
  const meta = (key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const version = meta('bulk_updated_at');
  const cards = Number(meta('card_count') ?? 0);
  if (!version || cards < (opts.minCards ?? 1000)) throw new Error('The source database has no card data. Run `npm run ingest` first.');
  db.exec('VACUUM');
  db.close();

  const gz = gzipSync(readFileSync(work), { level: 9 });
  writeFileSync(resolve(outDir, CARD_DATA_FILE), gz);
  rmSync(work, { force: true });
  const manifest: CardDataManifest = { version, dataVersion: DATA_VERSION, schema: SCHEMA_VERSION, cards, file: CARD_DATA_FILE, size: gz.length };
  writeFileSync(resolve(outDir, CARD_DATA_MANIFEST), JSON.stringify(manifest));
  return manifest;
}
