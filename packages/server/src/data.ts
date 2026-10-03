import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { openDb, dbPathFor, type Db } from './db.js';
import { loadJsonl, loadRulings, loadTags } from './ingest.js';
import type { DataStatus } from '@grimoire/shared';

// Scryfall asks for a descriptive User-Agent and an Accept header on every API request.
const HEADERS = {
  'User-Agent': 'Grimoire/0.1 (open-source MTG deck lab)',
  Accept: 'application/json;q=0.9,*/*;q=0.8',
};
const MANIFEST_URL = 'https://api.scryfall.com/bulk-data';

interface BulkEntry { type: string; updated_at: string; jsonl_download_uri?: string }

/** Bump when the shape of imported data changes (e.g. a new column): existing installs then re-import from the cached bulk file. */
export const DATA_VERSION = 2;

type Kind = 'oracle_cards' | 'rulings' | 'oracle_tags';
const FILE_PREFIX: Record<Kind, string> = { oracle_cards: 'oracle-cards', rulings: 'rulings', oracle_tags: 'oracle-tags' };
const META_KEY: Record<Exclude<Kind, 'oracle_cards'>, string> = { rulings: 'rulings_updated_at', oracle_tags: 'tags_updated_at' };

export interface DataManagerOptions {
  /** Where the database and downloaded bulk files live. */
  dataDir: string;
  /** The server's main (reader) connection, used only to report status. */
  db: Db;
  fetch?: typeof fetch;
  /** Import from this local .jsonl / .jsonl.gz file instead of downloading (offline installs, tests). Set by GRIMOIRE_BULK_FILE. */
  localFile?: string;
  /** Same for the optional extras (GRIMOIRE_RULINGS_FILE, GRIMOIRE_TAGS_FILE). */
  localRulings?: string;
  localTags?: string;
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
  private readonly localRulings: string | undefined;
  private readonly localTags: string | undefined;
  private warning: string | undefined;
  private running: Promise<void> | null = null;
  private progress: DataStatus['progress'];
  private error: string | undefined;
  private upToDate: boolean | undefined;

  constructor(opts: DataManagerOptions) {
    this.dataDir = opts.dataDir;
    this.db = opts.db;
    this.fetchImpl = opts.fetch ?? fetch;
    this.localFile = opts.localFile;
    this.localRulings = opts.localRulings;
    this.localTags = opts.localTags;
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
      ...(this.warning && !this.running ? { warning: this.warning } : {}),
      ...(this.upToDate !== undefined && !this.running ? { upToDate: this.upToDate } : {}),
      ...(cardCount > 0 && this.outdated() ? { outdated: true } : {}),
    };
  }

  /** The loaded data predates this version of the app (older data shape, or extras that weren't fetched yet). */
  private outdated(): boolean {
    if (this.meta('data_version') !== String(DATA_VERSION)) return true;
    const wants = (local: string | undefined) => !this.localFile || !!local; // in local-file mode only configured extras count
    if (wants(this.localRulings) && !this.meta(META_KEY.rulings)) return true;
    if (wants(this.localTags) && !this.meta(META_KEY.oracle_tags)) return true;
    return false;
  }

  /** Start an update in the background. Returns immediately; poll `status()`. A second call while running is a no-op. */
  start(opts: UpdateOptions = {}): void {
    if (this.running) return;
    this.error = undefined;
    this.warning = undefined;
    this.upToDate = undefined;
    this.progress = { phase: 'checking', item: 'cards' };
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
    const local = !!opts.file;
    const manifest = local ? null : await this.fetchManifest();
    const cardCount = Number(this.meta('card_count') ?? 0);

    // ---- cards (required: a failure here fails the update)
    let imported = false;
    const cardsVersion = local ? `local:${new Date().toISOString()}` : manifest!.oracle_cards.updated_at;
    const needCards = local || !!opts.force || cardCount === 0 || this.meta('bulk_updated_at') !== cardsVersion || this.meta('data_version') !== String(DATA_VERSION);
    if (needCards) {
      const file = local ? opts.file! : await this.ensureFile('oracle_cards', manifest!.oracle_cards, 'cards');
      this.progress = { phase: 'importing', item: 'cards', cards: 0 };
      const writer = openDb(dbPathFor(this.dataDir)); // private writer: readers keep a consistent snapshot until commit
      try {
        const count = await loadJsonl(writer, this.lines(file), (cards) => { this.progress = { phase: 'importing', item: 'cards', cards }; });
        const put = writer.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
        put.run('bulk_updated_at', cardsVersion);
        put.run('card_count', String(count));
        put.run('data_version', String(DATA_VERSION));
        writer.exec('ANALYZE');
      } finally {
        writer.close();
      }
      imported = true;
    }

    // ---- extras (optional: failures become a warning, the card data is already usable)
    const failures: string[] = [];
    for (const kind of ['rulings', 'oracle_tags'] as const) {
      try {
        if (await this.updateExtra(kind, manifest, opts, needCards, local)) imported = true;
      } catch (err) {
        failures.push(`${kind === 'rulings' ? 'rulings' : 'card tags'}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length) this.warning = `Couldn't update ${failures.join('; ')}`;
    this.upToDate = !imported;
  }

  private async updateExtra(kind: 'rulings' | 'oracle_tags', manifest: Record<Kind, BulkEntry> | null, opts: UpdateOptions, cardsChanged: boolean, local: boolean): Promise<boolean> {
    const localPath = kind === 'rulings' ? this.localRulings : this.localTags;
    if (local && !localPath) return false; // offline/local mode with no file for this extra
    const entry = manifest?.[kind];
    if (!localPath && !entry?.updated_at) return false; // Scryfall doesn't offer this extra right now
    const version = localPath ? `local:${new Date().toISOString()}` : entry!.updated_at;
    if (!localPath && !opts.force && !cardsChanged && this.meta(META_KEY[kind]) === version) return false;
    const file = localPath ?? (await this.ensureFile(kind, entry!, kind === 'rulings' ? 'rulings' : 'tags'));
    this.progress = { phase: 'importing', item: kind === 'rulings' ? 'rulings' : 'tags' };
    const writer = openDb(dbPathFor(this.dataDir));
    try {
      if (kind === 'rulings') await loadRulings(writer, this.lines(file));
      else await loadTags(writer, this.lines(file));
      writer.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(META_KEY[kind], version);
    } finally {
      writer.close();
    }
    return true;
  }

  private lines(file: string) {
    const raw = createReadStream(file);
    const input = file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
    return createInterface({ input, crlfDelay: Infinity });
  }

  /** Download a bulk file (unless it's already cached) and prune older downloads of the same kind. */
  private async ensureFile(kind: Kind, entry: BulkEntry, item: 'cards' | 'rulings' | 'tags'): Promise<string> {
    if (!entry.jsonl_download_uri) throw new Error(`Scryfall's ${kind} bulk entry has no JSONL download`);
    const bulkDir = resolve(this.dataDir, 'bulk');
    mkdirSync(bulkDir, { recursive: true });
    const file = resolve(bulkDir, `${FILE_PREFIX[kind]}-${entry.updated_at.slice(0, 10)}.jsonl.gz`);
    if (!existsSync(file)) await this.download(entry.jsonl_download_uri, file, item);
    for (const f of readdirSync(bulkDir)) if (f.startsWith(`${FILE_PREFIX[kind]}-`) && resolve(bulkDir, f) !== file) rmSync(resolve(bulkDir, f), { force: true });
    return file;
  }

  private async fetchManifest(): Promise<Record<Kind, BulkEntry>> {
    const res = await this.fetchImpl(MANIFEST_URL, { headers: HEADERS });
    if (!res.ok) throw new Error(`Couldn't reach Scryfall (HTTP ${res.status})`);
    const body = (await res.json()) as { data: BulkEntry[] };
    const find = (type: Kind) => body.data.find((e) => e.type === type);
    const cards = find('oracle_cards');
    if (!cards) throw new Error('Scryfall bulk manifest has no Oracle Cards entry');
    // Rulings and tags are optional extras: if Scryfall ever drops one, cards still import.
    return { oracle_cards: cards, rulings: find('rulings') ?? ({ type: 'rulings', updated_at: '', jsonl_download_uri: undefined } as BulkEntry), oracle_tags: find('oracle_tags') ?? ({ type: 'oracle_tags', updated_at: '', jsonl_download_uri: undefined } as BulkEntry) };
  }

  private async download(url: string, dest: string, item: 'cards' | 'rulings' | 'tags'): Promise<void> {
    const res = await this.fetchImpl(url, { headers: HEADERS });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
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
        this.progress = { phase: 'downloading', item, received, total };
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
}
