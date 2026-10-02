import { dbPathFor, openDb } from './db.js';
import { DEFAULT_DATA_DIR } from './devpaths.js';
import { DataManager } from './data.js';

const [command, ...args] = process.argv.slice(2);
if (command !== 'ingest') {
  console.error('Usage: cli ingest [--force] [--file <cards.jsonl[.gz]>]');
  process.exit(2);
}

const db = openDb(dbPathFor(DEFAULT_DATA_DIR));
const data = new DataManager({ dataDir: DEFAULT_DATA_DIR, db });
const fileFlag = args.indexOf('--file');
data.start({ force: args.includes('--force'), file: fileFlag >= 0 ? args[fileFlag + 1] : undefined });

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
