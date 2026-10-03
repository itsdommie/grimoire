import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeIndex } from '../../server/src/semantic-prebuilt.ts';
import { MODEL, type ModelSpec } from '../../server/src/semantic-core.ts';
import { memoryStore } from './modelStore.ts';
import { phoneSemanticDeps, sha256, type PhoneSemanticOptions } from './semantic.ts';
import type { NativeRequest, NativeResult } from './protocol.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = (s: string) => new TextEncoder().encode(s);
const MODEL_BYTES = bytes('pretend this is an onnx model');
const TOKENIZER_BYTES = bytes('{"pretend":"tokenizer"}');
const SPEC: ModelSpec = {
  ...MODEL,
  files: [
    { name: 'model.onnx', url: 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/ea104dacec62c0de699686887e3f920caeb4f3e3/onnx/model_quantized.onnx', size: MODEL_BYTES.length, sha256: sha(MODEL_BYTES) },
    { name: 'tokenizer.json', url: 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/ea104dacec62c0de699686887e3f920caeb4f3e3/tokenizer.json', size: TOKENIZER_BYTES.length, sha256: sha(TOKENIZER_BYTES) },
  ],
};
const ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const rows = [{ id: ID, hash: 7, vec: new Uint8Array(MODEL.dims).fill(3) }];
const INDEX = encodeIndex(rows, MODEL.id, MODEL.dims);
const manifest = (over: object = {}) => ({ format: 1, model: MODEL.id, dims: MODEL.dims, count: 1, createdAt: 'x', file: 'idx.bin.gz', sha256: sha(INDEX), size: INDEX.length, ...over });

/** A fake network: path -> body (or a status), counting what was asked for. */
function network(routes: Record<string, Uint8Array | string | number>) {
  const asked: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const hit = Object.entries(routes).find(([k]) => url.endsWith(k))?.[1];
    if (hit === undefined) return new Response(null, { status: 404 });
    if (typeof hit === 'number') return new Response(null, { status: hit });
    return new Response(typeof hit === 'string' ? hit : (hit as BodyInit));
  }) as typeof fetch;
  return { asked, fetchFn };
}

function setup(routes: Record<string, Uint8Array | string | number>, extra: Partial<PhoneSemanticOptions> = {}) {
  const net = network(routes);
  const store = memoryStore();
  const deps = phoneSemanticDeps({ db: null as never, store, native: null, ortBase: 'http://x/ort/', prebuiltBase: 'http://x/pre', modelBase: 'http://x/model', fetch: net.fetchFn, ...extra }, SPEC);
  return { deps, store, ...net };
}
const never = () => false;
const modelRoutes = { '/model/onnx/model_quantized.onnx': MODEL_BYTES, '/model/tokenizer.json': TOKENIZER_BYTES };

describe('the language model download', () => {
  it('downloads both files, checks them, stores them, and reports progress up to the total', async () => {
    const t = setup(modelRoutes);
    const seen: number[] = [];
    await t.deps.ensureModel((got, total) => { seen.push(got); expect(total).toBe(MODEL_BYTES.length + TOKENIZER_BYTES.length); }, never);
    expect(seen.at(-1)).toBe(MODEL_BYTES.length + TOKENIZER_BYTES.length);
    expect([...t.store.files.keys()].sort()).toEqual(['model.onnx', 'tokenizer.json']);
  });

  it('does not download what is already stored', async () => {
    const t = setup(modelRoutes);
    await t.deps.ensureModel(() => {}, never);
    t.asked.length = 0;
    await t.deps.ensureModel(() => {}, never);
    expect(t.asked).toEqual([]);
  });

  it('discards a file whose checksum is wrong and stores nothing of it', async () => {
    const t = setup({ ...modelRoutes, '/model/onnx/model_quantized.onnx': bytes('pretend this is an onnx modeL') });
    await expect(t.deps.ensureModel(() => {}, never)).rejects.toThrow(/checksum/);
    expect(t.store.files.has('model.onnx')).toBe(false);
  });

  it('refuses a download that is bigger than the expected size', async () => {
    const t = setup({ ...modelRoutes, '/model/onnx/model_quantized.onnx': new Uint8Array(MODEL_BYTES.length + 50) });
    await expect(t.deps.ensureModel(() => {}, never)).rejects.toThrow(/larger than expected/);
  });

  it('reports a server error', async () => {
    const t = setup({ ...modelRoutes, '/model/onnx/model_quantized.onnx': 503 });
    await expect(t.deps.ensureModel(() => {}, never)).rejects.toThrow(/HTTP 503/);
  });

  it('stops when the user cancels', async () => {
    const t = setup(modelRoutes);
    await expect(t.deps.ensureModel(() => {}, () => true)).rejects.toThrow(/Cancelled/);
    expect(t.store.files.size).toBe(0);
  });

  it('says what to do when the stored model has gone missing', async () => {
    const t = setup({});
    await expect(t.deps.createEmbedder()).rejects.toThrow(/turn search by meaning off and on/i);
  });

  it('hands the stored bytes to the embedder loader and deletes everything on removal', async () => {
    let got: [number, string] | undefined;
    const t = setup(modelRoutes, { loadEmbedder: async (m, tok) => { got = [m.length, tok]; return { embed: async () => [], close() {} }; } });
    await t.deps.ensureModel(() => {}, never);
    await t.deps.createEmbedder();
    expect(got).toEqual([MODEL_BYTES.length, '{"pretend":"tokenizer"}']);
    await t.deps.removeModel();
    expect(t.store.files.size).toBe(0);
  });
});

describe('the ready-made index download (outside the app, straight from the network)', () => {
  it('returns the rows of a good index', async () => {
    const t = setup({ '/pre/semantic-index.json': JSON.stringify(manifest()), '/pre/idx.bin.gz': INDEX });
    const got = await t.deps.loadPrebuilt(() => {}, never);
    expect(got).toHaveLength(1);
    expect(got![0]).toMatchObject({ id: ID, hash: 7 });
    expect([...got![0]!.vec.slice(0, 3)]).toEqual([3, 3, 3]);
  });

  it.each([
    ['there is no index published', {}],
    ['the manifest is for another model', { '/pre/semantic-index.json': JSON.stringify(manifest({ model: 'other' })), '/pre/idx.bin.gz': INDEX }],
    ['the file does not match its checksum', { '/pre/semantic-index.json': JSON.stringify(manifest({ sha256: 'a'.repeat(64) })), '/pre/idx.bin.gz': INDEX }],
    ['the file is not the size the manifest says', { '/pre/semantic-index.json': JSON.stringify(manifest({ size: INDEX.length + 1 })), '/pre/idx.bin.gz': INDEX }],
    ['the file is not an index at all', { '/pre/semantic-index.json': JSON.stringify(manifest({ sha256: sha(bytes('garbage')), size: 7 })), '/pre/idx.bin.gz': bytes('garbage') }],
    ['the file cannot be fetched', { '/pre/semantic-index.json': JSON.stringify(manifest()), '/pre/idx.bin.gz': 500 }],
  ])('returns nothing (so cards are embedded here instead) when %s', async (_why, routes) => {
    const t = setup(routes);
    expect(await t.deps.loadPrebuilt(() => {}, never)).toBeNull();
  });
});

describe('the ready-made index download (inside the app, through the native downloader)', () => {
  function native(files: Record<string, Uint8Array | string>) {
    const calls: NativeRequest[] = [];
    const urls = new Map<string, Uint8Array>();
    const fn = async (r: NativeRequest, onProgress?: (a: number, b: number) => void): Promise<NativeResult> => {
      calls.push(r);
      if (r.op === 'delete') return { ok: true };
      const name = r.url.split('/').pop()!;
      const body = files[name];
      if (body === undefined) return { ok: false, error: 'HTTP 404', status: 404 };
      if (r.op === 'text') return { ok: true, text: String(body) };
      onProgress?.(10, INDEX.length);
      urls.set(`file://cache/${r.name}`, body as Uint8Array);
      return { ok: true, url: `file://cache/${r.name}` };
    };
    return { calls, fn, urls };
  }

  it('reads the manifest as text, downloads the file natively, reads it back, and cleans up', async () => {
    const n = native({ 'semantic-index.json': JSON.stringify(manifest()), 'idx.bin.gz': INDEX });
    const t = setup({}, {
      native: n.fn,
      fetch: (async (u: RequestInfo | URL) => (n.urls.has(String(u)) ? new Response(n.urls.get(String(u)) as BodyInit) : new Response(null, { status: 404 }))) as typeof fetch,
    });
    const progress: Array<[number, number]> = [];
    const got = await t.deps.loadPrebuilt((a, b) => progress.push([a, b]), never);
    expect(got).toHaveLength(1);
    expect(n.calls.map((c) => c.op)).toEqual(['text', 'download', 'delete']);
    expect(progress.at(-1)).toEqual([10, INDEX.length]);
  });

  it('gives up quietly when the native download fails, and still cleans up', async () => {
    const n = native({ 'semantic-index.json': JSON.stringify(manifest()) });
    const t = setup({}, { native: n.fn });
    expect(await t.deps.loadPrebuilt(() => {}, never)).toBeNull();
    expect(n.calls.map((c) => c.op)).toEqual(['text', 'download', 'delete']);
  });

  it('gives up quietly when nothing is published', async () => {
    const t = setup({}, { native: native({}).fn });
    expect(await t.deps.loadPrebuilt(() => {}, never)).toBeNull();
  });
});

describe('sha256', () => {
  it('matches the known digest of "abc"', async () => {
    expect(await sha256(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
