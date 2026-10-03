import { SemanticIndexCore, OrtEmbedder, MODEL, type Embedder, type ModelSpec, type OrtLike, type SemanticDeps } from '../../server/src/semantic-core.ts';
import { MAX_RAW_INDEX, PREBUILT_BASE, PREBUILT_MANIFEST, decodeIndexRaw, manifestUsable, type IndexRow, type PrebuiltManifest } from '../../server/src/semantic-index-format.ts';
import type { Db } from '../../server/src/schema.ts';
import type { NativeRequest, NativeResult } from './protocol.ts';
import type { ModelStore } from './modelStore.ts';

/**
 * Search by meaning on the phone: the same index the desktop uses, with the phone's own plumbing. The language model (34 MB) comes
 * straight from Hugging Face (which allows web pages to fetch it) into the app's private cache after a SHA-256 check; the ready-made
 * card index comes from GitHub, which doesn't, so it goes through the native downloader like card updates do. onnxruntime-web runs on one
 * thread (a WebView isn't cross-origin isolated) and is released after ten idle minutes.
 */

/** Embedding thousands of cards on a phone takes hours; past this the setup asks to retry the index download instead. */
export const MAX_LOCAL_EMBEDS = 1500;
const PREBUILT_FILE = 'semantic-index.bin.gz';

export interface PhoneSemanticOptions {
  db: Db;
  store: ModelStore;
  native: ((request: NativeRequest, onProgress?: (received: number, total: number) => void) => Promise<NativeResult>) | null;
  /** Where onnxruntime-web's files are (a folder URL ending in a slash). */
  ortBase: string;
  /** Test overrides: where the pre-built index and the model are published. */
  prebuiltBase?: string;
  modelBase?: string;
  fetch?: typeof fetch;
  /** Replaces onnxruntime-web (tests). */
  loadEmbedder?: (model: Uint8Array, tokenizerJson: string) => Promise<Embedder>;
  maxLocalEmbeds?: number;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));

/** Read a whole response, reporting progress, refusing to take more than `limit` bytes. */
async function readAll(res: Response, limit: number, onChunk: (n: number) => void, cancelled: () => boolean): Promise<Uint8Array> {
  if (!res.body) throw new Error('empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Error('The download was larger than expected, so it was discarded.'); }
    chunks.push(value);
    onChunk(value.length);
    if (cancelled()) { await reader.cancel(); throw new Error('Cancelled'); }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return readAll(new Response(stream), MAX_RAW_INDEX, () => {}, () => false);
}

export function phoneSemanticDeps(o: PhoneSemanticOptions, spec: ModelSpec = MODEL): SemanticDeps {
  const fetchImpl = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const modelUrl = (url: string) => (o.modelBase ? url.replace(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]+/, o.modelBase) : url);
  const prebuiltBase = o.prebuiltBase ?? PREBUILT_BASE;

  return {
    async ensureModel(report, cancelled) {
      const total = spec.files.reduce((n, f) => n + f.size, 0);
      let done = 0;
      for (const file of spec.files) {
        const have = await o.store.get(file.name);
        if (have && have.length === file.size) { done += file.size; report(done, total); continue; }
        const res = await fetchImpl(modelUrl(file.url));
        if (!res.ok) throw new Error(`Couldn't download the language model (HTTP ${res.status})`);
        let got = 0;
        const bytes = await readAll(res, file.size, (n) => { got += n; report(done + got, total); }, cancelled);
        if (bytes.length !== file.size || (await sha256(bytes)) !== file.sha256) throw new Error(`The downloaded ${file.name} didn't match its expected checksum, so it was discarded.`);
        await o.store.put(file.name, bytes);
        done += file.size;
      }
    },

    async createEmbedder() {
      const model = await o.store.get('model.onnx');
      const tokenizer = await o.store.get('tokenizer.json');
      if (!model || !tokenizer) throw new Error('The language model is missing: turn search by meaning off and on again to download it.');
      const json = new TextDecoder().decode(tokenizer);
      if (o.loadEmbedder) return o.loadEmbedder(model, json);
      const ort = (await import(/* @vite-ignore */ `${o.ortBase}ort.wasm.min.mjs`)) as unknown as OrtLike;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = { mjs: `${o.ortBase}ort-wasm-simd-threaded.mjs`, wasm: `${o.ortBase}ort-wasm-simd-threaded.wasm` };
      return OrtEmbedder.fromBytes(ort, model, json, spec);
    },

    async loadPrebuilt(report, cancelled): Promise<IndexRow[] | null> {
      const expected = { model: spec.id, dims: spec.dims };
      try {
        const manifestUrl = `${prebuiltBase}/${PREBUILT_MANIFEST}`;
        let manifest: PrebuiltManifest;
        if (o.native) {
          const r = await o.native({ op: 'text', url: manifestUrl, name: PREBUILT_MANIFEST });
          if (!r.ok) return null;
          manifest = JSON.parse(r.text ?? '') as PrebuiltManifest;
        } else {
          const r = await fetchImpl(manifestUrl);
          if (!r.ok) return null;
          manifest = (await r.json()) as PrebuiltManifest;
        }
        if (!manifestUsable(manifest, expected)) return null;
        report(0, manifest.size);
        let gz: Uint8Array;
        if (o.native) {
          const r = await o.native({ op: 'download', url: `${prebuiltBase}/${manifest.file}`, name: PREBUILT_FILE }, (received, total) => report(received, total || manifest.size));
          try {
            if (!r.ok || !r.url) return null;
            const res = await fetchImpl(r.url);
            if (!res.ok) return null;
            gz = await readAll(res, manifest.size, () => {}, cancelled);
          } finally { await o.native({ op: 'delete', name: PREBUILT_FILE }); }
        } else {
          const res = await fetchImpl(`${prebuiltBase}/${manifest.file}`);
          if (!res.ok) return null;
          let got = 0;
          gz = await readAll(res, manifest.size, (n) => { got += n; report(got, manifest.size); }, cancelled);
        }
        if (cancelled() || gz.length !== manifest.size || (await sha256(gz)) !== manifest.sha256) return null; // corrupt or tampered: ignore
        return decodeIndexRaw(await gunzip(gz), expected);
      } catch {
        return null; // offline, or the file was unusable
      }
    },

    removeModel: () => o.store.clear(),
  };
}

export function createPhoneSemantic(o: PhoneSemanticOptions): SemanticIndexCore {
  return new SemanticIndexCore({ db: o.db, deps: phoneSemanticDeps(o), maxLocalEmbeds: o.maxLocalEmbeds ?? MAX_LOCAL_EMBEDS });
}
