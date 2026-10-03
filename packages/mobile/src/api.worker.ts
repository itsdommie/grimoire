import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createRouter, type DataService, type SemanticService } from '../../server/src/routes.ts';
import { migrate, type Db } from '../../server/src/schema.ts';
import { seedAliases } from '../../server/src/names.ts';
import { loadPrintings, parsePrintingsFile } from '../../server/src/printings.ts';
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

/**
 * The app ships every printing as a compact file next to the card database. Load it when this install has none, or an older one, so
 * a fresh install and an app update both end up with current printings, offline. (Versions are ISO dates, so they compare as text.)
 */
async function loadBundledPrintings(db: Db, meta: (key: string) => string | null): Promise<void> {
  const res = await fetch(new URL('bundled.json', ctx.location.href));
  if (!res.ok) return;
  const bundled = (await res.json()) as { printings?: string };
  const have = meta('printings_version');
  if (!bundled.printings || bundled.printings === 'none' || (have && have !== 'none' && have >= bundled.printings)) return;
  post({ progress: 'Loading card printings… (once per update)' });
  const file = await fetch(new URL('card-printings.json', ctx.location.href));
  if (!file.ok) throw new Error(`couldn't load the card printings (HTTP ${file.status})`);
  loadPrintings(db, parsePrintingsFile(await file.text()));
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('printings_version', ?)").run(bundled.printings);
}

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
    // Streamed straight into storage, so the whole 100+ MB file is never held in memory (phones don't have much to spare).
    const reader = res.body!.getReader();
    let held: Uint8Array = new Uint8Array(0);
    await pool.importDb(DB_FILE, async () => {
      // The first chunk must hold the database header, so make sure it is at least a page before handing anything over.
      while (held.length < 4096) {
        const { done, value } = await reader.read();
        if (done) break;
        const next = new Uint8Array(held.length + value.length);
        next.set(held); next.set(value, held.length);
        held = next;
      }
      if (held.length === 0) return undefined;
      const chunk = held;
      held = new Uint8Array(0);
      return chunk;
    });
  }
  const raw = new pool.OpfsSAHPoolDb(DB_FILE) as unknown as Oo1Db;
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA cache_size = -32768');
  const db = wrapDb(raw);
  migrate(db);
  seedAliases(db);
  const meta = (key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  await loadBundledPrintings(db, meta);
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
