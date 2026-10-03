import { dbPathFor, openDb } from './db.js';
import { DEFAULT_DATA_DIR } from './devpaths.js';
import { DataManager } from './data.js';

const [command, ...args] = process.argv.slice(2);
if (command === 'semantic') {
  // Developer convenience: download the model and build the semantic index for the dev database.
  const { SemanticIndex } = await import('./semantic.js');
  const sdb = openDb(dbPathFor(DEFAULT_DATA_DIR));
  // --export <dir>: after building, write the pre-built index (manifest + file) for publishing. Everything is embedded locally then.
  const exportFlag = args.indexOf('--export');
  const exportDir = exportFlag >= 0 ? args[exportFlag + 1] : undefined;
  if (exportFlag >= 0 && !exportDir) { console.error('--export needs a folder'); process.exit(2); }
  const index = new SemanticIndex({ db: sdb, dataDir: DEFAULT_DATA_DIR, ...(exportDir ? { prebuiltBase: null } : {}) });
  index.start();
  const t = setInterval(() => { const p = index.status().progress; if (p) process.stdout.write(`\r${p.phase} ${p.phase === 'downloading' ? `${((p.received ?? 0) / 1e6).toFixed(1)} MB` : `${p.done ?? 0}/${p.of ?? 0}`}   `); }, 1000);
  await index.idle();
  clearInterval(t);
  const st = index.status();
  process.stdout.write('\n');
  if (st.state === 'error') { console.error(st.error); process.exit(1); }
  console.log(`Semantic index ${st.state}: ${st.indexed} of ${st.total} cards.`);
  if (exportDir) {
    if (st.state !== 'ready' || st.pending > 0) { console.error('The index is incomplete; not exporting.'); process.exit(1); }
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { manifest, data } = index.exportPrebuilt();
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(`${exportDir}/${manifest.file}`, data);
    writeFileSync(`${exportDir}/semantic-index.json`, JSON.stringify(manifest, null, 2));
    console.log(`Exported ${manifest.count} cards (${(manifest.size / 1e6).toFixed(1)} MB) to ${exportDir}`);
  }
  process.exit(0);
}
if (command === 'names') {
  // Build the alternate card names list (Universes Beyond renames etc.) from Scryfall's per-printing file.
  // --export <dir> writes card-names.json for publishing; --bundle also refreshes the snapshot shipped inside the app.
  const exportFlag = args.indexOf('--export');
  const exportDir = exportFlag >= 0 ? args[exportFlag + 1] : undefined;
  if (exportFlag >= 0 && !exportDir) { console.error('--export needs a folder'); process.exit(2); }
  const ndb = openDb(dbPathFor(DEFAULT_DATA_DIR));
  const file = await new DataManager({ dataDir: DEFAULT_DATA_DIR, db: ndb }).buildNames();
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const json = JSON.stringify(file);
  if (exportDir) { mkdirSync(exportDir, { recursive: true }); writeFileSync(`${exportDir}/card-names.json`, json); }
  if (args.includes('--bundle')) writeFileSync(new URL('./card-names.json', import.meta.url), json + '\n');
  console.log(`${file.names.length} alternate names (Scryfall ${file.version})${exportDir ? ` written to ${exportDir}` : ''}${args.includes('--bundle') ? ', bundled snapshot updated' : ''}.`);
  process.exit(0);
}
if (command !== 'ingest') {
  console.error('Usage: cli ingest [--force] [--prices] [--file <cards.jsonl[.gz]>] | cli semantic [--export <dir>] | cli names [--export <dir>] [--bundle]');
  process.exit(2);
}

const db = openDb(dbPathFor(DEFAULT_DATA_DIR));
const data = new DataManager({ dataDir: DEFAULT_DATA_DIR, db });
const fileFlag = args.indexOf('--file');
data.start({ force: args.includes('--force'), file: fileFlag >= 0 ? args[fileFlag + 1] : undefined, ...(args.includes('--prices') ? { prices: true } : {}) });

const timer = setInterval(() => {
  const p = data.status().progress;
  if (p) process.stdout.write(`\r${p.phase}${p.received ? ` ${(p.received / 1e6).toFixed(1)} MB` : ''}${p.cards ? ` ${p.cards} cards` : ''}   `);
}, 500);
await data.idle();
clearInterval(timer);
const s = data.status();
process.stdout.write('\n');
if (s.state === 'error') { console.error(s.error); process.exit(1); }
console.log(s.upToDate ? `Already up to date (${s.bulkUpdatedAt}). Use --force to re-import.` : `Loaded ${s.cardCount} cards (Scryfall bulk ${s.bulkUpdatedAt}).`);
