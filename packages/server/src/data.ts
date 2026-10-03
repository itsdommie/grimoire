import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { openDb, dbPathFor, type Db } from './db.js';
import { clearPrices, loadJsonl, loadPrices, loadRulings, loadTags } from './ingest.js';
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

type Kind = 'oracle_cards' | 'rulings' | 'oracle_tags' | 'default_cards';
const FILE_PREFIX: Record<Kind, string> = { oracle_cards: 'oracle-cards', rulings: 'rulings', oracle_tags: 'oracle-tags', default_cards: 'default-cards' };
const META_KEY = { rulings: 'rulings_updated_at', oracle_tags: 'tags_updated_at' } as const;
const PRICE_REFRESH_DAYS = 7;

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
  /** Cheapest-printing prices from a local Default Cards file (GRIMOIRE_PRICES_FILE). */
  localPrices?: string;
}

export interface UpdateOptions {
  /** Re-import even when Scryfall's bulk data is unchanged. */
  force?: boolean;
  /** true: turn cheapest-printing prices on and fetch them now. false: turn them off. Omitted: keep the current setting. */
  prices?: boolean;
  /** Re-download prices even if they're recent. */
  refreshPrices?: boolean;
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
  private readonly localPrices: string | undefined;
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
    this.localPrices = opts.localPrices;
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
      prices: { enabled: this.pricesEnabled(), updatedAt: this.meta('prices_updated_at') },
    };
  }

  pricesEnabled(): boolean { return this.meta('prices_enabled') === '1'; }

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
    if (opts.prices === true) this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('prices_enabled', '1')").run();
    if (opts.prices === false) this.disablePrices();
    this.progress = { phase: 'checking', item: 'cards' };
    this.running = this.update({ ...opts, file: opts.file ?? this.localFile, refreshPrices: opts.refreshPrices || opts.prices === true })
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
    if (this.pricesEnabled()) {
      try {
        if (await this.updatePrices(manifest, opts, needCards, local)) imported = true;
      } catch (err) {
        failures.push(`prices: ${err instanceof Error ? err.message : String(err)}`);
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

  /**
   * Cheapest-printing prices. The Default Cards file is ~79 MB, so it is only re-downloaded on request or once it is a week old.
   * Re-importing the card pool wipes the prices, so they are re-applied from the cached file whenever the cards change.
   */
  private async updatePrices(manifest: Record<Kind, BulkEntry> | null, opts: UpdateOptions, cardsChanged: boolean, local: boolean): Promise<boolean> {
    let file: string | undefined = this.localPrices;
    let version = 'local';
    if (!file) {
      if (local) return false;
      const entry = manifest?.default_cards;
      if (!entry?.updated_at) return false;
      const bulkDir = resolve(this.dataDir, 'bulk');
      const cached = existsSync(bulkDir) ? readdirSync(bulkDir).filter((f) => f.startsWith(`${FILE_PREFIX.default_cards}-`)).sort().at(-1) : undefined;
      const updatedAt = this.meta('prices_updated_at');
      const stale = !updatedAt || (Date.now() - Date.parse(this.meta('prices_checked_at') ?? '') > PRICE_REFRESH_DAYS * 864e5 && entry.updated_at !== updatedAt);
      const mustFetch = !cached || opts.refreshPrices || stale;
      file = mustFetch ? await this.ensureFile('default_cards', entry, 'prices') : resolve(bulkDir, cached);
      version = mustFetch ? entry.updated_at : (updatedAt ?? entry.updated_at);
      if (!mustFetch && !cardsChanged) return false; // prices are already applied to the current cards
    }
    this.progress = { phase: 'importing', item: 'prices', cards: 0 };
    const writer = openDb(dbPathFor(this.dataDir));
    try {
      await loadPrices(writer, this.lines(file), (n) => { this.progress = { phase: 'importing', item: 'prices', cards: n }; });
      const put = writer.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      put.run('prices_updated_at', version);
      put.run('prices_checked_at', new Date().toISOString());
    } finally {
      writer.close();
    }
    return true;
  }

  private disablePrices(): void {
    this.db.prepare("DELETE FROM meta WHERE key IN ('prices_enabled', 'prices_updated_at', 'prices_checked_at')").run();
    clearPrices(this.db);
    const bulkDir = resolve(this.dataDir, 'bulk');
    if (existsSync(bulkDir)) for (const f of readdirSync(bulkDir)) if (f.startsWith(`${FILE_PREFIX.default_cards}-`)) rmSync(resolve(bulkDir, f), { force: true });
  }

  private lines(file: string) {
    const raw = createReadStream(file);
    const input = file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
    return createInterface({ input, crlfDelay: Infinity });
  }

  /** Download a bulk file (unless it's already cached) and prune older downloads of the same kind. */
  private async ensureFile(kind: Kind, entry: BulkEntry, item: 'cards' | 'rulings' | 'tags' | 'prices'): Promise<string> {
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
    const absent = (type: Kind) => ({ type, updated_at: '', jsonl_download_uri: undefined }) as BulkEntry;
    return { oracle_cards: cards, rulings: find('rulings') ?? absent('rulings'), oracle_tags: find('oracle_tags') ?? absent('oracle_tags'), default_cards: find('default_cards') ?? absent('default_cards') };
  }

  private async download(url: string, dest: string, item: 'cards' | 'rulings' | 'tags' | 'prices'): Promise<void> {
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
