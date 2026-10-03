import { dbPathFor, openDb } from './db.js';
import { DEFAULT_DATA_DIR } from './devpaths.js';
import { HashingEmbedder, SemanticIndex } from './semantic.js';
import { buildServer } from './server.js';

const dataDir = DEFAULT_DATA_DIR;
const db = openDb(dbPathFor(dataDir));
const port = Number(process.env.PORT ?? 3001);
// GRIMOIRE_FAKE_EMBEDDINGS=1 swaps the language model for a tiny hashing embedder (end-to-end tests: no 34 MB download).
const semantic = process.env.GRIMOIRE_FAKE_EMBEDDINGS
  ? new SemanticIndex({ db, dataDir, prebuiltBase: null, deps: { ensureModel: async () => {}, createEmbedder: async () => new HashingEmbedder() } })
  : undefined;
buildServer({ db, dataDir, bulkFile: process.env.GRIMOIRE_BULK_FILE, rulingsFile: process.env.GRIMOIRE_RULINGS_FILE, tagsFile: process.env.GRIMOIRE_TAGS_FILE, pricesFile: process.env.GRIMOIRE_PRICES_FILE, rulesFile: process.env.GRIMOIRE_RULES_FILE, semantic })
  .listen({ port, host: '127.0.0.1' })
  .catch((err) => { console.error(err); process.exit(1); });
