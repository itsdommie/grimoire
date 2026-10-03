// Copies the ingested card database to data/e2e/grimoire.db so e2e tests never touch real decks.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

const src = 'data/grimoire.db';
const dir = 'data/e2e';
if (!existsSync(src)) { console.error('Run `npm run ingest` first.'); process.exit(1); }
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(src, { readOnly: true });
db.exec(`VACUUM INTO '${dir}/grimoire.db'`);
db.close();
// The dev database may hold real embeddings; e2e tests use a fake embedder, so start from a clean slate.
const copy = new DatabaseSync(`${dir}/grimoire.db`);
copy.exec("DELETE FROM embeddings; DELETE FROM meta WHERE key LIKE 'semantic%'; VACUUM;");
copy.close();
