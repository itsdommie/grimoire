import { WordPieceTokenizer, type SemanticStatus } from '@grimoire/shared';
import type { IndexRow } from './semantic-index-format.js';
import type { Db } from './schema.js';
import { transaction } from './schema.js';

// The platform-neutral half of semantic search (no node: imports, so the Android worker can bundle it). The desktop's file storage and
// Node-side model loading are in semantic.ts; the phone's are in packages/mobile.
// Semantic search: BGE-small embeddings of every card, computed locally with onnxruntime-web (WASM, no native modules),
// stored as int8 vectors in SQLite and scored by brute-force dot product (35k x 384 is ~15 ms).
// The model is downloaded once from Hugging Face, pinned to an exact revision and checked against a SHA-256.

const REV = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
const BASE = `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/${REV}`;

export interface ModelFile { name: string; url: string; size: number; sha256: string }
export interface ModelSpec {
  id: string;
  dir: string;
  dims: number;
  files: ModelFile[];
  queryPrefix: string;
  maxDocTokens: number;
  maxQueryTokens: number;
}

export const MODEL: ModelSpec = {
  id: 'bge-small-en-v1.5-q8',
  dir: 'bge-small-en-v1.5',
  dims: 384,
  files: [
    { name: 'model.onnx', url: `${BASE}/onnx/model_quantized.onnx`, size: 34014426, sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4' },
    { name: 'tokenizer.json', url: `${BASE}/tokenizer.json`, size: 711396, sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66' },
  ],
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  maxDocTokens: 128,
  maxQueryTokens: 64,
};

import { NOT_SET_UP } from './messages.js';
export { NOT_SET_UP };

// ----------------------------------------------------------------- embedders

export interface Embedder {
  /** Unit-length vectors, one per text. Queries get the model's retrieval prefix. */
  embed(texts: string[], kind: 'doc' | 'query'): Promise<Float32Array[]>;
  close(): Promise<void> | void;
}

export interface OrtLike {
  env: { wasm: { numThreads: number; wasmPaths?: string | { mjs?: string; wasm?: string }; wasmBinary?: Uint8Array } };
  InferenceSession: { create(model: Uint8Array, opts: { executionProviders: string[] }): Promise<OrtSession> };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}
export interface OrtSession { run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>; release?(): Promise<void> }

export class OrtEmbedder implements Embedder {
  protected constructor(private readonly ort: OrtLike, private readonly session: OrtSession, private readonly tokenizer: WordPieceTokenizer, private readonly spec: ModelSpec) {}

  /** Build an embedder from an already loaded onnxruntime-web module and the model's files. */
  static async fromBytes(ort: OrtLike, model: Uint8Array, tokenizerJson: string, spec: ModelSpec = MODEL): Promise<OrtEmbedder> {
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    return new OrtEmbedder(ort, session, WordPieceTokenizer.fromTokenizerJson(tokenizerJson), spec);
  }

  async embed(texts: string[], kind: 'doc' | 'query'): Promise<Float32Array[]> {
    const maxLen = kind === 'doc' ? this.spec.maxDocTokens : this.spec.maxQueryTokens;
    const encoded = texts.map((t) => this.tokenizer.encode(kind === 'query' ? this.spec.queryPrefix + t : t, maxLen));
    const L = Math.max(...encoded.map((e) => e.length));
    const n = texts.length;
    const ids = new BigInt64Array(n * L), mask = new BigInt64Array(n * L), types = new BigInt64Array(n * L);
    encoded.forEach((e, i) => e.forEach((id, j) => { ids[i * L + j] = BigInt(id); mask[i * L + j] = 1n; }));
    const T = (data: BigInt64Array) => new this.ort.Tensor('int64', data, [n, L]);
    const out = await this.session.run({ input_ids: T(ids), attention_mask: T(mask), token_type_ids: T(types) });
    const hidden = out.last_hidden_state!;
    const D = hidden.dims[2]!;
    return Array.from({ length: n }, (_, i) => {
      const v = new Float32Array(D); // CLS pooling, then L2 normalise
      let norm = 0;
      for (let d = 0; d < D; d++) { const x = hidden.data[i * L * D + d]!; v[d] = x; norm += x * x; }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < D; d++) v[d] = v[d]! / norm;
      return v;
    });
  }

  async close(): Promise<void> { await this.session.release?.(); }
}

// ------------------------------------------------------------------ the index

export interface SemanticDeps {
  /** Make sure the model files are available (downloading and verifying them if needed). `cancelled()` says whether the user gave up. */
  ensureModel(report: (received: number, total: number) => void, cancelled: () => boolean): Promise<void>;
  createEmbedder(): Promise<Embedder>;
  /**
   * The published pre-built index, downloaded and verified, as rows (null when it isn't available: offline, no such file, corrupt). This
   * is only a shortcut: whatever it doesn't cover is embedded locally.
   */
  loadPrebuilt(report: (received: number, total: number) => void, cancelled: () => boolean): Promise<IndexRow[] | null>;
  /** Delete the downloaded model. */
  removeModel(): void | Promise<void>;
}

export interface SemanticCoreOptions {
  db: Db;
  deps: SemanticDeps;
  spec?: ModelSpec;
  /** Free the model's memory after this many idle ms (default 10 minutes). */
  idleMs?: number;
  /**
   * Refuse to embed more than this many cards on this device (set on phones, where thousands would take hours): the setup then fails
   * with a message to try again later instead. Unset, everything missing is embedded locally.
   */
  maxLocalEmbeds?: number;
}

const fnv1a = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const NOISE = "('activated-ability','triggered-ability','alliteration','namesake-spell','single-english-word-name','unique-type-line','intervening-if-clause','french-vanilla','virtual-vanilla','virtual-french-vanilla','drawback','delayed-trigger','cast-trigger-you','repeatable-crime','cheaper-than-mv','more-expensive-than-mv','alternative-cost','multiple-targets')";

export class SemanticIndexCore {
  protected readonly db: Db;
  protected readonly spec: ModelSpec;
  private readonly deps: SemanticDeps;
  private readonly maxLocalEmbeds: number | undefined;
  private readonly idleMs: number;
  private running: Promise<void> | null = null;
  private cancelled = false;
  private progress: SemanticStatus['progress'];
  private error: string | undefined;
  private matrix: Int8Array | null = null;
  private ids: string[] = [];
  private idIndex = new Map<string, number>();
  private embedder: Embedder | null = null;
  private embedderPromise: Promise<Embedder> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCache: { key: string; value: number } | null = null;

  constructor(opts: SemanticCoreOptions) {
    this.db = opts.db;
    this.spec = opts.spec ?? MODEL;
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.deps = opts.deps;
    this.maxLocalEmbeds = opts.maxLocalEmbeds;
  }

  protected meta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }
  protected setMeta(key: string, value: string) { this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value); }
  private count(table: string) { return (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n; }

  get enabled(): boolean { return this.meta('semantic_enabled') === '1'; }
  /** True when a query can be answered right now. */
  isReady(): boolean { return this.enabled && !this.running && this.matrix !== null && this.ids.length > 0; }

  // ------------------------------------------------------------- documents

  /** The text a card is embedded as: name, types, rules text and its human-curated function tags. */
  protected documents(): Array<{ id: string; doc: string; hash: number }> {
    // The pre-built index is only usable if every machine writes the same text for a card, so the order here must not depend on
    // anything that drifts (tag counts change daily): pick the 8 most used tags, then list them alphabetically.
    const tags = new Map<string, string[]>();
    for (const r of this.db.prepare(`SELECT ct.card_id AS id, t.label AS label FROM card_tags ct JOIN tags t ON t.slug = ct.tag
        WHERE t.cards >= 25 AND t.slug NOT LIKE 'cycle-%' AND t.slug NOT IN ${NOISE} ORDER BY t.cards DESC, t.slug`).all() as unknown as Array<{ id: string; label: string }>) {
      const l = tags.get(r.id) ?? [];
      if (l.length < 8) { l.push(r.label); tags.set(r.id, l); }
    }
    for (const l of tags.values()) l.sort();
    return (this.db.prepare('SELECT id, name, type_line, oracle_text FROM cards').all() as unknown as Array<{ id: string; name: string; type_line: string; oracle_text: string }>).map((c) => {
      const t = tags.get(c.id);
      const doc = `${c.name}. ${c.type_line}. ${c.oracle_text.replace(/\s*\n\s*/g, ' ')}${t ? ` Tags: ${t.join(', ')}.` : ''}`;
      return { id: c.id, doc, hash: fnv1a(doc) };
    });
  }

  private pendingDocs(): Array<{ id: string; doc: string; hash: number }> {
    const have = new Map((this.db.prepare('SELECT card_id, hash FROM embeddings').all() as unknown as Array<{ card_id: string; hash: number }>).map((r) => [r.card_id, r.hash]));
    return this.documents().filter((d) => have.get(d.id) !== d.hash);
  }

  // ---------------------------------------------------------------- status

  status(): SemanticStatus {
    const enabled = this.enabled;
    const indexed = this.count('embeddings');
    const total = this.count('cards');
    let pending = indexed === 0 ? total : 0;
    if (!this.running && enabled && indexed > 0) {
      const key = `${this.meta('bulk_updated_at')}|${this.meta('tags_updated_at')}|${indexed}`;
      if (this.pendingCache?.key !== key) this.pendingCache = { key, value: this.pendingDocs().length };
      pending = this.pendingCache.value;
    }
    const state: SemanticStatus['state'] = this.running
      ? (this.progress?.phase === 'downloading' ? 'downloading' : 'building')
      : this.error ? 'error' : enabled && indexed > 0 ? 'ready' : 'off';
    return {
      state, enabled, indexed, total, pending, model: this.spec.id,
      ...(this.progress && this.running ? { progress: this.progress } : {}),
      ...(this.error && !this.running ? { error: this.error } : {}),
    };
  }

  // ----------------------------------------------------------------- build

  /** Turn semantic search on (or bring the index up to date): download the model if needed, then embed new/changed cards. */
  start(): void {
    if (this.running) return;
    this.cancelled = false;
    this.error = undefined;
    this.setMeta('semantic_enabled', '1');
    this.progress = { phase: 'downloading' };
    this.running = this.build()
      .catch((err: unknown) => { this.error = err instanceof Error ? err.message : String(err); })
      .finally(() => { this.running = null; this.progress = undefined; this.pendingCache = null; });
  }

  async idle(): Promise<void> { await this.running; }

  cancel(): void { this.cancelled = true; }

  private async build(): Promise<void> {
    if (this.meta('semantic_model') !== this.spec.id) {
      this.db.exec('DELETE FROM embeddings');
      this.matrix = null; this.ids = []; this.idIndex.clear();
      this.setMeta('semantic_model', this.spec.id);
    }
    await this.deps.ensureModel((received, total) => { this.progress = { phase: 'downloading', received, total }; }, () => this.cancelled);
    if (this.cancelled) return;

    if (this.count('embeddings') < this.count('cards') * 0.75) await this.usePrebuilt();
    if (this.cancelled) return;
    const embedder = await this.getEmbedder();
    const pending = this.pendingDocs().sort((a, b) => a.doc.length - b.doc.length); // similar lengths per batch = little padding = fast
    const stale = new Set((this.db.prepare('SELECT card_id FROM embeddings').all() as unknown as Array<{ card_id: string }>).map((r) => r.card_id));
    for (const c of this.db.prepare('SELECT id FROM cards').all() as unknown as Array<{ id: string }>) stale.delete(c.id);
    if (stale.size) transaction(this.db, () => { const del = this.db.prepare('DELETE FROM embeddings WHERE card_id = ?'); for (const id of stale) del.run(id); });

    const BATCH = 32;
    const put = this.db.prepare('INSERT OR REPLACE INTO embeddings (card_id, hash, vec) VALUES (?, ?, ?)');
    if (this.maxLocalEmbeds !== undefined && pending.length > this.maxLocalEmbeds) {
      throw new Error(`Couldn't download the ready-made card index, and indexing ${pending.length.toLocaleString()} cards on this device would take too long. Check your connection and try again.`);
    }
    this.progress = { phase: 'building', done: 0, of: pending.length };
    for (let i = 0; i < pending.length && !this.cancelled; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const vecs = await embedder.embed(batch.map((b) => b.doc), 'doc');
      transaction(this.db, () => batch.forEach((b, k) => put.run(b.id, b.hash, quantise(vecs[k]!))));
      this.progress = { phase: 'building', done: Math.min(i + BATCH, pending.length), of: pending.length };
    }
    this.loadMatrix();
    this.scheduleIdle();
  }

  /** Keep every row of the published pre-built index whose card text matches ours exactly; the rest is embedded locally afterwards. */
  private async usePrebuilt(): Promise<void> {
    try {
      const rows = await this.deps.loadPrebuilt((received, total) => { this.progress = { phase: 'downloading', received, total, what: 'index' }; }, () => this.cancelled);
      if (!rows || this.cancelled) return;
      const ours = new Map(this.documents().map((d) => [d.id, d.hash]));
      const put = this.db.prepare('INSERT OR REPLACE INTO embeddings (card_id, hash, vec) VALUES (?, ?, ?)');
      transaction(this.db, () => { for (const r of rows) if (ours.get(r.id) === r.hash) put.run(r.id, r.hash, r.vec); });
      this.pendingCache = null;
    } catch {
      /* the file was unusable: fall back to computing everything locally */
    }
  }

  private loadMatrix(): void {
    const D = this.spec.dims;
    const rows = this.db.prepare('SELECT card_id, vec FROM embeddings').all() as unknown as Array<{ card_id: string; vec: Uint8Array }>;
    this.ids = rows.map((r) => r.card_id);
    this.idIndex = new Map(this.ids.map((id, i) => [id, i]));
    this.matrix = new Int8Array(rows.length * D);
    rows.forEach((r, i) => this.matrix!.set(new Int8Array(r.vec.buffer, r.vec.byteOffset, D), i * D));
  }

  // --------------------------------------------------------------- queries

  /** Load the vectors if a previous session built them (called lazily by the first search). */
  ensureLoaded(): void {
    if (!this.matrix && this.enabled && this.count('embeddings') > 0) this.loadMatrix();
  }

  private async getEmbedder(): Promise<Embedder> {
    if (this.embedder) return this.embedder;
    this.embedderPromise ??= this.deps.createEmbedder().then((e) => { this.embedder = e; return e; }).finally(() => { this.embedderPromise = null; });
    return this.embedderPromise;
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { const e = this.embedder; this.embedder = null; void e?.close(); }, this.idleMs);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const embedder = await this.getEmbedder();
    const [v] = await embedder.embed([text], 'query');
    this.scheduleIdle();
    return v!;
  }

  /** Cosine similarity of a query vector against the given cards (cards without an embedding score as -1, i.e. last). */
  rank(queryVector: Float32Array, ids: readonly string[]): Array<{ id: string; score: number }> {
    this.ensureLoaded();
    const D = this.spec.dims;
    const m = this.matrix;
    return ids.map((id) => {
      const row = this.idIndex.get(id);
      if (row === undefined || !m) return { id, score: -1 };
      let dot = 0;
      const base = row * D;
      for (let d = 0; d < D; d++) dot += m[base + d]! * queryVector[d]!;
      return { id, score: dot / 127 };
    });
  }

  /** Turn semantic search off and delete the index and the model. */
  remove(): void {
    this.cancelled = true;
    this.db.exec('DELETE FROM embeddings');
    this.db.prepare("DELETE FROM meta WHERE key IN ('semantic_enabled', 'semantic_model')").run();
    this.matrix = null; this.ids = []; this.idIndex.clear(); this.error = undefined; this.pendingCache = null;
    const e = this.embedder; this.embedder = null; void e?.close();
    void this.deps.removeModel();
  }
}

/** Float vector in [-1, 1] -> int8 bytes (scaled by 127). Cosine similarity survives this to ~3 decimal places. */
export function quantise(v: Float32Array): Uint8Array {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i]! * 127)));
  return new Uint8Array(q.buffer);
}

// ------------------------------------------------- deterministic test embedder

/** A tiny bag-of-words hashing embedder: no model needed, similarity tracks word overlap. For tests and the e2e server only. */
export class HashingEmbedder implements Embedder {
  constructor(private readonly dims = 384) {}
  async embed(texts: string[], kind: 'doc' | 'query'): Promise<Float32Array[]> {
    void kind;
    return texts.map((t) => {
      const v = new Float32Array(this.dims);
      for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) { const h = fnv1a(w); v[h % this.dims]! += (h & 0x100) ? 1 : -1; }
      let n = 0; for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      return v.map((x) => x / n);
    });
  }
  close() {}
}
