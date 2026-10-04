import type { DataStatus } from '@grimoire/shared';
import { applyCardData, CARD_DATA_FILE, CARD_DATA_MANIFEST, type CardDataManifest } from '../../server/src/carddata.ts';
import { DATA_VERSION_FOR_UPDATES } from './dataVersion.ts';
import { SCHEMA_VERSION, type Db } from '../../server/src/schema.ts';
import type { NativeRequest, NativeResult } from './protocol.ts';
import { streamIntoPool } from './poolStream.ts';

/**
 * Card data updates for the Android app. CI publishes a compact card-data database; this downloads it, streams it (decompressing as it
 * goes) into a second file in the app's private storage, and the next start swaps it in (applyPendingCardData) before anything else
 * touches the database: the swap never runs while the app is in use. Decks and collection are not part of it.
 */
export const DEFAULT_DATA_BASE = 'https://github.com/itsdommie/grimoire/releases/download/card-data';
export const NEXT_FILE = '/card-data-next.db';
const CHECK_EVERY_DAYS = 7;

/** The bits of the SQLite WASM file-pool utility we use. */
export interface PoolFiles {
  getFileNames(): string[];
  importDb(name: string, data: () => Promise<Uint8Array | undefined>): Promise<number>;
  unlink(name: string): boolean;
}

export interface UpdaterDeps {
  db: Db;
  pool: PoolFiles;
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
  /** Ask the page to do something native; resolves with the result. Not available outside the app. */
  native: ((request: NativeRequest, onProgress?: (received: number, total: number) => void) => Promise<NativeResult>) | null;
  base: string;
  /** Mobile data or a data saver is on: the app's own check mustn't download tens of megabytes unasked. */
  metered: boolean;
  /** The page should reload (to apply the update). */
  reload(): void;
  log(message: string): void;
}

const mb = (n: number) => (n / 1e6).toFixed(0);

export class CardUpdater {
  private running: Promise<void> | null = null;
  private progress: DataStatus['progress'];
  private error: string | undefined;
  private upToDate: boolean | undefined;
  private available: { size: number } | undefined;

  constructor(private readonly d: UpdaterDeps) {}

  status(): Pick<DataStatus, 'state' | 'progress' | 'error' | 'upToDate' | 'available' | 'warning'> {
    const failed = this.d.meta('card_data_error');
    return {
      state: this.running ? 'updating' : this.error ? 'error' : 'ready',
      ...(this.progress && this.running ? { progress: this.progress } : {}),
      ...(this.error && !this.running ? { error: this.error } : {}),
      ...(this.upToDate !== undefined && !this.running ? { upToDate: this.upToDate } : {}),
      ...(this.available && !this.running ? { available: this.available } : {}),
      ...(failed && !this.running ? { warning: `The last card update couldn't be applied (${failed})` } : {}),
    };
  }

  /** Whether it is time for the app's own weekly look for an update. */
  dueForAutoCheck(): boolean {
    const at = Date.parse(this.d.meta('card_data_checked_at') ?? '');
    return !Number.isFinite(at) || Date.now() - at > CHECK_EVERY_DAYS * 864e5;
  }

  /** Check for, and (unless this is the app's own check on a metered connection) download, a card update. A second call while running is a no-op. */
  start(opts: { auto?: boolean } = {}): void {
    if (this.running) return;
    this.error = undefined; this.upToDate = undefined; this.available = undefined;
    this.progress = { phase: 'checking', item: 'cards' };
    this.running = this.run(!!opts.auto)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.auto) this.d.log(`Couldn't check for a card update: ${message}`); // the app's own weekly look stays quiet when offline
        else this.error = message;
      })
      .finally(() => { this.running = null; this.progress = undefined; });
  }

  private async run(auto: boolean): Promise<void> {
    const manifest = await this.fetchManifest();
    this.d.setMeta('card_data_checked_at', new Date().toISOString());
    if (!manifest) { this.upToDate = true; return; } // nothing published yet
    if (manifest.schema > SCHEMA_VERSION || manifest.dataVersion > DATA_VERSION_FOR_UPDATES) throw new Error('This card data needs a newer version of Grimoire. Update the app first.');
    const have = this.d.meta('bulk_updated_at');
    if (have && manifest.version <= have) { this.upToDate = true; return; }
    // The app's own check doesn't spend someone's mobile data on a big download; it says one is waiting. Asking for it yourself does.
    if (auto && this.d.metered) { this.available = { size: manifest.size }; return; }

    this.progress = { phase: 'downloading', item: 'cards', received: 0, total: manifest.size };
    const source = await this.open(manifest);
    try {
      await this.stream(source.body, manifest);
    } catch (err) {
      this.discardNext();
      throw err;
    } finally {
      await source.done();
    }
    this.d.setMeta('card_data_pending', manifest.version);
    this.progress = { phase: 'importing', item: 'cards' };
    this.d.reload(); // the next start applies it
    await new Promise<void>((r) => setTimeout(r, 30_000)); // stay "updating" until the reload happens
  }

  private async fetchManifest(): Promise<CardDataManifest | null> {
    const url = `${this.d.base}/${CARD_DATA_MANIFEST}`;
    if (this.d.native) {
      const r = await this.d.native({ op: 'text', url, name: CARD_DATA_MANIFEST });
      if (!r.ok) { if (r.status === 404) return null; throw new Error(`couldn't check for a card update (${r.error})`); }
      return JSON.parse(r.text ?? '') as CardDataManifest;
    }
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`couldn't check for a card update (HTTP ${res.status})`);
    return (await res.json()) as CardDataManifest;
  }

  /** The compressed database as a byte stream, from the app's cache (downloaded natively) or straight from the network. */
  private async open(manifest: CardDataManifest): Promise<{ body: ReadableStream<Uint8Array>; done(): Promise<void> }> {
    const url = `${this.d.base}/${manifest.file ?? CARD_DATA_FILE}`;
    if (this.d.native) {
      const r = await this.d.native({ op: 'download', url, name: CARD_DATA_FILE }, (received, total) => { this.progress = { phase: 'downloading', item: 'cards', received, total: total || manifest.size }; });
      if (!r.ok || !r.url) throw new Error(`the card data download failed (${r.ok ? 'no file' : r.error})`);
      const res = await fetch(r.url);
      if (!res.ok || !res.body) throw new Error(`couldn't read the downloaded card data (HTTP ${res.status})`);
      return { body: res.body, done: async () => { await this.d.native!({ op: 'delete', name: CARD_DATA_FILE }); } };
    }
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`the card data download failed (HTTP ${res.status})`);
    let received = 0;
    const counted = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, c) => { received += chunk.length; this.progress = { phase: 'downloading', item: 'cards', received, total: manifest.size }; c.enqueue(chunk); } }));
    return { body: counted, done: async () => {} };
  }

  /** Decompress into the second database file as the bytes arrive, so neither the compressed nor the unpacked file is ever held in memory. */
  private async stream(body: ReadableStream<Uint8Array>, manifest: CardDataManifest): Promise<void> {
    this.discardNext();
    const unpacked = body.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    const bytes = await streamIntoPool(this.d.pool, NEXT_FILE, unpacked);
    this.d.log(`Card data ${manifest.version} downloaded (${mb(bytes)} MB unpacked); it will be applied at the next start.`);
  }

  private discardNext(): void {
    if (this.d.pool.getFileNames().includes(NEXT_FILE)) this.d.pool.unlink(NEXT_FILE);
  }
}

/**
 * Called at startup, before the database is used for anything else: if an update was downloaded last time, swap it in. A failure is
 * recorded (and shown as a warning) but never stops the app: the old card data is still there.
 */
export function applyPendingCardData(d: Pick<UpdaterDeps, 'db' | 'pool' | 'meta' | 'setMeta' | 'log'>, onProgress: (message: string) => void): void {
  const pending = d.meta('card_data_pending');
  if (!pending) return;
  try {
    if (!d.pool.getFileNames().includes(NEXT_FILE)) throw new Error('the downloaded file is missing');
    onProgress('Applying the card update…');
    const { cards } = applyCardData(d.db, NEXT_FILE);
    d.db.prepare("DELETE FROM meta WHERE key = 'card_data_error'").run();
    d.log(`Applied card data ${pending} (${cards} cards).`);
  } catch (err) {
    d.setMeta('card_data_error', err instanceof Error ? err.message : String(err));
    d.log(`Couldn't apply the card update: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    d.db.prepare("DELETE FROM meta WHERE key = 'card_data_pending'").run();
    if (d.pool.getFileNames().includes(NEXT_FILE)) d.pool.unlink(NEXT_FILE);
  }
}
