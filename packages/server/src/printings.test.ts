import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CollectionImportResult, PrintingIdentification, PrintingInfo, UserDataBackup } from '@grimoire/shared';
import { dbPathFor, openDb, type NodeDb as Db } from './db.js';
import { DataManager, PRINTINGS_BASE, PRINTINGS_MANIFEST } from './data.js';
import { loadJsonl } from './ingest.js';
import { collectPrintings, loadPrintings, parsePrintingsFile, printingRow, identifyPrinting, listPrintings, type PrintingsFile, type RawPrinting } from './printings.js';
import { findPrinting, importCollection, setOwned, setOwnedPrinting, collectionSummary, clearCollection } from './collection.js';
import { exportUserData, restoreUserData } from './backup.js';
import { getCardByName } from './cards.js';
import { buildServer } from './server.js';
import { rulesResponse, sfCard, tmpDir, toJsonl } from './testutil.js';

const SOL = 'oid-sol', BOLT = 'oid-bolt', FIRE = 'oid-fire', GONE = 'oid-not-a-card-we-have';
const sol = sfCard({ name: 'Sol Ring', oracle_id: SOL, type_line: 'Artifact' });
const bolt = sfCard({ name: 'Lightning Bolt', oracle_id: BOLT, type_line: 'Instant' });
const fire = sfCard({ name: 'Fire // Ice', oracle_id: FIRE, layout: 'split', type_line: 'Instant // Instant', image_uris: { normal: 'x' } });
const SETS: PrintingsFile['sets'] = [['lea', 'Limited Edition Alpha', '1993-08-05'], ['2xm', 'Double Masters', '2020-08-07'], ['c21', 'Commander 2021', '2021-04-23'], ['cmm', 'Commander Masters', '2023-08-04']];
const row = (id: string, card: string, set: string, collector: string, finishes: number, usd: number, released: string): PrintingsFile['rows'][number] => [id, card, set, collector, finishes, usd, usd * 2, 0, released];
const FILE: PrintingsFile = {
  version: 'v1', sets: SETS,
  rows: [
    row('sol-lea', SOL, 'lea', '269', 1, 900, '1993-08-05'),
    row('sol-c21', SOL, 'c21', '263', 1, 2, '2021-04-23'),
    row('sol-cmm', SOL, 'cmm', '400', 3, 3, '2023-08-04'),
    row('sol-cmm-b', SOL, 'cmm', '400★', 2, 30, '2023-08-04'),
    row('sol-cmm-9', SOL, 'cmm', '9', 1, 1, '2023-08-04'),
    row('bolt-2xm', BOLT, '2xm', '117', 3, 2, '2020-08-07'),
    row('bolt-lea', BOLT, 'lea', '161', 1, 400, '1993-08-05'),
    row('fire-cmm', FIRE, 'cmm', '300', 1, 1, '2023-08-04'),
    row('ghost', GONE, 'cmm', '1', 1, 1, '2023-08-04'),
  ],
};

let db: Db;
beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, (async function* () { for (const c of [sol, bolt, fire]) yield JSON.stringify(c); })());
  loadPrintings(db, FILE);
});
const printing = (db2: Db, id: string) => (listPrintings(db2, id.startsWith('sol') ? SOL : id.startsWith('bolt') ? BOLT : FIRE).find((p) => p.id === id))!;

describe('building the printings file', () => {
  it('keeps paper printings, with finishes, prices and the earliest date of each set', async () => {
    const lines = [
      { id: 'a', oracle_id: 'o', set: 'tst', set_name: 'Test Set', collector_number: '5', released_at: '2020-05-01', finishes: ['nonfoil', 'foil'], prices: { usd: '1.50', usd_foil: '4' } },
      { id: 'b', oracle_id: 'o', set: 'tst', set_name: 'Test Set', collector_number: '6', released_at: '2020-01-01', finishes: ['etched'], prices: {} },
      { id: 'c', oracle_id: 'o', set: 'dig', set_name: 'Arena', collector_number: '1', digital: true },
      { id: 'd', oracle_id: 'o', set: 'tok', set_name: 'Tokens', collector_number: '1', layout: 'token' },
      { id: 'e', oracle_id: 'o', set: 'mtgo', set_name: 'Online', collector_number: '1', games: ['mtgo'] },
      { oracle_id: 'o', set: 'x', collector_number: '1' },
    ];
    const file = await collectPrintings((async function* () { for (const l of lines) yield JSON.stringify(l); })(), 'v');
    expect(file.rows.map((r) => r[0])).toEqual(['b', 'a']); // sorted by card then date; digital, token, online-only and idless dropped
    expect(file.rows.find((r) => r[0] === 'a')).toEqual(['a', 'o', 'tst', '5', 3, 1.5, 4, 0, '2020-05-01']);
    expect(file.rows.find((r) => r[0] === 'b')![4]).toBe(4);
    expect(file.sets).toEqual([['tst', 'Test Set', '2020-01-01']]);
  });
  it('defaults an unlisted finish to nonfoil and treats missing prices as unknown', () => {
    expect(printingRow({ id: 'a', oracle_id: 'o', set: 's', collector_number: '1' } as RawPrinting)).toEqual(['a', 'o', 's', '1', 1, 0, 0, 0, '']);
  });
  it('parses its own output and rejects anything else', () => {
    expect(parsePrintingsFile(JSON.stringify(FILE)).rows).toHaveLength(FILE.rows.length);
    expect(() => parsePrintingsFile('{"x":1}')).toThrow(/printings file/);
  });
});

describe('loading and listing', () => {
  it('keeps printings of cards we have, and replaces them on reload without touching what you own', () => {
    expect((db.prepare('SELECT count(*) AS n FROM printings').get() as { n: number }).n).toBe(8); // not the ghost
    setOwnedPrinting(db, 'sol-cmm', 'foil', 2);
    loadPrintings(db, { ...FILE, rows: FILE.rows.slice(0, 3) });
    expect((db.prepare('SELECT count(*) AS n FROM printings').get() as { n: number }).n).toBe(3);
    expect(getCardByName(db, 'Sol Ring')).toMatchObject({ owned: 2, ownedPrinting: { id: 'sol-cmm', finish: 'foil' } });
  });
  it('lists newest first with the set, art and how many of each you own', () => {
    setOwnedPrinting(db, 'sol-cmm', 'foil', 1);
    const list = listPrintings(db, SOL);
    expect(list.map((p) => p.id)).toEqual(['sol-cmm-9', 'sol-cmm', 'sol-cmm-b', 'sol-c21', 'sol-lea']);
    expect(list[1]).toMatchObject({ set: 'cmm', setName: 'Commander Masters', collector: '400', finishes: ['nonfoil', 'foil'], owned: { nonfoil: 0, foil: 1, etched: 0 }, usd: 3, usdFoil: 6 });
    expect(list[1]!.imageUrl).toBe('https://cards.scryfall.io/normal/front/s/o/sol-cmm.jpg');
    expect(list[1]!.imageUrlBack).toBeNull();
  });
});

describe('which printing is this card?', () => {
  const id = (hints: Parameters<typeof identifyPrinting>[2], card = SOL): PrintingIdentification => identifyPrinting(db, card, hints);
  it('set code and number settle it', () => {
    expect(id({ set: 'c21', number: '263' })).toMatchObject({ basis: 'set-and-number', printing: { id: 'sol-c21' } });
    expect(id({ set: 'lea', number: '269' }).printing?.id).toBe('sol-lea');
  });
  it('compares numbers by their digits and prefers the plain number to a "★" variant', () => {
    expect(id({ set: 'cmm', number: '400' })).toMatchObject({ basis: 'set-and-number', printing: { id: 'sol-cmm' } });
    expect(id({ set: 'cmm', number: '9' }).printing?.id).toBe('sol-cmm-9');
  });
  it('a set alone narrows to that set, and is not certain if it has several', () => {
    const r = id({ set: 'cmm' });
    expect(r.basis).toBe('set'); expect(r.printing).toBeNull();
    expect(r.candidates.map((p) => p.id)).toEqual(['sol-cmm-9', 'sol-cmm', 'sol-cmm-b']);
    expect(id({ set: 'c21' }).printing?.id).toBe('sol-c21');
  });
  it('forgives a set code misread by one character, if it points to one set', () => {
    expect(id({ set: 'cmn', number: '400' }).printing?.id).toBe('sol-cmm');
    expect(id({ set: 'c2l', number: '263' }).printing?.id).toBe('sol-c21');
    expect(id({ set: 'zzz', number: '263' })).toMatchObject({ basis: 'number', printing: { id: 'sol-c21' } }); // unknown set: the number still helps
  });
  it('a number alone works when only one printing has it; a year narrows older cards', () => {
    expect(id({ number: '269' })).toMatchObject({ basis: 'number', printing: { id: 'sol-lea' } });
    expect(id({ year: 1993 })).toMatchObject({ basis: 'year', printing: { id: 'sol-lea' } });
    expect(id({ year: 2023 }).printing).toBeNull();
    expect(id({ year: 2023 }).candidates).toHaveLength(3);
  });
  it('with nothing to go on, offers every printing', () => {
    const r = id({});
    expect(r).toMatchObject({ basis: 'none', printing: null });
    expect(r.candidates).toHaveLength(5);
    expect(id({ number: '999' }).basis).toBe('none');
    expect(identifyPrinting(db, 'nope', { set: 'cmm' }).candidates).toEqual([]);
  });
  it('knows which printings have a back face', () => {
    expect(identifyPrinting(db, FIRE, { set: 'cmm', number: '300' }).printing?.imageUrlBack).toBeNull(); // fixture has no back image column
  });
});

describe('recording printings', () => {
  const total = (name = 'Sol Ring') => getCardByName(db, name)!.owned;
  it('adds copies of a printing and finish, moving the card total with them', () => {
    setOwnedPrinting(db, 'sol-cmm', 'nonfoil', 1);
    setOwnedPrinting(db, 'sol-cmm', 'foil', 2);
    setOwnedPrinting(db, 'sol-c21', 'nonfoil', 1);
    expect(total()).toBe(4);
    expect(printing(db, 'sol-cmm').owned).toEqual({ nonfoil: 1, foil: 2, etched: 0 });
    setOwnedPrinting(db, 'sol-cmm', 'foil', 0);
    expect(total()).toBe(2);
    expect(printing(db, 'sol-cmm').owned.foil).toBe(0);
  });
  it('copies with no recorded printing stay unrecorded unless claimed', () => {
    setOwned(db, SOL, 3);
    setOwnedPrinting(db, 'sol-cmm', 'nonfoil', 1); // another copy: 4 in all
    expect(total()).toBe(4);
    setOwnedPrinting(db, 'sol-c21', 'nonfoil', 1, { claim: true }); // one of the ones I already had: still 4
    expect(total()).toBe(4);
    setOwnedPrinting(db, 'sol-lea', 'nonfoil', 3, { claim: true }); // 1 + 1 + 3 = 5 recorded, so the total has to grow
    expect(total()).toBe(5);
  });
  it('refuses an unknown printing, a finish it does not come in, a bad finish and a bad count', () => {
    expect(() => setOwnedPrinting(db, 'nope', 'foil', 1)).toThrow(/Unknown printing/);
    expect(() => setOwnedPrinting(db, 'sol-lea', 'foil', 1)).toThrow(/doesn't come in foil/);
    expect(() => setOwnedPrinting(db, 'sol-cmm', 'shiny' as never, 1)).toThrow(/finish must be/);
    expect(() => setOwnedPrinting(db, 'sol-cmm', 'foil', -1)).toThrow(/qty/);
    expect(() => setOwnedPrinting(db, 'sol-cmm', 'foil', 1.5)).toThrow(/qty/);
    setOwnedPrinting(db, 'sol-lea', 'foil', 0); // removing a finish it never had is harmless
  });
  it('lowering the card total drops the oldest printing records first, and zero clears them', () => {
    setOwnedPrinting(db, 'sol-lea', 'nonfoil', 1);
    setOwnedPrinting(db, 'sol-c21', 'nonfoil', 1);
    db.prepare("UPDATE collection_prints SET updated_at = '2020-01-01' WHERE printing_id = 'sol-lea'").run();
    setOwned(db, SOL, 1);
    expect(printing(db, 'sol-lea').owned.nonfoil).toBe(0);
    expect(printing(db, 'sol-c21').owned.nonfoil).toBe(1);
    setOwned(db, SOL, 0);
    expect(printing(db, 'sol-c21').owned.nonfoil).toBe(0);
    expect(getCardByName(db, 'Sol Ring')).toMatchObject({ owned: 0 });
    expect(getCardByName(db, 'Sol Ring')!.ownedPrinting).toBeUndefined();
  });
  it('shows the art of the printing you own, and the featured art when you have not said', () => {
    expect(getCardByName(db, 'Sol Ring')!.imageUrl).toBeNull(); // (the fixture card has no art of its own)
    setOwnedPrinting(db, 'sol-lea', 'nonfoil', 1);
    expect(getCardByName(db, 'Sol Ring')).toMatchObject({ imageUrl: 'https://cards.scryfall.io/normal/front/s/o/sol-lea.jpg', ownedPrinting: { id: 'sol-lea', set: 'lea', collector: '269', finish: 'nonfoil' } });
    setOwnedPrinting(db, 'sol-c21', 'nonfoil', 1); // the most recently added one is shown
    expect(getCardByName(db, 'Sol Ring')!.ownedPrinting!.id).toBe('sol-c21');
    clearCollection(db);
    expect(getCardByName(db, 'Sol Ring')!.ownedPrinting).toBeUndefined();
    expect((db.prepare('SELECT count(*) AS n FROM collection_prints').get() as { n: number }).n).toBe(0);
  });
});

describe('importing a collection with printings', () => {
  const manabox = (rows: string[]) => 'Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID\n' + rows.join('\n');
  it('ties copies to the printing a row names, with its finish, and leaves the rest as the card\'s', () => {
    const r = importCollection(db, manabox([
      'Sol Ring,CMM,Commander Masters,400,foil,uncommon,2,1,',
      'Sol Ring,C21,Commander 2021,263,normal,uncommon,1,2,',
      'Sol Ring,ZZZ,Nowhere,1,normal,uncommon,4,3,',
      'Lightning Bolt,2XM,Double Masters,0117,normal,uncommon,1,4,',
    ]), 'replace') as CollectionImportResult;
    expect(r).toMatchObject({ imported: 8, unique: 2, withPrinting: 4, unresolved: [] });
    expect(printing(db, 'sol-cmm').owned).toEqual({ nonfoil: 0, foil: 2, etched: 0 });
    expect(printing(db, 'sol-c21').owned.nonfoil).toBe(1);
    expect(printing(db, 'bolt-2xm').owned.nonfoil).toBe(1); // "0117" finds "117"
    expect(getCardByName(db, 'Sol Ring')!.owned).toBe(7); // 2 + 1 recorded, 4 not
  });
  it('prefers the row\'s Scryfall ID, ignores one for another card, and falls back when a finish does not exist', () => {
    const r = importCollection(db, manabox([
      'Sol Ring,CMM,Commander Masters,400,normal,u,1,1,sol-lea',
      'Sol Ring,LEA,Alpha,269,foil,u,1,2,not-a-printing',
      'Lightning Bolt,LEA,Alpha,161,normal,u,1,3,sol-cmm',
    ]), 'replace');
    expect(r.withPrinting).toBe(3);
    expect(printing(db, 'sol-lea').owned).toEqual({ nonfoil: 2, foil: 0, etched: 0 }); // by id (row 1), and row 2's foil falls back to nonfoil: Alpha has none
    expect(printing(db, 'bolt-lea').owned.nonfoil).toBe(1); // the id belonged to Sol Ring, so the set and number were used
  });
  it('merge adds to the printings you have, replace starts over', () => {
    setOwnedPrinting(db, 'sol-lea', 'nonfoil', 1);
    importCollection(db, manabox(['Sol Ring,LEA,Alpha,269,normal,u,2,1,']), 'merge');
    expect(printing(db, 'sol-lea').owned.nonfoil).toBe(3);
    expect(getCardByName(db, 'Sol Ring')!.owned).toBe(3);
    importCollection(db, '1 Lightning Bolt', 'replace');
    expect(printing(db, 'sol-lea').owned.nonfoil).toBe(0);
    expect(findPrinting(db, SOL, 'cmm', '0400')?.id).toBe('sol-cmm');
    expect(findPrinting(db, SOL, 'cmm', '9')?.id).toBe('sol-cmm-9');
    expect(findPrinting(db, SOL, 'nope', '1')).toBeNull();
  });
  it('plain lists and files without set columns still import as before', () => {
    expect(importCollection(db, '3 Sol Ring', 'replace')).toMatchObject({ imported: 3, withPrinting: 0 });
    expect(collectionSummary(db).total).toBe(3);
  });
});

describe('backups carry printings', () => {
  it('round-trips which printing and finish, and still reads a backup from before printings', () => {
    setOwned(db, SOL, 2);
    setOwnedPrinting(db, 'sol-cmm', 'foil', 1, { claim: true });
    const backup = JSON.parse(JSON.stringify(exportUserData(db))) as UserDataBackup;
    expect(backup.collection[0]!.prints).toEqual([{ id: 'sol-cmm', set: 'cmm', collector: '400', finish: 'foil', qty: 1 }]);
    clearCollection(db);
    expect(restoreUserData(db, backup, 'replace')).toMatchObject({ collectionCopies: 2 });
    expect(getCardByName(db, 'Sol Ring')).toMatchObject({ owned: 2, ownedPrinting: { id: 'sol-cmm', finish: 'foil' } });

    const old = { ...backup, collection: [{ id: SOL, name: 'Sol Ring', qty: 4 }] };
    restoreUserData(db, old, 'replace');
    expect(getCardByName(db, 'Sol Ring')).toMatchObject({ owned: 4 });
    expect(getCardByName(db, 'Sol Ring')!.ownedPrinting).toBeUndefined();
  });
  it('rejects a malformed printing record, and never records more printings than copies', () => {
    const bad = { app: 'grimoire', version: 1, exportedAt: '', decks: [], collection: [{ id: SOL, name: 'x', qty: 1, prints: [{ id: 'p', finish: 'shiny', qty: 1 }] }] };
    expect(() => restoreUserData(db, bad, 'merge')).toThrow(/printing in the backup is malformed/);
    const over = { ...bad, collection: [{ id: SOL, name: 'x', qty: 1, prints: [{ id: 'sol-lea', set: '', collector: '', finish: 'nonfoil', qty: 1 }, { id: 'sol-c21', set: '', collector: '', finish: 'nonfoil', qty: 1 }] }] };
    restoreUserData(db, over, 'replace');
    expect((db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM collection_prints').get() as { n: number }).n).toBe(1);
  });
});

describe('the printing API', () => {
  it('lists printings, identifies from OCR lines, and records them', async () => {
    const app = buildServer({ db, dataDir: '/nonexistent', logger: false });
    const list = (await app.inject({ method: 'GET', url: `/api/cards/${SOL}/printings` })).json<{ printings: PrintingInfo[] }>();
    expect(list.printings).toHaveLength(5);
    const found = (await app.inject({ method: 'POST', url: '/api/cards/identify', payload: { cardId: SOL, lines: ['Add {2}', '263/387 U', 'C21 • EN > SOME ARTIST', 'TM & 2021 Wizards of the Coast'] } })).json<PrintingIdentification>();
    expect(found).toMatchObject({ basis: 'set-and-number', printing: { id: 'sol-c21', setName: 'Commander 2021' } });
    expect((await app.inject({ method: 'POST', url: '/api/cards/identify', payload: {} })).statusCode).toBe(400);
    const put = await app.inject({ method: 'PUT', url: '/api/collection/printings', payload: { printingId: 'sol-c21', finish: 'nonfoil', qty: 2 } });
    expect(put.json()).toMatchObject({ total: 2 });
    expect((await app.inject({ method: 'PUT', url: '/api/collection/printings', payload: { printingId: 'sol-lea', finish: 'foil', qty: 1 } })).statusCode).toBe(400);
    const claimed = await app.inject({ method: 'PUT', url: '/api/collection/printings', payload: { printingId: 'sol-lea', finish: 'nonfoil', qty: 1, claim: true } });
    expect(claimed.json()).toMatchObject({ total: 3 });
  });
});

describe('getting the printings', () => {
  const setup = (fetchImpl: typeof fetch, extra: { localPrintings?: string } = {}) => {
    const dataDir = tmpDir();
    const dbm = openDb(dbPathFor(dataDir));
    return { dataDir, dbm, data: new DataManager({ dataDir, db: dbm, fetch: fetchImpl, ...extra }) };
  };
  const gz = gzipSync(JSON.stringify(FILE));
  const cards = [sol, bolt, fire];
  const fake = (printings: { manifest: () => Response; file: () => Response }) => {
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      const rules = rulesResponse(u);
      if (rules) return rules;
      if (u.endsWith('/bulk-data')) return Response.json({ data: [{ type: 'oracle_cards', updated_at: 'v1', jsonl_download_uri: 'https://data.scryfall.io/oracle.jsonl.gz' }] });
      if (u === `${PRINTINGS_BASE}/${PRINTINGS_MANIFEST}`) return printings.manifest();
      if (u === `${PRINTINGS_BASE}/card-printings.json.gz`) return printings.file();
      if (u.includes('releases/download/card-names')) return new Response('nope', { status: 404 });
      return new Response(gzipSync(toJsonl(cards)));
    }) as typeof fetch;
    return { impl, calls };
  };
  const count = (d: Db) => (d.prepare('SELECT count(*) AS n FROM printings').get() as { n: number }).n;
  const version = (d: Db) => (d.prepare("SELECT value FROM meta WHERE key = 'printings_version'").get() as { value: string } | undefined)?.value;

  it('downloads the published file when the version changes, and not again until it does', async () => {
    const f = fake({ manifest: () => Response.json({ version: 'v1', file: 'card-printings.json.gz', count: 9, size: gz.length }), file: () => new Response(gz) });
    const { data, dbm } = setup(f.impl);
    data.start(); await data.idle();
    expect(data.status().warning).toBeUndefined();
    expect(count(dbm)).toBe(8); expect(version(dbm)).toBe('v1');
    data.start(); await data.idle();
    expect(f.calls.filter((u) => u.includes('card-printings'))).toHaveLength(2); // manifest + file, once
    data.start({ force: true }); await data.idle();
    expect(f.calls.filter((u) => u.endsWith('card-printings.json.gz'))).toHaveLength(2);
  });
  it('an unchanged version costs only the small manifest', async () => {
    const f = fake({ manifest: () => Response.json({ version: 'v1', file: 'card-printings.json.gz', count: 9, size: 1 }), file: () => new Response(gz) });
    const { data, dbm } = setup(f.impl);
    data.start(); await data.idle();
    dbm.prepare("DELETE FROM meta WHERE key = 'printings_checked_at'").run(); // a week passes
    data.start(); await data.idle();
    expect(f.calls.filter((u) => u.endsWith('card-printings.json.gz'))).toHaveLength(1);
    expect(f.calls.filter((u) => u.endsWith(PRINTINGS_MANIFEST))).toHaveLength(2);
  });
  it('nothing published, a broken manifest or a broken file keep the cards working with no warning', async () => {
    const cases = [
      { manifest: () => new Response('not found', { status: 404 }), file: () => new Response('') },
      { manifest: () => new Response('<html>', { status: 200 }), file: () => new Response('') },
      { manifest: () => Response.json({ version: 'v1', file: 'card-printings.json.gz', count: 1, size: 1 }), file: () => new Response('not gzip') },
      { manifest: () => new Response('boom', { status: 500 }), file: () => new Response('') },
    ];
    for (const c of cases) {
      const { data, dbm } = setup(fake(c).impl);
      data.start(); await data.idle();
      expect(data.status()).toMatchObject({ state: 'ready', cardCount: 3 });
      expect(data.status().warning).toBeUndefined();
      expect(dbm.prepare("SELECT value FROM meta WHERE key = 'printings_checked_at'").get()).toBeTruthy(); // it tried; it will ask again in a week, not on every start
      expect(count(dbm)).toBe(0);
    }
  });
  it('reads a local file, plain or gzipped', async () => {
    for (const [name, body] of [['p.json', JSON.stringify(FILE)], ['p.json.gz', gz]] as const) {
      const file = join(tmpDir(), name);
      writeFileSync(file, body);
      const { data, dbm } = setup(fake({ manifest: () => new Response('', { status: 404 }), file: () => new Response('') }).impl, { localPrintings: file });
      data.start(); await data.idle();
      expect(count(dbm)).toBe(8);
    }
  });
  it('builds the file from a per-printing download', async () => {
    const dataDir = tmpDir();
    const dbm = openDb(dbPathFor(dataDir));
    const body = gzipSync(toJsonl([{ id: 'p1', oracle_id: 'o', name: 'N', set: 'abc', set_name: 'Abc', collector_number: '7', released_at: '2024-01-01', finishes: ['nonfoil'], layout: 'normal', rarity: 'common', scryfall_uri: '' } as never]));
    const impl = (async (url: string | URL | Request) => String(url).endsWith('/bulk-data')
      ? Response.json({ data: [{ type: 'oracle_cards', updated_at: 'x', jsonl_download_uri: 'https://x/o.gz' }, { type: 'default_cards', updated_at: '2026-10-03T09:00:00+00:00', jsonl_download_uri: 'https://x/d.gz' }] })
      : new Response(body)) as typeof fetch;
    const file = await new DataManager({ dataDir, db: dbm, fetch: impl }).buildPrintings();
    expect(file).toMatchObject({ version: '2026-10-03', sets: [['abc', 'Abc', '2024-01-01']] });
    expect(file.rows).toEqual([['p1', 'o', 'abc', '7', 1, 0, 0, 0, '2024-01-01']]);
  });
});
