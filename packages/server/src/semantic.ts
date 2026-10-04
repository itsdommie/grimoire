import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OrtEmbedder as CoreOrtEmbedder, SemanticIndexCore, MODEL, type Embedder, type ModelSpec, type OrtLike, type SemanticDeps } from './semantic-core.js';
import { PREBUILT_BASE, PREBUILT_MANIFEST, decodeIndex, encodeIndex, type IndexRow, type PrebuiltManifest } from './semantic-prebuilt.js';
import { manifestUsable } from './semantic-index-format.js';
import type { Db } from './schema.js';

// The desktop server's half of semantic search: model files on disk, onnxruntime-web loaded through Node, the pre-built index fetched with
// fetch(). Everything else (the index, scoring, building) is in semantic-core.ts, which the Android app shares.

export { HashingEmbedder, MODEL, NOT_SET_UP, quantise, type Embedder, type ModelFile, type ModelSpec, type SemanticDeps } from './semantic-core.js';

const USER_AGENT = 'Grimoire/0.1 (open-source MTG deck lab)';

export class OrtEmbedder extends CoreOrtEmbedder {
  /** `ortDir` is the folder holding ort.node.min.mjs and the .wasm files (shipped with the desktop app); without it the installed package is used. */
  static async create(opts: { modelDir: string; spec?: ModelSpec; ortDir?: string; threads?: number }): Promise<CoreOrtEmbedder> {
    const specifier = opts.ortDir ? pathToFileURL(join(opts.ortDir, 'ort.node.min.mjs')).href : 'onnxruntime-web';
    const ort = (await import(/* @vite-ignore */ specifier)) as unknown as OrtLike; // computed specifier: kept out of the bundle
    ort.env.wasm.numThreads = opts.threads ?? Math.max(1, Math.min(8, availableParallelism() - 1));
    if (opts.ortDir) {
      // The loader is import()ed, so it must be a real file:// URL: a Windows path (D:\...) is not a valid ESM specifier.
      // The .wasm bytes are handed over directly so no second path has to be resolved.
      ort.env.wasm.wasmPaths = { mjs: pathToFileURL(join(opts.ortDir, 'ort-wasm-simd-threaded.mjs')).href };
      ort.env.wasm.wasmBinary = readFileSync(join(opts.ortDir, 'ort-wasm-simd-threaded.wasm'));
    }
    return CoreOrtEmbedder.fromBytes(ort, readFileSync(join(opts.modelDir, 'model.onnx')), readFileSync(join(opts.modelDir, 'tokenizer.json'), 'utf8'), opts.spec ?? MODEL);
  }
}

export interface SemanticOptions {
  db: Db;
  dataDir: string;
  fetch?: typeof fetch;
  ortDir?: string;
  spec?: ModelSpec;
  deps?: Partial<SemanticDeps>;
  /** Free the model's memory after this many idle ms (default 10 minutes). */
  idleMs?: number;
  /** Where the pre-built index is published (default: this project's release). null turns the download off. */
  prebuiltBase?: string | null;
}

export class SemanticIndex extends SemanticIndexCore {
  constructor(opts: SemanticOptions) {
    const spec = opts.spec ?? MODEL;
    const modelDir = join(opts.dataDir, 'models', spec.dir);
    const fetchImpl = () => opts.fetch ?? fetch;
    super({
      db: opts.db, spec, idleMs: opts.idleMs,
      deps: {
        ensureModel: (report, cancelled) => downloadModel(fetchImpl(), spec, modelDir, report, cancelled),
        createEmbedder: () => OrtEmbedder.create({ modelDir, spec, ortDir: opts.ortDir }),
        loadPrebuilt: (report, cancelled) => downloadPrebuilt(fetchImpl(), opts.prebuiltBase === undefined ? PREBUILT_BASE : opts.prebuiltBase, spec, report, cancelled),
        removeModel: () => rmSync(modelDir, { recursive: true, force: true }),
        ...opts.deps,
      },
    });
  }

  /** Everything needed to publish the current index as a pre-built one (run by CI). */
  exportPrebuilt(): { manifest: PrebuiltManifest; data: Buffer } {
    const rows = (this.db.prepare('SELECT card_id, hash, vec FROM embeddings ORDER BY card_id').all() as unknown as Array<{ card_id: string; hash: number; vec: Uint8Array }>)
      .map((r): IndexRow => ({ id: r.card_id, hash: r.hash, vec: new Uint8Array(r.vec) }));
    const data = encodeIndex(rows, this.spec.id, this.spec.dims);
    const manifest: PrebuiltManifest = { format: 1, model: this.spec.id, dims: this.spec.dims, count: rows.length, createdAt: new Date().toISOString(), file: `semantic-${this.spec.id}.bin.gz`, sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
    return { manifest, data };
  }
}

/** Download the published pre-built index and verify it. Offline, missing or corrupt: null (the caller embeds locally instead). */
async function downloadPrebuilt(fetchImpl: typeof fetch, base: string | null, spec: ModelSpec, report: (received: number, total: number) => void, cancelled: () => boolean): Promise<IndexRow[] | null> {
  if (!base) return null;
  const expected = { model: spec.id, dims: spec.dims };
  const headers = { 'User-Agent': USER_AGENT };
  try {
    const mres = await fetchImpl(`${base}/${PREBUILT_MANIFEST}`, { headers });
    if (!mres.ok) return null;
    const manifest = (await mres.json()) as PrebuiltManifest;
    if (!manifestUsable(manifest, expected)) return null;
    report(0, manifest.size);
    const res = await fetchImpl(`${base}/${manifest.file}`, { headers });
    if (!res.ok || !res.body) return null;
    const chunks: Buffer[] = [];
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      received += value.length;
      report(received, manifest.size);
      if (cancelled()) return null;
    }
    const gz = Buffer.concat(chunks);
    if (gz.length !== manifest.size || createHash('sha256').update(gz).digest('hex') !== manifest.sha256) return null; // corrupt or tampered: ignore
    return decodeIndex(gz, expected);
  } catch {
    return null; // offline, or the file was unusable
  }
}

async function downloadModel(fetchImpl: typeof fetch, spec: ModelSpec, dir: string, report: (received: number, total: number) => void, cancelled: () => boolean): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const totalBytes = spec.files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  for (const file of spec.files) {
    const dest = resolve(dir, file.name);
    if (existsSync(dest) && statSync(dest).size === file.size) { done += file.size; report(done, totalBytes); continue; }
    const res = await fetchImpl(file.url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok || !res.body) throw new Error(`Couldn't download the language model (HTTP ${res.status})`);
    const tmp = `${dest}.part`;
    const out = createWriteStream(tmp);
    const hash = createHash('sha256');
    let size = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        hash.update(value);
        size += value.length;
        report(done + size, totalBytes);
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        if (cancelled()) throw new Error('Cancelled');
      }
      await new Promise<void>((resolveEnd, reject) => { out.once('error', reject); out.end(resolveEnd); });
    } catch (err) {
      out.destroy();
      rmSync(tmp, { force: true });
      throw err;
    }
    if (hash.digest('hex') !== file.sha256 || size !== file.size) {
      rmSync(tmp, { force: true });
      throw new Error(`The downloaded ${file.name} didn't match its expected checksum, so it was discarded.`);
    }
    renameSync(tmp, dest);
    done += file.size;
  }
}
