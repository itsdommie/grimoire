import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbPathFor, openDb, type Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { HashingEmbedder, MODEL, SemanticIndex } from './semantic.js';
import { PREBUILT_MANIFEST, decodeIndex, encodeIndex, type IndexRow, type PrebuiltManifest } from './semantic-prebuilt.js';
import { sfCard, tmpDir } from './testutil.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const vec = (seed: number, dims = 384) => Uint8Array.from({ length: dims }, (_, i) => (seed * 31 + i * 7) % 255 - 127);

describe('index file format', () => {
  const rows: IndexRow[] = [{ id: uuid(1), hash: 123, vec: vec(1) }, { id: uuid(2), hash: 4294967295, vec: vec(2) }];
  const opts = { model: 'm1', dims: 384 };
  it('round-trips ids, hashes and int8 vectors exactly', () => {
    const out = decodeIndex(encodeIndex(rows, 'm1', 384), opts);
    expect(out.map((r) => [r.id, r.hash])).toEqual([[uuid(1), 123], [uuid(2), 4294967295]]);
    expect(Array.from(out[1]!.vec)).toEqual(Array.from(rows[1]!.vec));
  });
  it('rejects files for another model or size', () => {
    const gz = encodeIndex(rows, 'm1', 384);
    expect(() => decodeIndex(gz, { model: 'other', dims: 384 })).toThrow(/other/);
    expect(() => decodeIndex(gz, { model: 'm1', dims: 128 })).toThrow(/dimensions/);
  });
  it('rejects garbage, truncation, trailing data and bad ids', () => {
    expect(() => decodeIndex(gzipSync(Buffer.from('not an index at all')), opts)).toThrow(/Not a Grimoire/);
    expect(() => decodeIndex(Buffer.from('plain bytes'), opts)).toThrow();
    const raw = (b: Buffer) => gzipSync(b);
    const gunzipped = (gz: Buffer) => require('node:zlib').gunzipSync(gz) as Buffer;
    const good = gunzipped(encodeIndex(rows, 'm1', 384));
    expect(() => decodeIndex(raw(good.subarray(0, good.length - 10)), opts)).toThrow(/truncated/);
    expect(() => decodeIndex(raw(Buffer.concat([good, Buffer.from([0])])), opts)).toThrow(/truncated|trailing/);
    const badId = Buffer.from(good);
    badId.write('not-a-uuid-at-all-------------------!', 13 + 2, 'ascii');
    expect(() => decodeIndex(raw(badId), opts)).toThrow(/invalid id/);
  });
  it('refuses to encode bad input', () => {
    expect(() => encodeIndex([{ id: 'nope', hash: 1, vec: vec(1) }], 'm', 384)).toThrow(/UUID/);
    expect(() => encodeIndex([{ id: uuid(1), hash: 1, vec: vec(1, 10) }], 'm', 384)).toThrow(/expected 384/);
  });
});

const CARDS = Array.from({ length: 5 }, (_, i) => sfCard({ name: `Card ${i}`, type_line: 'Artifact', oracle_id: uuid(10 + i), oracle_text: `does thing number ${i}` }));
const asLines = (cards: unknown[]) => (async function* () { for (const c of cards) yield JSON.stringify(c); })();

class Spy extends HashingEmbedder {
  docs = 0;
  override async embed(texts: string[], kind: 'doc' | 'query') { if (kind === 'doc') this.docs += texts.length; return super.embed(texts, kind); }
}

let producer: SemanticIndex;
let producerDb: Db;
beforeEach(async () => {
  // The "CI" side: build a real index with the test embedder and export it.
  producerDb = openDb(':memory:');
  await loadJsonl(producerDb, asLines(CARDS));
  producer = new SemanticIndex({ db: producerDb, dataDir: tmpDir(), prebuiltBase: null, deps: { ensureModel: async () => {}, createEmbedder: async () => new HashingEmbedder() } });
  producer.start(); await producer.idle();
});

/** A fake release: the manifest and the asset, with optional tampering. */
function release(opts: { tamper?: boolean; wrongModel?: boolean; notFound?: boolean; offline?: boolean } = {}) {
  const { manifest, data } = producer.exportPrebuilt();
  const m: PrebuiltManifest = { ...manifest, ...(opts.wrongModel ? { model: 'other-model' } : {}) };
  const body = opts.tamper ? Buffer.concat([data.subarray(0, data.length - 1), Buffer.from([(data[data.length - 1]! + 1) & 255])]) : data;
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (opts.offline) throw new TypeError('fetch failed');
    if (opts.notFound) return new Response('no', { status: 404 });
    if (u.endsWith(PREBUILT_MANIFEST)) return Response.json(m);
    return new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } });
  }) as typeof fetch;
  return { fetchImpl, calls, manifest: m };
}

async function consumer(cards: unknown[], fetchImpl: typeof fetch, spy = new Spy()) {
  const db = openDb(dbPathFor(tmpDir()));
  await loadJsonl(db, asLines(cards));
  const idx = new SemanticIndex({ db, dataDir: tmpDir(), fetch: fetchImpl, prebuiltBase: 'https://example.test/release', deps: { ensureModel: async () => {}, createEmbedder: async () => spy } });
  return { db, idx, spy };
}

describe('using a published index', () => {
  it('exports a manifest that matches the file', () => {
    const { manifest, data } = producer.exportPrebuilt();
    expect(manifest).toMatchObject({ format: 1, model: MODEL.id, dims: 384, count: 5, size: data.length });
    expect(manifest.sha256).toBe(createHash('sha256').update(data).digest('hex'));
  });

  it('downloads the index so nothing has to be embedded locally, and the vectors are identical', async () => {
    const { fetchImpl, calls } = release();
    const { db, idx, spy } = await consumer(CARDS, fetchImpl);
    idx.start(); await idx.idle();
    expect(calls).toEqual(['https://example.test/release/semantic-index.json', `https://example.test/release/${producer.exportPrebuilt().manifest.file}`]);
    expect(spy.docs).toBe(0); // every card came from the download
    expect(idx.status()).toMatchObject({ state: 'ready', indexed: 5, pending: 0 });
    const vecs = (d: Db) => (d.prepare('SELECT card_id, vec FROM embeddings ORDER BY card_id').all() as unknown as Array<{ card_id: string; vec: Uint8Array }>).map((r) => [r.card_id, Array.from(r.vec)]);
    expect(vecs(db)).toEqual(vecs(producerDb));
  });

  it('only uses rows whose card text is identical, and embeds the rest locally', async () => {
    const changed = CARDS.map((c, i) => (i === 2 ? { ...c, oracle_text: 'completely different text now' } : c)).concat(sfCard({ name: 'Brand New', type_line: 'Artifact', oracle_id: uuid(99) }));
    const { fetchImpl } = release();
    const { idx, spy } = await consumer(changed, fetchImpl);
    idx.start(); await idx.idle();
    expect(spy.docs).toBe(2); // the edited card and the new one
    expect(idx.status()).toMatchObject({ indexed: 6, pending: 0 });
  });

  it.each([
    ['a tampered file (checksum mismatch)', { tamper: true }],
    ['an index for a different model', { wrongModel: true }],
    ['a missing release (404)', { notFound: true }],
    ['no network', { offline: true }],
  ])('%s is ignored: everything is embedded locally and setup still succeeds', async (_label, opts) => {
    const { fetchImpl } = release(opts);
    const { idx, spy } = await consumer(CARDS, fetchImpl);
    idx.start(); await idx.idle();
    expect(idx.status()).toMatchObject({ state: 'ready', indexed: 5 });
    expect(spy.docs).toBe(5);
  });

  it('is skipped entirely when the download is turned off, or when most cards are already indexed', async () => {
    const { fetchImpl, calls } = release();
    const off = await consumer(CARDS, fetchImpl);
    const idxOff = new SemanticIndex({ db: off.db, dataDir: tmpDir(), fetch: fetchImpl, prebuiltBase: null, deps: { ensureModel: async () => {}, createEmbedder: async () => off.spy } });
    idxOff.start(); await idxOff.idle();
    expect(calls).toHaveLength(0);

    const { idx } = await consumer(CARDS, fetchImpl);
    idx.start(); await idx.idle();
    const before = calls.length;
    idx.start(); await idx.idle(); // already complete: no second download
    expect(calls.length).toBe(before);
  });
});
