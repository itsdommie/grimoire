import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SearchError, type SearchResponse, type SemanticStatus } from '@grimoire/shared';
import { dbPathFor, openDb, type Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { searchCards } from './cards.js';
import { HashingEmbedder, MODEL, NOT_SET_UP, OrtEmbedder, SemanticIndex, quantise, type Embedder, type ModelSpec } from './semantic.js';
import { buildServer } from './server.js';
import { sfCard, tmpDir } from './testutil.js';

const CARDS = [
  sfCard({ name: 'Rhystic Study', type_line: 'Enchantment', color_identity: ['U'], colors: ['U'], oracle_text: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.' }),
  sfCard({ name: 'Rampant Growth', type_line: 'Sorcery', color_identity: ['G'], colors: ['G'], oracle_text: 'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.' }),
  sfCard({ name: 'Counterspell', type_line: 'Instant', color_identity: ['U'], colors: ['U'], oracle_text: 'Counter target spell.' }),
  sfCard({ name: 'Goblin Chainwhirler', type_line: 'Creature — Goblin Warrior', color_identity: ['R'], colors: ['R'], oracle_text: 'First strike. When this creature enters, it deals 1 damage to each opponent and each creature and planeswalker they control.' }),
  sfCard({ name: 'Smothering Tithe', type_line: 'Enchantment', color_identity: ['W'], colors: ['W'], oracle_text: 'Whenever an opponent draws a card, that player may pay {2}. If they do not, you create a Treasure token.' }),
  sfCard({ name: 'Forest', type_line: 'Basic Land — Forest', color_identity: ['G'], oracle_text: '({T}: Add {G}.)' }),
];
const asLines = (cards: unknown[]) => (async function* () { for (const c of cards) yield JSON.stringify(c); })();

/** An embedder that counts what it was asked to embed, and can pull the plug part-way. */
class SpyEmbedder extends HashingEmbedder {
  calls: number[] = [];
  closed = false;
  onCall?: (n: number) => void;
  override async embed(texts: string[], kind: 'doc' | 'query') { this.calls.push(texts.length); this.onCall?.(this.calls.length); return super.embed(texts, kind); }
  override close() { this.closed = true; }
}

let db: Db;
let dataDir: string;
let spy: SpyEmbedder;
const make = (extra: Partial<ConstructorParameters<typeof SemanticIndex>[0]> = {}) =>
  new SemanticIndex({ db, dataDir, deps: { ensureModel: async () => {}, createEmbedder: async () => spy }, ...extra });

beforeEach(async () => {
  dataDir = tmpDir();
  db = openDb(dbPathFor(dataDir));
  await loadJsonl(db, asLines(CARDS));
  spy = new SpyEmbedder();
});

const names = (res: SearchResponse) => res.cards.map((c) => c.name);

describe('building the index', () => {
  it('starts off, then builds an embedding per card and reports ready', async () => {
    const idx = make();
    expect(idx.status()).toMatchObject({ state: 'off', enabled: false, indexed: 0, total: 6, pending: 6 });
    idx.start();
    expect(['downloading', 'building']).toContain(idx.status().state);
    await idx.idle();
    expect(idx.status()).toMatchObject({ state: 'ready', enabled: true, indexed: 6, total: 6, pending: 0, model: MODEL.id });
    expect(idx.isReady()).toBe(true);
  });

  it('embeds in length-sorted batches of up to 32', async () => {
    const many = Array.from({ length: 70 }, (_, i) => sfCard({ name: `Card ${i}`, type_line: 'Artifact', oracle_text: 'x '.repeat(i) }));
    await loadJsonl(db, asLines(many));
    const idx = make();
    idx.start(); await idx.idle();
    expect(spy.calls).toEqual([32, 32, 6]);
    expect(idx.status().indexed).toBe(70);
  });

  it('resumes after being cancelled, only embedding what is left', async () => {
    const many = Array.from({ length: 100 }, (_, i) => sfCard({ name: `Card ${i}`, type_line: 'Artifact', oracle_text: `text ${i}` }));
    await loadJsonl(db, asLines(many));
    const idx = make();
    spy.onCall = (n) => { if (n === 1) idx.cancel(); };
    idx.start(); await idx.idle();
    expect(idx.status()).toMatchObject({ state: 'ready', indexed: 32, pending: 68 });
    spy.calls = []; spy.onCall = undefined;
    idx.start(); await idx.idle();
    expect(spy.calls).toEqual([32, 32, 4]);
    expect(idx.status()).toMatchObject({ indexed: 100, pending: 0 });
  });

  it('re-embeds only cards whose text changed or that are new, and drops removed ones', async () => {
    const idx = make();
    idx.start(); await idx.idle();
    spy.calls = [];
    db.prepare("UPDATE cards SET oracle_text = 'Counter target noncreature spell.' WHERE name = 'Counterspell'").run();
    await loadJsonl(db, asLines([...CARDS.filter((c) => c.name !== 'Forest'), sfCard({ name: 'Brand New', type_line: 'Artifact' })])); // replaces the pool: Counterspell text is reset, Forest gone
    expect(idx.status().pending).toBe(1); // Brand New; the others hash the same as before
    idx.start(); await idx.idle();
    expect(spy.calls).toEqual([1]);
    expect(idx.status()).toMatchObject({ indexed: 6, total: 6, pending: 0 }); // Forest's embedding was removed
  });

  it('a different model id invalidates the old vectors', async () => {
    const a = make(); a.start(); await a.idle();
    expect(a.status().indexed).toBe(6);
    const spec: ModelSpec = { ...MODEL, id: 'another-model' };
    const b = make({ spec });
    b.start();
    await b.idle();
    expect(spy.calls.length).toBeGreaterThan(1); // everything embedded again
    expect(b.status()).toMatchObject({ model: 'another-model', indexed: 6 });
  });

  it('reports errors from the model and can be retried', async () => {
    let fail = true;
    const idx = new SemanticIndex({ db, dataDir, deps: { ensureModel: async () => { if (fail) throw new Error('no network'); }, createEmbedder: async () => spy } });
    idx.start(); await idx.idle();
    expect(idx.status()).toMatchObject({ state: 'error', error: 'no network' });
    fail = false;
    idx.start(); await idx.idle();
    expect(idx.status().state).toBe('ready');
  });

  it('frees the model after it has been idle', async () => {
    const idx = make({ idleMs: 20 });
    idx.start(); await idx.idle();
    expect(spy.closed).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(spy.closed).toBe(true);
  });

  it('remove() turns it off and deletes the index', async () => {
    const idx = make();
    idx.start(); await idx.idle();
    idx.remove();
    expect(idx.status()).toMatchObject({ state: 'off', enabled: false, indexed: 0 });
    expect(idx.isReady()).toBe(false);
  });
});

describe('searching by meaning', () => {
  const ready = async () => {
    const idx = make();
    idx.start(); await idx.idle();
    return idx;
  };
  const run = async (idx: SemanticIndex, query: string) => {
    const phrase = /about:"([^"]+)"/.exec(query)![1]!;
    const vector = await idx.embedQuery(phrase);
    return searchCards(db, { query, semantic: { rank: (ids) => idx.rank(vector, ids) } });
  };

  it('ranks cards by similarity to the phrase, best first', async () => {
    const idx = await ready();
    expect(names(await run(idx, 'about:"draw a card unless that player pays"'))[0]).toBe('Rhystic Study');
    expect(names(await run(idx, 'about:"search library basic land battlefield"'))[0]).toBe('Rampant Growth');
    expect(names(await run(idx, 'about:"counter target spell"'))[0]).toBe('Counterspell');
  });

  it('combines with ordinary filters, which still decide what can appear', async () => {
    const idx = await ready();
    const res = await run(idx, 'about:"opponent draws a card" c:w');
    expect(names(res)).toEqual(['Smothering Tithe']);
    expect(res.total).toBe(1);
    const spells = await run(idx, 'about:"opponent casts a spell" t:enchantment');
    expect(names(spells).sort()).toEqual(['Rhystic Study', 'Smothering Tithe']);
  });

  it('pages through results', async () => {
    const idx = await ready();
    const vector = await idx.embedQuery('spell');
    const sem = { rank: (ids: readonly string[]) => idx.rank(vector, ids) };
    const all = searchCards(db, { query: 'about:"spell"', semantic: sem, limit: 6 });
    const page2 = searchCards(db, { query: 'about:"spell"', semantic: sem, limit: 2, offset: 2 });
    expect(names(page2)).toEqual(names(all).slice(2, 4));
    expect(all.total).toBe(6);
  });

  it('refuses sensibly when unavailable, negated or repeated', async () => {
    expect(() => searchCards(db, { query: 'about:"anything"' })).toThrow(SearchError);
    expect(() => searchCards(db, { query: 'about:"anything"' })).toThrow(NOT_SET_UP);
    const idx = await ready();
    const sem = { rank: (ids: readonly string[]) => idx.rank(new Float32Array(384), ids) };
    expect(() => searchCards(db, { query: '-about:"draw"', semantic: sem })).toThrow(/can't be negated/);
    expect(() => searchCards(db, { query: 'about:"a" about:"b"', semantic: sem })).toThrow(/one about/);
  });

  it('survives a restart: vectors reload lazily from the database', async () => {
    await ready();
    const restarted = make();
    expect(restarted.enabled).toBe(true);
    expect(restarted.isReady()).toBe(false); // not loaded yet
    restarted.ensureLoaded();
    expect(restarted.isReady()).toBe(true);
    const vector = await restarted.embedQuery('counter target spell');
    expect(restarted.rank(vector, ['x'])[0]!.score).toBe(-1); // unknown ids sort last
  });
});

describe('the model download', () => {
  const bytes = { 'model.onnx': Buffer.from('pretend this is a neural network'), 'tokenizer.json': Buffer.from('{"pretend":"tokenizer"}') };
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const spec = (over: Partial<Record<keyof typeof bytes, string>> = {}): ModelSpec => ({
    ...MODEL,
    files: (Object.keys(bytes) as Array<keyof typeof bytes>).map((name) => ({ name, url: `https://models.test/${name}`, size: bytes[name].length, sha256: over[name] ?? sha(bytes[name]) })),
  });
  const fakeFetch = (calls: string[], failWith?: number) => (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (failWith) return new Response('nope', { status: failWith });
    const name = u.split('/').pop() as keyof typeof bytes;
    return new Response(new Uint8Array(bytes[name]), { headers: { 'content-length': String(bytes[name].length) } });
  }) as typeof fetch;

  it('downloads, verifies the checksum, and does not download again', async () => {
    const calls: string[] = [];
    const idx = new SemanticIndex({ db, dataDir, spec: spec(), fetch: fakeFetch(calls), deps: { createEmbedder: async () => spy } });
    idx.start(); await idx.idle();
    expect(idx.status().state).toBe('ready');
    expect(readdirSync(join(dataDir, 'models', MODEL.dir)).sort()).toEqual(['model.onnx', 'tokenizer.json']);
    expect(calls).toHaveLength(2);
    idx.start(); await idx.idle();
    expect(calls).toHaveLength(2); // cached by size
  });

  it('discards a download whose checksum is wrong', async () => {
    const calls: string[] = [];
    const idx = new SemanticIndex({ db, dataDir, spec: spec({ 'model.onnx': 'deadbeef' }), fetch: fakeFetch(calls), deps: { createEmbedder: async () => spy } });
    idx.start(); await idx.idle();
    expect(idx.status()).toMatchObject({ state: 'error' });
    expect(idx.status().error).toMatch(/didn't match its expected checksum/);
    expect(existsSync(join(dataDir, 'models', MODEL.dir, 'model.onnx'))).toBe(false);
    expect(existsSync(join(dataDir, 'models', MODEL.dir, 'model.onnx.part'))).toBe(false);
  });

  it('reports HTTP failures', async () => {
    const idx = new SemanticIndex({ db, dataDir, spec: spec(), fetch: fakeFetch([], 503), deps: { createEmbedder: async () => spy } });
    idx.start(); await idx.idle();
    expect(idx.status().error).toMatch(/HTTP 503/);
  });

  it('the pinned model is a fixed revision with checksums, not a moving branch', () => {
    for (const f of MODEL.files) {
      expect(f.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('vectors', () => {
  it('int8 quantisation keeps cosine similarity within ~0.01', async () => {
    const e = new HashingEmbedder();
    const [a, b] = await e.embed(['draw a card from the library', 'draw cards when creatures enter'], 'doc');
    const dot = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    const qa = new Int8Array(quantise(a!).buffer);
    const approx = qa.reduce((s, v, i) => s + v * b![i]!, 0) / 127;
    expect(Math.abs(approx - dot(a!, b!))).toBeLessThan(0.01);
  });
});

describe('semantic API', () => {
  it('status / enable / search / remove over HTTP', async () => {
    const semantic = new SemanticIndex({ db, dataDir, deps: { ensureModel: async () => {}, createEmbedder: async () => spy } });
    const app = buildServer({ db, dataDir, logger: false, semantic });
    const j = async <T>(method: 'GET' | 'POST' | 'DELETE', url: string) => { const r = await app.inject({ method, url }); return { status: r.statusCode, body: (r.body ? JSON.parse(r.body) : null) as T }; };

    expect((await j<SemanticStatus>('GET', '/api/semantic/status')).body).toMatchObject({ state: 'off', enabled: false });
    const refused = await j<SearchResponse>('GET', `/api/cards/search?q=${encodeURIComponent('about:"draw a card"')}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe(NOT_SET_UP);

    expect((await j('POST', '/api/semantic/enable')).status).toBe(202);
    await semantic.idle();
    expect((await j<SemanticStatus>('GET', '/api/semantic/status')).body).toMatchObject({ state: 'ready', indexed: 6 });

    const ok = await j<SearchResponse>('GET', `/api/cards/search?q=${encodeURIComponent('about:"draw a card unless that player pays" t:enchantment')}`);
    expect(ok.status).toBe(200);
    expect(ok.body.cards[0]!.name).toBe('Rhystic Study');

    // The collection view understands about: too.
    await app.inject({ method: 'POST', url: '/api/collection/import', payload: { text: 'Counterspell\nRhystic Study', mode: 'replace' } });
    const coll = await j<SearchResponse>('GET', `/api/collection?q=${encodeURIComponent('about:"counter target spell"')}`);
    expect(coll.body.cards.map((c) => c.name)).toEqual(['Counterspell', 'Rhystic Study']);

    expect((await j('DELETE', '/api/semantic')).status).toBe(204);
    expect((await j<SemanticStatus>('GET', '/api/semantic/status')).body.state).toBe('off');
  });
});

// The real thing: only runs once `npm run semantic` has downloaded the model and built the index for the dev database.
const devData = process.env.GRIMOIRE_DATA_DIR ?? join(__dirname, '../../../data');
const haveReal = existsSync(join(devData, 'models', MODEL.dir, 'model.onnx')) && existsSync(dbPathFor(devData));
describe.skipIf(!haveReal)('real model on the dev database', () => {
  let real: Db;
  let idx: SemanticIndex;
  let embedder: Embedder;
  beforeEach(async () => {
    if (idx) return;
    real = openDb(dbPathFor(devData));
    embedder = await OrtEmbedder.create({ modelDir: join(devData, 'models', MODEL.dir) });
    idx = new SemanticIndex({ db: real, dataDir: devData, deps: { ensureModel: async () => {}, createEmbedder: async () => embedder } });
    idx.ensureLoaded();
  }, 60_000);

  const top = async (phrase: string, filter = '', n = 10) => {
    const v = await idx.embedQuery(phrase);
    return searchCards(real, { query: `about:"${phrase}" ${filter}`, limit: n, semantic: { rank: (ids) => idx.rank(v, ids) } }).cards;
  };
  const skipUnlessIndexed = () => expect(idx.isReady(), 'run `npm run semantic` first').toBe(true);

  // Judged by what the cards actually say (not by a fixed list of card names): most of the top 10 should be on topic.
  it.each([
    ['fetch a basic land and put it onto the battlefield', /search your library for [^.]*land/i, 5],
    ['counter target spell', /counter target/i, 6],
    ['destroy all creatures', /destroy all|each creature|all creatures/i, 6],
    ['create treasure tokens', /treasure/i, 6],
    ['put a +1/+1 counter on each creature you control', /\+1\/\+1 counter/i, 6],
  ])('"%s": most of the top 10 are on topic', async (phrase, onTopic, atLeast) => {
    skipUnlessIndexed();
    const cards = await top(phrase as string, '', 10);
    const hits = cards.filter((c) => (onTopic as RegExp).test(c.oracleText));
    expect(hits.length, `top 10 was: ${cards.map((c) => c.name).join(', ')}`).toBeGreaterThanOrEqual(atLeast as number);
  }, 30_000);

  it('finds a specific well-known card from a paraphrase of its text', async () => {
    skipUnlessIndexed();
    const cards = await top('whenever an opponent casts a spell you may draw a card unless they pay', 'f:commander', 10);
    expect(cards.map((c) => c.name)).toContain('Rhystic Study');
  }, 30_000);

  it('filters narrow the semantic results', async () => {
    skipUnlessIndexed();
    const green = await top('ramp', 'c:g t:sorcery f:commander', 10);
    expect(green.length).toBe(10);
    expect(green.every((c) => /Sorcery/.test(c.typeLine) && (c.colors & 16) !== 0)).toBe(true);
  }, 30_000);
});
