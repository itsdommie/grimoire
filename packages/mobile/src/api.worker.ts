import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createRouter, type DataService, type SemanticService } from '../../server/src/routes.ts';
import { migrate } from '../../server/src/schema.ts';
import { seedAliases } from '../../server/src/names.ts';
import { wrapDb, type Oo1Db } from './wasmDb.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

/**
 * The app's whole API, running inside the phone: the same router the desktop server uses, over SQLite compiled to WASM and kept
 * in the browser's private file system (OPFS). The page talks to it through bridge.ts.
 */
const DB_FILE = '/grimoire.db';
// Typed loosely on purpose: the DOM and WebWorker type libraries can't both be loaded in one project.
const ctx = self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null; location: Location };
const post = (m: FromWorker) => ctx.postMessage(m);

/** Card data arrives as a ready-made database (below), so there is nothing to download or import on the phone. */
function dataService(meta: (key: string) => string | null): DataService {
  return {
    status: () => {
      const cardCount = Number(meta('card_count') ?? 0);
      return { state: cardCount > 0 ? 'ready' : 'empty', cardCount, bulkUpdatedAt: meta('bulk_updated_at'), prices: { enabled: false, updatedAt: null }, upToDate: true };
    },
    start: () => {},
  };
}

/** Search by meaning needs the language model; not wired up on Android yet, so the UI shows it as off. */
const semanticService: SemanticService = {
  isReady: () => false,
  ensureLoaded: () => {},
  embedQuery: async () => { throw new Error('Search by meaning is not available on Android yet'); },
  rank: () => [],
  status: () => ({ state: 'off', enabled: false, indexed: 0, total: 0, pending: 0, model: '' }),
  start: () => {},
  cancel: () => {},
  remove: () => {},
};

let router: ReturnType<typeof createRouter> | null = null;

async function start(dbUrl: string): Promise<void> {
  // The package's types declare no options, but Emscripten's loader takes locateFile (it must find sqlite3.wasm next to this file).
  const init = sqlite3InitModule as unknown as (o: { locateFile(name: string): string }) => ReturnType<typeof sqlite3InitModule>;
  const sqlite3 = await init({ locateFile: (name) => new URL(name, ctx.location.href).href });
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'grimoire', initialCapacity: 6 });
  // First run: copy the bundled card database into private storage. After that it is only ever opened (the user's decks and
  // collection live in the same file, so it must never be replaced once it exists).
  if (!pool.getFileNames().includes(DB_FILE)) {
    const res = await fetch(dbUrl);
    if (!res.ok) throw new Error(`couldn't load the card database (HTTP ${res.status})`);
    await pool.importDb(DB_FILE, new Uint8Array(await res.arrayBuffer()));
  }
  const raw = new pool.OpfsSAHPoolDb(DB_FILE) as unknown as Oo1Db;
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA cache_size = -32768');
  const db = wrapDb(raw);
  migrate(db);
  seedAliases(db);
  const meta = (key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  router = createRouter({ db, data: dataService(meta), semantic: semanticService });
  post({ ready: true, cards: Number(meta('card_count') ?? 0) });
}

ctx.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if ('init' in m) {
    start(m.init.dbUrl).catch((err: unknown) => post({ fatal: err instanceof Error ? err.message : String(err) }));
    return;
  }
  try {
    if (!router) throw new Error('the card database is not ready yet');
    post({ id: m.id, res: await router(m.req) });
  } catch (err) {
    post({ id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
};
