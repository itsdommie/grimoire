import { dbPathFor, openDb } from './db.js';
import { DEFAULT_DATA_DIR } from './devpaths.js';
import { buildServer } from './server.js';

const dataDir = DEFAULT_DATA_DIR;
const port = Number(process.env.PORT ?? 3001);
buildServer({ db: openDb(dbPathFor(dataDir)), dataDir, bulkFile: process.env.GRIMOIRE_BULK_FILE, rulingsFile: process.env.GRIMOIRE_RULINGS_FILE, tagsFile: process.env.GRIMOIRE_TAGS_FILE })
  .listen({ port, host: '127.0.0.1' })
  .catch((err) => { console.error(err); process.exit(1); });
