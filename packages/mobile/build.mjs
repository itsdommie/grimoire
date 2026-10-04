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
// The Google client for sync sign-in on the phone (a "Web application" client in the Google Cloud project: the sign-in comes back through
// the website's redirect page). Put in by the release build from its secrets; empty in a local build, where the app then offers no sync.
// (Google treats an app's client secret as not confidential: it cannot be kept secret in a program people install.)
const google = { __GOOGLE_CLIENT_ID__: JSON.stringify(process.env.GOOGLE_ANDROID_CLIENT_ID ?? ''), __GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.GOOGLE_ANDROID_CLIENT_SECRET ?? '') };
await build({ ...common, define: google, entryPoints: [resolve(here, 'src/api.worker.ts')], outfile: resolve(dist, 'api.worker.js'), format: 'esm' });
await build({ ...common, entryPoints: [resolve(here, 'src/bridge.ts')], outfile: resolve(dist, 'bridge.js'), format: 'iife' });
copyFileSync(resolve(root, 'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm'), resolve(dist, 'sqlite3.wasm'));

// The bridge must run before the app's first request, so it goes in as a classic script ahead of the module script.
const indexPath = resolve(dist, 'index.html');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('<script type="module"', '<script src="/bridge.js"></script>\n    <script type="module"'));

// onnxruntime-web for search by meaning: the WASM-only loader, its worker script and the engine (loaded only when the feature is used).
const ortSrc = resolve(root, 'node_modules/onnxruntime-web/dist');
mkdirSync(resolve(dist, 'ort'), { recursive: true });
for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) copyFileSync(resolve(ortSrc, f), resolve(dist, 'ort', f));

// A slim card database: no embeddings (the app downloads a ready-made index when search by meaning is turned on), none of the developer's own decks or collection.
const out = resolve(dist, 'grimoire.db');
const full = new DatabaseSync(srcDb, { readOnly: true });
full.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
full.close();
const slim = new DatabaseSync(out);
// Printings travel as a separate compact file (the same format the app downloads on the desktop), loaded by the app at startup when its copy is
// missing or older than this one: that way an app update brings new printing data to an existing install, and there is one code path.
const printingRows = slim.prepare("SELECT id, card_id, set_code, collector, finishes, COALESCE(usd, 0), COALESCE(usd_foil, 0), COALESCE(usd_etched, 0), COALESCE(released, '') FROM printings").all().map((r) => Object.values(r));
const printingSets = slim.prepare('SELECT code, name, COALESCE(released, \'\'), COALESCE(kind, \'\') FROM sets').all().map((r) => Object.values(r));
const printingsVersion = slim.prepare("SELECT value FROM meta WHERE key = 'printings_version'").get()?.value ?? 'none';
const printingsFormat = Number(slim.prepare("SELECT value FROM meta WHERE key = 'printings_format'").get()?.value ?? 1);
slim.exec("DELETE FROM printings; DELETE FROM sets; DELETE FROM meta WHERE key LIKE 'printings%';");
// Everything the user made. (Only the tables that exist: a developer database from before a table was added does not have it yet, and the app creates it.)
const userTables = ['deck_cards', 'decks', 'collection', 'collection_prints', 'wishlist', 'price_history', 'sync_tombstones'];
for (const t of userTables) if (slim.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) slim.exec(`DELETE FROM ${t};`);
slim.exec("DELETE FROM embeddings; DELETE FROM meta WHERE key LIKE 'semantic%'; PRAGMA journal_mode = DELETE; VACUUM;");
slim.close();

// Plain JSON, not .gz: Android's asset packager strips a .gz extension, and the APK compresses the file anyway.
writeFileSync(resolve(dist, 'card-printings.json'), JSON.stringify({ version: printingsVersion, format: printingsFormat, sets: printingSets, rows: printingRows }));
writeFileSync(resolve(dist, 'bundled.json'), JSON.stringify({ printings: printingsVersion, printingsFormat, appVersion: JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')).version }));

const mb = (f) => `${(readFileSync(resolve(dist, f)).length / 1048576).toFixed(1)} MB`;
console.log(`mobile/dist ready: grimoire.db ${mb('grimoire.db')}, card-printings.json ${mb('card-printings.json')} (${printingRows.length} printings), api.worker.js ${mb('api.worker.js')}, ${readdirSync(dist).length} entries`);
