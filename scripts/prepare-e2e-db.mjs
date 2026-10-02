// Copies the ingested card database to data/e2e.db so e2e tests never touch real decks.
import Database from 'better-sqlite3';
import { existsSync, rmSync } from 'node:fs';

const src = 'data/grimoire.db';
const dest = 'data/e2e.db';
if (!existsSync(src)) { console.error('Run `npm run ingest` first.'); process.exit(1); }
for (const f of [dest, `${dest}-wal`, `${dest}-shm`]) rmSync(f, { force: true });
const db = new Database(src, { readonly: true });
db.exec(`VACUUM INTO '${dest}'`);
db.close();
