import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbPathFor, openDb, type NodeDb as Db } from './db.js';
import { DataManager, NAMES_URL } from './data.js';
import { loadJsonl } from './ingest.js';
import { BUNDLED_NAMES, aliasesOf, collectAliases, loadAliases, parseNamesFile, seedAliases } from './names.js';
import { getCardByName, resolveCardName, searchCards } from './cards.js';
import { importDeck } from './decks.js';
import { importCollection } from './collection.js';
import { rulesResponse, sfCard, tmpDir, toJsonl } from './testutil.js';

const HORN = 'c02c5547-b9c9-4b2d-9d12-e87bfba8f2d2'; // Herald's Horn's real oracle id: the bundled snapshot must point at it

const horn = sfCard({ name: "Herald's Horn", oracle_id: HORN, type_line: 'Tribal Artifact — Elf', cmc: 3 });
const fire = sfCard({ name: 'Fire // Ice', layout: 'split', type_line: 'Instant // Instant' });
const sol = sfCard({ name: 'Sol Ring', type_line: 'Artifact', cmc: 1 });
const FIXTURE = [horn, fire, sol, sfCard({ name: 'Forest', type_line: 'Basic Land — Forest' })];

let db: Db;
beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, (async function* () { for (const c of FIXTURE) yield JSON.stringify(c); })());
});

async function* lines(...objs: object[]) { for (const o of objs) yield JSON.stringify(o); }

describe('aliasesOf', () => {
  it('reads the flavor name, and each face\'s, when they differ from the card name', () => {
    expect(aliasesOf({ oracle_id: 'a', name: "Herald's Horn", flavor_name: 'Avengers Monitoring Station' })).toEqual([['Avengers Monitoring Station', 'a']]);
    expect(aliasesOf({ oracle_id: 'b', name: 'X // Y', flavor_name: 'P // Q', card_faces: [{ flavor_name: 'P' }, { flavor_name: 'Q' }, {}] }))
      .toEqual([['P // Q', 'b'], ['P', 'b'], ['Q', 'b']]);
  });
  it('ignores a flavor name equal to the real name, printings with no oracle id, and tokens', () => {
    expect(aliasesOf({ oracle_id: 'a', name: 'Sol Ring', flavor_name: 'sol ring' })).toEqual([]);
    expect(aliasesOf({ name: 'X', flavor_name: 'Y' })).toEqual([]);
    expect(aliasesOf({ oracle_id: 'a', name: 'Treasure', flavor_name: 'Gold', layout: 'token' })).toEqual([]);
    expect(aliasesOf({ oracle_id: 'a', name: 'Sol Ring' })).toEqual([]);
  });
  it('collects distinct names across printings, ignoring case', async () => {
    const pairs = await collectAliases(lines(
      { oracle_id: 'a', name: 'A', flavor_name: 'Alpha' }, { oracle_id: 'a', name: 'A', flavor_name: 'ALPHA' }, { oracle_id: 'b', name: 'B', flavor_name: 'Beta' }, { oracle_id: 'c', name: 'C' },
    ));
    expect(pairs).toEqual([['Alpha', 'a'], ['Beta', 'b']]);
  });
});

describe('finding cards by another name', () => {
  beforeEach(() => { loadAliases(db, [['Avengers Monitoring Station', HORN], ['Frost // Flame', fire.oracle_id!], ['Sol Ring', horn.oracle_id!]]); });

  it('resolves an alias to the base card, ignoring case and punctuation spacing', () => {
    expect(resolveCardName(db, 'Avengers Monitoring Station')?.name).toBe("Herald's Horn");
    expect(resolveCardName(db, 'avengers monitoring station')?.name).toBe("Herald's Horn");
    expect(resolveCardName(db, '  Avengers Monitoring Station ')?.name).toBe("Herald's Horn");
    expect(resolveCardName(db, 'Nobody Special')).toBeNull();
  });
  it('a real card name always beats an alias that clashes with it', () => {
    expect(resolveCardName(db, 'Sol Ring')?.name).toBe('Sol Ring');
  });
  it('finds a double-faced card by the front of its alias, and by Arena\'s "A-" prefix', () => {
    expect(resolveCardName(db, 'Frost')?.name).toBe('Fire // Ice');
    expect(resolveCardName(db, 'Frost / Flame')?.name).toBe('Fire // Ice');
    expect(resolveCardName(db, "A-Herald's Horn")?.name).toBe("Herald's Horn");
    expect(resolveCardName(db, 'A-Avengers Monitoring Station')?.name).toBe("Herald's Horn");
    expect(resolveCardName(db, 'A-Nothing')).toBeNull();
  });

  it('a deck import finds cards by their other names instead of skipping them', () => {
    const res = importDeck(db, 'Commander\n1 Sol Ring\n\nDeck\n1 Avengers Monitoring Station\n1 Not A Card\n1 A-Herald\'s Horn', { name: 'Test' });
    expect(res.unresolved).toEqual(['Not A Card']);
    expect(res.entries.map((e) => `${e.qty} ${e.card.name} ${e.board}`).sort()).toEqual(["2 Herald's Horn main", '1 Sol Ring commander'].sort());
  });
  it('a collection import (CSV or list) finds them too', () => {
    const csv = 'Name,Set code,Collector number,Foil,Quantity,ManaBox ID\nAvengers Monitoring Station,msc,12,normal,2,1\nHerald\'s Horn,mkm,3,normal,1,2';
    const res = importCollection(db, csv, 'replace');
    expect(res.unresolved).toEqual([]);
    expect(res.summary.total).toBe(3);
    expect(getCardByName(db, "Herald's Horn")?.owned).toBe(3);
    expect(importCollection(db, '4 Avengers Monitoring Station', 'merge').unresolved).toEqual([]);
  });

  it('search finds the card by its other name: bare words, name:, and exact', () => {
    const names = (q: string) => searchCards(db, { query: q }).cards.map((c) => c.name);
    expect(names('avengers monitoring')).toEqual(["Herald's Horn"]);
    expect(names('name:monitoring')).toEqual(["Herald's Horn"]);
    expect(names('!"Avengers Monitoring Station"')).toEqual(["Herald's Horn"]);
    expect(names("herald's")).toEqual(["Herald's Horn"]);
    expect(names('-avengers t:artifact')).toEqual(['Sol Ring']);
    expect(names('zzz')).toEqual([]);
  });
});

describe('the names that ship with the app', () => {
  it('seeds an empty database once, and leaves existing names alone', () => {
    const empty = openDb(':memory:');
    expect(empty.prepare('SELECT count(*) AS n FROM card_aliases').get()).toMatchObject({ n: BUNDLED_NAMES.names.length });
    expect(empty.prepare("SELECT value FROM meta WHERE key = 'names_version'").get()).toMatchObject({ value: `bundled:${BUNDLED_NAMES.version}` });
    loadAliases(empty, [['Mine', 'x']]);
    seedAliases(empty);
    expect(empty.prepare('SELECT count(*) AS n FROM card_aliases').get()).toMatchObject({ n: 1 });
  });
  it('knows the Herald\'s Horn example from the report', () => {
    expect(BUNDLED_NAMES.names).toContainEqual(['Avengers Monitoring Station', HORN]);
    expect(BUNDLED_NAMES.names.length).toBeGreaterThan(400);
  });
  it('a database with the bundled names resolves them with no download', async () => {
    const fresh = openDb(':memory:');
    await loadJsonl(fresh, (async function* () { yield JSON.stringify(horn); })());
    expect(resolveCardName(fresh, 'Avengers Monitoring Station')?.name).toBe("Herald's Horn");
  });
  it('parses a names file and rejects other JSON', () => {
    expect(parseNamesFile('{"version":"v","names":[["A","a"],["bad"],[1,2]]}')).toEqual({ version: 'v', names: [['A', 'a']] });
    expect(() => parseNamesFile('{"hello":1}')).toThrow(/card names file/);
  });
});

describe('refreshing the names', () => {
  const setup = (fetchImpl: typeof fetch, extra: { localNames?: string } = {}) => {
    const dataDir = tmpDir();
    const dbm = openDb(dbPathFor(dataDir));
    return { dataDir, dbm, data: new DataManager({ dataDir, db: dbm, fetch: fetchImpl, ...extra }) };
  };
  const body = JSON.stringify({ version: 'v-new', names: [['Brand New Name', 'oid-x']] });
  const fake = (nameResponse: () => Response) => {
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      const rules = rulesResponse(u);
      if (rules) return rules;
      if (u.endsWith('/bulk-data')) return Response.json({ data: [{ type: 'oracle_cards', updated_at: 'v1', jsonl_download_uri: 'https://data.scryfall.io/oracle.jsonl.gz' }] });
      if (u === NAMES_URL) return nameResponse();
      return new Response(gzipSync(toJsonl([sol])));
    }) as typeof fetch;
    return { impl, calls };
  };
  const aliasCount = (d: Db) => (d.prepare('SELECT count(*) AS n FROM card_aliases').get() as { n: number }).n;
  const version = (d: Db) => (d.prepare("SELECT value FROM meta WHERE key = 'names_version'").get() as { value: string } | undefined)?.value;

  it('replaces the bundled names with the published list, then leaves them for a week', async () => {
    const f = fake(() => new Response(body));
    const { data, dbm } = setup(f.impl);
    data.start(); await data.idle();
    expect(data.status().warning).toBeUndefined();
    expect(aliasCount(dbm)).toBe(1);
    expect(version(dbm)).toBe('v-new');
    expect(dbm.prepare('SELECT card_id FROM card_aliases WHERE alias = ?').get('brand new name')).toMatchObject({ card_id: 'oid-x' });
    data.start(); await data.idle();
    expect(f.calls.filter((u) => u === NAMES_URL)).toHaveLength(1);
    data.start({ force: true }); await data.idle();
    expect(f.calls.filter((u) => u === NAMES_URL)).toHaveLength(2);
  });
  it('nothing published yet, or a broken download, keeps the bundled names and shows no warning', async () => {
    for (const response of [() => new Response('not found', { status: 404 }), () => new Response('<html>captive portal</html>'), () => new Response('boom', { status: 500 })]) {
      const { data, dbm } = setup(fake(response).impl);
      data.start(); await data.idle();
      expect(data.status()).toMatchObject({ state: 'ready' });
      expect(data.status().warning).toBeUndefined();
      expect(aliasCount(dbm)).toBe(BUNDLED_NAMES.names.length);
    }
  });
  it('reads a local file when one is configured (offline installs, tests)', async () => {
    const dir = tmpDir();
    const file = join(dir, 'names.json');
    writeFileSync(file, body);
    const { data, dbm } = setup(fake(() => new Response('unused')).impl, { localNames: file });
    data.start(); await data.idle();
    expect(version(dbm)).toBe('v-new');
  });
  it('builds the list from a per-printing file', async () => {
    const dataDir = tmpDir();
    const dbm = openDb(dbPathFor(dataDir));
    const printings = [{ oracle_id: 'o1', name: 'One', flavor_name: 'Uno' }, { oracle_id: 'o2', name: 'Two' }];
    const impl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/bulk-data')) return Response.json({ data: [{ type: 'oracle_cards', updated_at: 'x', jsonl_download_uri: 'https://x/o.gz' }, { type: 'default_cards', updated_at: '2026-10-03T09:05:39.295+00:00', jsonl_download_uri: 'https://x/d.gz' }] });
      return new Response(gzipSync(printings.map((p) => JSON.stringify(p)).join('\n')));
    }) as typeof fetch;
    expect(await new DataManager({ dataDir, db: dbm, fetch: impl }).buildNames()).toEqual({ version: '2026-10-03', names: [['Uno', 'o1']] });
  });
});
