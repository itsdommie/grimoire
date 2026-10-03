import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { dbPathFor, openDb } from './db.js';
import { DataManager } from './data.js';
import { loadJsonl } from './ingest.js';
import { rulesResponse, sfCard, tmpDir, toJsonl, writeBulk } from './testutil.js';

const CARDS = [sfCard({ name: 'Sol Ring', type_line: 'Artifact' }), sfCard({ name: 'Island', type_line: 'Basic Land — Island' })];

/** A fake Scryfall: a manifest and one bulk file. */
function fakeScryfall(version: string, cards = CARDS, opts: { failDownload?: boolean } = {}) {
  const body = gzipSync(toJsonl(cards));
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    const rules = rulesResponse(u);
    if (rules) return rules;
    if (u.endsWith('/bulk-data')) {
      return Response.json({ data: [{ type: 'oracle_cards', updated_at: version, jsonl_download_uri: 'https://data.scryfall.io/oracle.jsonl.gz' }] });
    }
    if (opts.failDownload) return new Response('nope', { status: 503 });
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  }) as typeof fetch;
  return { impl, calls };
}

function setup(fetchImpl?: typeof fetch) {
  const dataDir = tmpDir();
  const db = openDb(dbPathFor(dataDir));
  return { dataDir, db, data: new DataManager({ dataDir, db, fetch: fetchImpl }) };
}

describe('DataManager', () => {
  it('starts empty, downloads and imports, then reports ready', async () => {
    const fake = fakeScryfall('2026-10-02T21:02:01.893+00:00');
    const { data, db, dataDir } = setup(fake.impl);
    expect(data.status()).toMatchObject({ state: 'empty', cardCount: 0 });

    data.start();
    expect(data.status().state).toBe('updating');
    await data.idle();

    expect(data.status()).toMatchObject({ state: 'ready', cardCount: 2, bulkUpdatedAt: '2026-10-02T21:02:01.893+00:00', upToDate: false });
    expect((db.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n).toBe(2);
    expect(existsSync(join(dataDir, 'bulk', 'oracle-cards-2026-10-02.jsonl.gz'))).toBe(true);
  });

  it('skips the download when the bulk data is unchanged, unless forced', async () => {
    const fake = fakeScryfall('v1');
    const { data } = setup(fake.impl);
    data.start(); await data.idle();
    const callsAfterFirst = fake.calls.length;

    data.start(); await data.idle();
    expect(data.status()).toMatchObject({ state: 'ready', upToDate: true });
    expect(fake.calls).toHaveLength(callsAfterFirst + 2); // the manifest and Wizards' rules page: no bulk file

    data.start({ force: true }); await data.idle();
    expect(data.status().upToDate).toBe(false);
  });

  it('keeps the old card pool and reports an error when a download fails', async () => {
    const { data, dataDir } = setup(fakeScryfall('v1').impl);
    data.start(); await data.idle();

    const failing = new DataManager({ dataDir, db: openDb(dbPathFor(dataDir)), fetch: fakeScryfall('v2', CARDS, { failDownload: true }).impl });
    failing.start(); await failing.idle();
    expect(failing.status()).toMatchObject({ state: 'error', cardCount: 2, bulkUpdatedAt: 'v1' });
    expect(failing.status().error).toMatch(/503/);
    expect(readdirSync(join(dataDir, 'bulk')).some((f) => f.endsWith('.part'))).toBe(false);
  });

  it('reports a clear error when Scryfall is unreachable', async () => {
    const { data } = setup((async () => { throw new TypeError('fetch failed'); }) as typeof fetch);
    data.start(); await data.idle();
    expect(data.status()).toMatchObject({ state: 'error', cardCount: 0 });
    // and can be retried
    data.start();
    expect(data.status().state).toBe('updating');
    await data.idle();
  });

  it('prunes older bulk downloads', async () => {
    const dataDir = tmpDir();
    const db = openDb(dbPathFor(dataDir));
    const a = new DataManager({ dataDir, db, fetch: fakeScryfall('2026-01-01T00:00:00Z').impl });
    a.start(); await a.idle();
    const b = new DataManager({ dataDir, db, fetch: fakeScryfall('2026-02-02T00:00:00Z').impl });
    b.start(); await b.idle();
    expect(readdirSync(join(dataDir, 'bulk')).filter((f) => f.startsWith('oracle-cards'))).toEqual(['oracle-cards-2026-02-02.jsonl.gz']);
  });

  it('imports from a local file (offline install), plain or gzipped', async () => {
    const { data, dataDir } = setup((async () => { throw new Error('network must not be used'); }) as typeof fetch);
    data.start({ file: writeBulk(dataDir, 'cards.jsonl', CARDS) }); await data.idle();
    expect(data.status()).toMatchObject({ state: 'ready', cardCount: 2 });
    data.start({ file: writeBulk(dataDir, 'cards.jsonl.gz', [CARDS[0]!]) }); await data.idle();
    expect(data.status().cardCount).toBe(1);
  });

  it('ignores a second start() while an update is running', async () => {
    const fake = fakeScryfall('v1');
    const { data } = setup(fake.impl);
    data.start(); data.start(); data.start();
    await data.idle();
    expect(fake.calls.filter((u) => u.endsWith('/bulk-data'))).toHaveLength(1);
  });
});

describe('snapshot isolation during an update', () => {
  it('readers keep the old pool until the import commits; writes get SQLITE_BUSY', async () => {
    const dataDir = tmpDir();
    const reader = openDb(dbPathFor(dataDir));
    const first = (async function* () { for (const c of CARDS) yield JSON.stringify(c); })();
    await loadJsonl(reader, first);
    reader.prepare("INSERT INTO decks (name) VALUES ('mine')").run();

    const writer = openDb(dbPathFor(dataDir));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = (async function* () {
      yield JSON.stringify(sfCard({ name: 'New Card A' }));
      await gate; // pause mid-import, transaction still open
      yield JSON.stringify(sfCard({ name: 'New Card B' }));
    })();
    const importing = loadJsonl(writer, slow);
    await new Promise((r) => setTimeout(r, 20));

    const names = () => (reader.prepare('SELECT name FROM cards ORDER BY name').all() as unknown as Array<{ name: string }>).map((r) => r.name);
    expect(names()).toEqual(['Island', 'Sol Ring']); // old snapshot, not partial new data
    expect(() => reader.prepare("INSERT INTO decks (name) VALUES ('blocked')").run()).toThrow(/locked|busy/i);

    release();
    await importing;
    expect(names()).toEqual(['New Card A', 'New Card B']);
    expect((reader.prepare('SELECT count(*) AS n FROM decks').get() as { n: number }).n).toBe(1); // decks untouched
    writer.close();
  });
});
