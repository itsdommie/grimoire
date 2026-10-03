import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createRouter, type DataService } from '../../server/src/routes.ts';
import { migrate, type Db } from '../../server/src/schema.ts';
import { seedAliases } from '../../server/src/names.ts';
import { loadPrintings, parsePrintingsFile } from '../../server/src/printings.ts';
import { wrapDb, type Oo1Db } from './wasmDb.ts';
import { createPhoneSemantic } from './semantic.ts';
import { phoneKeyStore } from './keyStore.ts';
import { keyFromEnvironment } from '../../server/src/advisor.ts';
import { cacheStore } from './modelStore.ts';
import { streamIntoPool } from './poolStream.ts';
import { applyPendingCardData, CardUpdater, DEFAULT_DATA_BASE, type PoolFiles } from './cardUpdates.ts';
import type { FromWorker, NativeRequest, NativeResult, ToWorker } from './protocol.ts';

/**
 * The app's whole API, running inside the phone: the same router the desktop server uses, over SQLite compiled to WASM and kept
 * in the browser's private file system (OPFS). The page talks to it through bridge.ts.
 */
const DB_FILE = '/grimoire.db';
// Typed loosely on purpose: the DOM and WebWorker type libraries can't both be loaded in one project.
const ctx = self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null; location: Location };
const post = (m: FromWorker) => ctx.postMessage(m);

/** Things the worker can't do itself (native downloads) are asked of the page, which answers with a message. */
const natives = new Map<number, { resolve: (r: NativeResult) => void; onProgress?: (received: number, total: number) => void }>();
let nextNative = 1;
const askNative = (request: NativeRequest, onProgress?: (received: number, total: number) => void) =>
  new Promise<NativeResult>((resolve) => { const id = nextNative++; natives.set(id, { resolve, onProgress }); post({ native: { id, request } }); });

/**
 * The card database ships inside the app, and card data updates come from CardUpdater (a downloaded update is applied at the next
 * start). Everything about the card data's state comes from the database's own meta rows, so it survives restarts.
 */
function dataService(meta: (key: string) => string | null, updater: CardUpdater): DataService {
  return {
    status: () => {
      const cardCount = Number(meta('card_count') ?? 0);
      const u = updater.status();
      return { ...u, state: cardCount > 0 ? u.state : 'empty', cardCount, bulkUpdatedAt: meta('bulk_updated_at'), prices: { enabled: false, updatedAt: null } };
    },
    start: () => updater.start(),
  };
}

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

/**
 * Open the private file store. When the page has just been reloaded, the previous worker may not have let go of its files yet, and the
 * store refuses to open until it has (measured: about half of quick reloads). It remembers a failed attempt, so each retry has to
 * say to start over. A few seconds of trying is plenty.
 */
async function installPool(sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    // (the option exists at runtime, but the package's type definitions leave it out)
    try { return await sqlite3.installOpfsSAHPoolVfs({ name: 'grimoire', initialCapacity: 10, forceReinitIfPreviouslyFailed: true } as { name: string; initialCapacity: number }); } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastError;
}

async function start(opts: { dbUrl: string; native: boolean; dataBase?: string; metered?: boolean; semanticBase?: string; modelBase?: string; advisorBase?: string }): Promise<void> {
  // The package's types declare no options, but Emscripten's loader takes locateFile (it must find sqlite3.wasm next to this file).
  const init = sqlite3InitModule as unknown as (o: { locateFile(name: string): string }) => ReturnType<typeof sqlite3InitModule>;
  const sqlite3 = await init({ locateFile: (name) => new URL(name, ctx.location.href).href });
  // Room for the database, its journal and the downloaded update waiting to be applied.
  const pool = await installPool(sqlite3);
  // First run: copy the bundled card database into private storage. After that it is only ever opened (the user's decks and
  // collection live in the same file, so it must never be replaced once it exists).
  // (If the app was closed during this copy, the next start just copies again: the file store only shows a database once its whole
  // import has finished, so a half-written one is never seen.)
  if (!pool.getFileNames().includes(DB_FILE)) {
    const res = await fetch(opts.dbUrl);
    if (!res.ok || !res.body) throw new Error(`couldn't load the card database (HTTP ${res.status})`);
    console.info('[grimoire] copying the card database into storage');
    await streamIntoPool(pool, DB_FILE, res.body);
    console.info('[grimoire] card database copied');
  }
  const raw = new pool.OpfsSAHPoolDb(DB_FILE) as unknown as Oo1Db;
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA cache_size = -32768');
  const db = wrapDb(raw);
  migrate(db);
  seedAliases(db);
  const meta = (key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  const setMeta = (key: string, value: string) => { db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value); };
  const log = (message: string) => console.info(`[grimoire] ${message}`);
  const files = pool as unknown as PoolFiles;
  // A card update downloaded last time is swapped in first, before anything else uses the database.
  applyPendingCardData({ db, pool: files, meta, setMeta, log }, (message) => post({ progress: message }));
  await loadBundledPrintings(db, meta);
  const updater = new CardUpdater({ db, pool: files, meta, setMeta, native: opts.native ? askNative : null, base: opts.dataBase ?? DEFAULT_DATA_BASE, metered: !!opts.metered, reload: () => post({ reload: true }), log });
  router = createRouter({ db, data: dataService(meta, updater), semantic: createPhoneSemantic({
      db, store: cacheStore, native: opts.native ? askNative : null, ortBase: new URL('ort/', ctx.location.href).href,
      prebuiltBase: opts.semanticBase, modelBase: opts.modelBase,
    }),
    // The advisor calls Anthropic straight from the phone (the API allows pages to, with this header) with the key held in the Keystore.
    advisor: { keys: keyFromEnvironment(await phoneKeyStore(opts.native ? askNative : null), {}), directBrowserAccess: true, baseUrl: opts.advisorBase },
  });
  post({ ready: true, cards: Number(meta('card_count') ?? 0) });
  // Once a week the app looks for a newer card database by itself (a few seconds after start, so it never slows the first screen).
  if (updater.dueForAutoCheck()) setTimeout(() => updater.start({ auto: true }), 10_000);
}

ctx.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if ('nativeResult' in m) { const n = natives.get(m.nativeResult.id); natives.delete(m.nativeResult.id); n?.resolve(m.nativeResult.result); return; }
  if ('nativeProgress' in m) { natives.get(m.nativeProgress.id)?.onProgress?.(m.nativeProgress.received, m.nativeProgress.total); return; }
  if ('init' in m) {
    start(m.init).catch((err: unknown) => post({ fatal: err instanceof Error ? err.message : String(err) }));
    return;
  }
  try {
    if (!router) throw new Error('the card database is not ready yet');
    post({ id: m.id, res: await router(m.req) });
  } catch (err) {
    post({ id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
};
