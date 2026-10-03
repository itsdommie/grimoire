// Assembles the Android app's web content in dist/: the unchanged web UI, the API worker (the shared server routes over SQLite WASM),
// the bridge that sends the UI's /api calls to it, the SQLite WASM binary, and a slim copy of the card database.
// Usage: node build.mjs [--db <path to a card database>]   (default: data/grimoire.db, made with `npm run ingest`)
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../..');
const dist = resolve(here, 'dist');
const dbFlag = process.argv.indexOf('--db');
const srcDb = dbFlag >= 0 ? resolve(process.argv[dbFlag + 1]) : resolve(root, 'data/grimoire.db');
if (!existsSync(srcDb)) { console.error(`No card database at ${srcDb}. Run \`npm run ingest\` first.`); process.exit(1); }

execSync('npm run build -w @grimoire/web', { stdio: 'inherit', cwd: root });
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(resolve(root, 'packages/web/dist'), dist, { recursive: true });

const common = { bundle: true, target: 'es2022', logLevel: 'warning', sourcemap: true };
await build({ ...common, entryPoints: [resolve(here, 'src/api.worker.ts')], outfile: resolve(dist, 'api.worker.js'), format: 'esm' });
await build({ ...common, entryPoints: [resolve(here, 'src/bridge.ts')], outfile: resolve(dist, 'bridge.js'), format: 'iife' });
copyFileSync(resolve(root, 'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm'), resolve(dist, 'sqlite3.wasm'));

// The bridge must run before the app's first request, so it goes in as a classic script ahead of the module script.
const indexPath = resolve(dist, 'index.html');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('<script type="module"', '<script src="/bridge.js"></script>\n    <script type="module"'));

// A slim card database: no embeddings (semantic search isn't on Android yet), none of the developer's own decks or collection.
const out = resolve(dist, 'grimoire.db');
const full = new DatabaseSync(srcDb, { readOnly: true });
full.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
full.close();
const slim = new DatabaseSync(out);
slim.exec("DELETE FROM embeddings; DELETE FROM meta WHERE key LIKE 'semantic%'; DELETE FROM deck_cards; DELETE FROM decks; DELETE FROM collection; DELETE FROM collection_prints; PRAGMA journal_mode = DELETE; VACUUM;");
slim.close();

const mb = (f) => `${(readFileSync(resolve(dist, f)).length / 1048576).toFixed(1)} MB`;
console.log(`mobile/dist ready: grimoire.db ${mb('grimoire.db')}, api.worker.js ${mb('api.worker.js')}, ${readdirSync(dist).length} entries`);
