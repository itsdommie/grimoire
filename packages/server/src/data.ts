import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { openDb, dbPathFor, type Db } from './db.js';
import { loadJsonl } from './ingest.js';
import type { DataStatus } from '@grimoire/shared';

// Scryfall asks for a descriptive User-Agent and an Accept header on every API request.
const HEADERS = {
  'User-Agent': 'Grimoire/0.1 (open-source MTG deck lab)',
  Accept: 'application/json;q=0.9,*/*;q=0.8',
};
const MANIFEST_URL = 'https://api.scryfall.com/bulk-data';

interface BulkEntry { type: string; updated_at: string; jsonl_download_uri?: string }

export interface DataManagerOptions {
  /** Where the database and downloaded bulk files live. */
  dataDir: string;
  /** The server's main (reader) connection, used only to report status. */
  db: Db;
  fetch?: typeof fetch;
  /** Import from this local .jsonl / .jsonl.gz file instead of downloading (offline installs, tests). Set by GRIMOIRE_BULK_FILE. */
  localFile?: string;
}

export interface UpdateOptions {
  /** Re-import even when Scryfall's bulk data is unchanged. */
  force?: boolean;
  /** Import from a local .jsonl / .jsonl.gz file instead of downloading (offline installs, tests). */
  file?: string;
}

export class DataManager {
  private readonly dataDir: string;
  private readonly db: Db;
  private readonly fetchImpl: typeof fetch;
  private readonly localFile: string | undefined;
  private running: Promise<void> | null = null;
  private progress: DataStatus['progress'];
  private error: string | undefined;
  private upToDate: boolean | undefined;

  constructor(opts: DataManagerOptions) {
    this.dataDir = opts.dataDir;
    this.db = opts.db;
    this.fetchImpl = opts.fetch ?? fetch;
    this.localFile = opts.localFile;
  }

  private meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  status(): DataStatus {
    const cardCount = Number(this.meta('card_count') ?? 0);
    const state: DataStatus['state'] = this.running ? 'updating' : this.error ? 'error' : cardCount > 0 ? 'ready' : 'empty';
    return {
      state,
      cardCount,
      bulkUpdatedAt: this.meta('bulk_updated_at'),
      ...(this.progress && this.running ? { progress: this.progress } : {}),
      ...(this.error && !this.running ? { error: this.error } : {}),
      ...(this.upToDate !== undefined && !this.running ? { upToDate: this.upToDate } : {}),
    };
  }

  /** Start an update in the background. Returns immediately; poll `status()`. A second call while running is a no-op. */
  start(opts: UpdateOptions = {}): void {
    if (this.running) return;
    this.error = undefined;
    this.upToDate = undefined;
    this.progress = { phase: 'checking' };
    this.running = this.update({ ...opts, file: opts.file ?? this.localFile })
      .catch((err: unknown) => { this.error = err instanceof Error ? err.message : String(err); })
      .finally(() => { this.running = null; this.progress = undefined; });
  }

  /** Resolves when the current update (if any) has finished. */
  async idle(): Promise<void> {
    await this.running;
  }

  private async update(opts: UpdateOptions): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
    let file: string;
    let version: string;

    if (opts.file) {
      file = opts.file;
      version = `local:${new Date().toISOString()}`;
    } else {
      const entry = await this.fetchManifest();
      version = entry.updated_at;
      if (this.meta('bulk_updated_at') === version && !opts.force && Number(this.meta('card_count') ?? 0) > 0) {
        this.upToDate = true;
        return;
      }
      if (!entry.jsonl_download_uri) throw new Error('Scryfall bulk manifest has no JSONL download');
      const bulkDir = resolve(this.dataDir, 'bulk');
      mkdirSync(bulkDir, { recursive: true });
      file = resolve(bulkDir, `oracle-cards-${version.slice(0, 10)}.jsonl.gz`);
      if (!existsSync(file)) await this.download(entry.jsonl_download_uri, file);
    }

    this.progress = { phase: 'importing', cards: 0 };
    // A private writer connection: readers on the main connection keep a consistent snapshot until commit.
    const writer = openDb(dbPathFor(this.dataDir));
    try {
      const raw = createReadStream(file);
      const input = file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
      const lines = createInterface({ input, crlfDelay: Infinity });
      const count = await loadJsonl(writer, lines, (cards) => { this.progress = { phase: 'importing', cards }; });
      const put = writer.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      put.run('bulk_updated_at', version);
      put.run('card_count', String(count));
      writer.exec('ANALYZE');
    } finally {
      writer.close();
    }
    this.upToDate = false;
    if (!opts.file) this.pruneBulk(file);
  }

  private async fetchManifest(): Promise<BulkEntry> {
    const res = await this.fetchImpl(MANIFEST_URL, { headers: HEADERS });
    if (!res.ok) throw new Error(`Couldn't reach Scryfall (HTTP ${res.status})`);
    const body = (await res.json()) as { data: BulkEntry[] };
    const entry = body.data.find((e) => e.type === 'oracle_cards');
    if (!entry) throw new Error('Scryfall bulk manifest has no Oracle Cards entry');
    return entry;
  }

  private async download(url: string, dest: string): Promise<void> {
    const res = await this.fetchImpl(url, { headers: HEADERS });
    if (!res.ok || !res.body) throw new Error(`Card data download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || undefined;
    const tmp = `${dest}.part`;
    const out = createWriteStream(tmp);
    let received = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        this.progress = { phase: 'downloading', received, total };
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
      await new Promise<void>((resolveEnd, reject) => { out.once('error', reject); out.end(resolveEnd); });
    } catch (err) {
      out.destroy();
      rmSync(tmp, { force: true });
      throw err;
    }
    renameSync(tmp, dest);
  }

  /** Delete older bulk downloads so they don't pile up (each is ~25 MB). */
  private pruneBulk(keep: string): void {
    const dir = resolve(this.dataDir, 'bulk');
    for (const f of readdirSync(dir)) {
      const p = resolve(dir, f);
      if (p !== keep) rmSync(p, { force: true });
    }
  }
}
