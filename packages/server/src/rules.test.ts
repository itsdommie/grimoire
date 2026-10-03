import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseComprehensiveRules, type CardDetail, type RuleDetail, type RulesSearchResult, type RulesStatus, type RulesToc } from '@grimoire/shared';
import { dbPathFor, openDb, type NodeDb as Db } from './db.js';
import { DataManager, findRulesUrl } from './data.js';
import { loadJsonl } from './ingest.js';
import { ftsAnyQuery, ftsQuery, getRuleDetail, keywordInfo, loadRules, rulesStatus, rulesToc, searchRules } from './rules.js';
import { buildServer } from './server.js';
import { RULES_PAGE_HTML, SAMPLE_RULES_TEXT, rulesResponse, sfCard, tmpDir, writeBulk } from './testutil.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  loadRules(db, parseComprehensiveRules(SAMPLE_RULES_TEXT));
});

describe('findRulesUrl', () => {
  it('finds the .txt link, which has a space in its name, and URL-encodes it', () => {
    expect(findRulesUrl(RULES_PAGE_HTML)).toBe('https://media.wizards.com/2026/downloads/MagicCompRules%2020260925.txt');
  });
  it('prefers the newest file when several are listed, and returns null without one', () => {
    const html = '<a href="https://media.wizards.com/2026/downloads/MagicCompRules 20260101.txt">a</a><a href="https://media.wizards.com/2026/downloads/MagicCompRules 20260925.txt">b</a>';
    expect(findRulesUrl(html)).toContain('20260925');
    expect(findRulesUrl('<a href="https://media.wizards.com/x/MagicCompRules 20260925.pdf">pdf only</a>')).toBeNull();
    expect(findRulesUrl('<html>nothing</html>')).toBeNull();
  });
});

describe('storing and browsing the rules', () => {
  it('reports what is loaded', () => {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('rules_effective', 'September 25, 2026')").run();
    expect(rulesStatus(db)).toEqual({ loaded: true, effective: 'September 25, 2026', rules: 9, glossary: 2 });
    expect(rulesStatus(openDb(':memory:'))).toEqual({ loaded: false, effective: null, rules: 0, glossary: 0 });
  });
  it('reloading replaces rather than duplicates', () => {
    loadRules(db, parseComprehensiveRules(SAMPLE_RULES_TEXT));
    expect(rulesStatus(db).rules).toBe(9);
    expect((db.prepare('SELECT count(*) AS n FROM rules_fts').get() as { n: number }).n).toBe(9);
  });
  it('has a table of contents grouped by section', () => {
    expect(rulesToc(db).sections.map((s) => [s.num, s.title, s.groups.map((g) => g.id)])).toEqual([[1, 'Game Concepts', ['100']], [7, 'Additional Rules', ['702']]]);
  });
  it('shows a rule with its ancestors and children', () => {
    const d = getRuleDetail(db, '702.19b')!;
    expect(d.rule).toMatchObject({ id: '702.19b', kind: 'subrule', sectionTitle: 'Additional Rules' });
    expect(d.ancestors.map((a) => a.id)).toEqual(['702', '702.19']);
    expect(d.children).toEqual([]);
    const parent = getRuleDetail(db, '702.19')!;
    expect(parent.children.map((c) => c.id)).toEqual(['702.19a', '702.19b']);
    expect(getRuleDetail(db, '999.9')).toBeNull();
  });
});

describe('searching the rules', () => {
  it('builds safe full-text queries (every word, last one as a prefix)', () => {
    expect(ftsQuery('Trample over!')).toBe('"trample" "over"*');
    expect(ftsQuery('"; DROP TABLE rules; --')).toBe('"drop" "table" "rules"*');
    expect(ftsQuery('   ')).toBeNull();
    expect(ftsQuery('é-ü')).toBe('"é" "ü"*');
  });
  it('answers plain-English questions by falling back to any of the meaningful words', () => {
    expect(ftsAnyQuery('What happens when a creature with trample is blocked?')).toBe('"creature" OR "trample" OR "blocked"');
    expect(ftsAnyQuery('trample')).toBeNull(); // a single word needs no fallback
    // No rule contains both words, but each is in one: the fallback still finds them.
    const r = searchRules(db, 'flying trample');
    expect(r.rules.map((x) => x.id).sort()).toEqual(['702.19', '702.19a', '702.19b', '702.9', '702.9a'].sort());
  });
  it('finds rules by words, with stemming and prefixes', () => {
    expect(searchRules(db, 'assigns damage').rules[0]!.id).toBe('702.19b'); // "assigns" stems to "assign"; the rule with both words ranks first
    expect(searchRules(db, 'evas').rules.map((r) => r.id)).toEqual(['702.9a']); // prefix of "evasion"
    expect(searchRules(db, 'two-player').rules.map((r) => r.id)).toContain('100.1a');
    expect(searchRules(db, 'zzzz nothing').rules).toEqual([]);
  });
  it('jumps straight to a rule when given its number, in several spellings', () => {
    for (const q of ['702.19b', 'rule 702.19b', 'Rules 702.19b.', ' 702.19B ']) expect(searchRules(db, q).exact?.id, q).toBe('702.19b');
    expect(searchRules(db, '702.19').exact?.id).toBe('702.19');
    expect(searchRules(db, '123.4').exact).toBeNull();
    expect(searchRules(db, '702.19b').rules).toEqual([]); // just that rule, no text matches for its digits
  });
  it('puts matching glossary terms (with the rule they point to) alongside rule results', () => {
    const r = searchRules(db, 'trample');
    expect(r.glossary[0]).toMatchObject({ term: 'Trample', rule: '702.19' });
    expect(r.rules.some((x) => x.id === '702.19a')).toBe(true);
    expect(searchRules(db, 'flying').glossary.map((g) => g.term)).toContain('Flying');
  });
  it('is not injectable', () => {
    expect(() => searchRules(db, `x" OR rules MATCH "y`)).not.toThrow();
    expect(() => searchRules(db, "'; DROP TABLE rules; --")).not.toThrow();
    expect(rulesStatus(db).loaded).toBe(true);
  });
});

describe('keywords on cards', () => {
  it('explains a card\'s keyword abilities from the glossary (case-insensitively), once each', () => {
    const k = keywordInfo(db, ['Flying', 'trample', 'Flying', 'Unknown Ability']);
    expect(k.map((x) => [x.term, x.rule])).toEqual([['Flying', '702.9'], ['Trample', '702.19']]);
  });
});

describe('updating the rules', () => {
  const setup = (fetchImpl: typeof fetch, extra: ConstructorParameters<typeof DataManager>[0] extends infer O ? Partial<O> : never = {}) => {
    const dataDir = tmpDir();
    const dbm = openDb(dbPathFor(dataDir));
    return { dataDir, dbm, dm: new DataManager({ dataDir, db: dbm, fetch: fetchImpl, ...extra } as never) };
  };
  const cardsOnly = (calls: string[], rules: 'ok' | 'page-down' | 'no-link' | 'bad-file' = 'ok') => (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/bulk-data')) return Response.json({ data: [{ type: 'oracle_cards', updated_at: 'v1', jsonl_download_uri: 'https://x/cards.jsonl.gz' }] });
    if (u.includes('magic.wizards.com')) return rules === 'page-down' ? new Response('no', { status: 503 }) : new Response(rules === 'no-link' ? '<html></html>' : RULES_PAGE_HTML);
    if (u.includes('media.wizards.com')) return new Response(rules === 'bad-file' ? 'this is not the rules' : SAMPLE_RULES_TEXT);
    const { gzipSync } = await import('node:zlib');
    return new Response(new Uint8Array(gzipSync(JSON.stringify(sfCard({ name: 'Sol Ring' })) + '\n')));
  }) as typeof fetch;

  it('finds the current file on Wizards\' page, downloads and imports it, and does not download again', async () => {
    const calls: string[] = [];
    const { dm, dbm } = setup(cardsOnly(calls));
    dm.start(); await dm.idle();
    expect(rulesStatus(dbm)).toMatchObject({ loaded: true, effective: 'September 25, 2026', rules: 9 });
    expect(dm.status().warning).toBeUndefined();
    expect(calls.filter((u) => u.includes('media.wizards.com'))).toEqual(['https://media.wizards.com/2026/downloads/MagicCompRules%2020260925.txt']);
    dm.start(); await dm.idle();
    expect(calls.filter((u) => u.includes('media.wizards.com'))).toHaveLength(1); // same file name: nothing to do
    dm.start({ force: true }); await dm.idle();
    expect(calls.filter((u) => u.includes('media.wizards.com'))).toHaveLength(2); // a forced update re-downloads
  });

  it.each([
    ['page-down', /rules: couldn't reach Wizards \(HTTP 503\)/],
    ['no-link', /rules: couldn't find the current Comprehensive Rules/],
    ['bad-file', /rules: .*Comprehensive Rules/],
  ] as const)('a problem with the rules (%s) is a warning: the cards are still fine', async (problem, message) => {
    const { dm } = setup(cardsOnly([], problem));
    dm.start(); await dm.idle();
    expect(dm.status()).toMatchObject({ state: 'ready', cardCount: 1, outdated: true });
    expect(dm.status().warning).toMatch(message);
  });

  it('imports from a local file (offline installs) and reports not outdated', async () => {
    const dataDir = tmpDir();
    const file = join(dataDir, 'cr.txt');
    writeFileSync(file, SAMPLE_RULES_TEXT);
    const dbm = openDb(dbPathFor(dataDir));
    const dm = new DataManager({ dataDir, db: dbm, localFile: writeBulk(dataDir, 'c.jsonl', [sfCard({ name: 'Sol Ring' })]), localRules: file });
    expect(rulesStatus(dbm).loaded).toBe(false);
    dm.start(); await dm.idle();
    expect(rulesStatus(dbm).loaded).toBe(true);
    expect(dm.status().outdated).toBeUndefined();
  });

  it('installs from before the rules existed are flagged outdated so they fetch them on their own', async () => {
    const { dm, dbm } = setup(cardsOnly([]));
    dm.start(); await dm.idle();
    // This fake Scryfall has no rulings/tags, so mark those as done and isolate the rules.
    dbm.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('rulings_updated_at', 'x'), ('tags_updated_at', 'x')").run();
    expect(dm.status().outdated).toBeUndefined();
    dbm.prepare("DELETE FROM meta WHERE key = 'rules_url'").run();
    expect(dm.status().outdated).toBe(true);
    dm.start(); await dm.idle();
    expect(dm.status().outdated).toBeUndefined();
  });
});

describe('rules API', () => {
  it('serves status, search, toc and a single rule; unknown rules are 404', async () => {
    const app = buildServer({ db, dataDir: '/x', logger: false });
    const get = async <T>(url: string) => { const r = await app.inject({ method: 'GET', url }); return { status: r.statusCode, body: r.json() as T }; };
    expect((await get<RulesStatus>('/api/rules/status')).body.loaded).toBe(true);
    expect((await get<RulesToc>('/api/rules/toc')).body.sections).toHaveLength(2);
    const s = (await get<RulesSearchResult>('/api/rules/search?q=trample')).body;
    expect(s.glossary[0]!.term).toBe('Trample');
    expect((await get<RulesSearchResult>('/api/rules/search?q=rule%20702.19b')).body.exact?.id).toBe('702.19b');
    expect((await get<RuleDetail>('/api/rules/rule/702.19')).body.children).toHaveLength(2);
    expect((await get('/api/rules/rule/000.0')).status).toBe(404);
    expect((await get<RulesSearchResult>('/api/rules/search')).body).toEqual({ rules: [], glossary: [], exact: null });
  });

  it('card details include explanations of the card\'s keyword abilities', async () => {
    await loadJsonl(db, (async function* () { yield JSON.stringify(sfCard({ name: 'Dragon', type_line: 'Creature — Dragon', oracle_id: 'o-dragon', keywords: ['Flying', 'Trample'] })); })());
    const app = buildServer({ db, dataDir: '/x', logger: false });
    const d = (await app.inject({ method: 'GET', url: '/api/cards/o-dragon/detail' })).json() as CardDetail;
    expect(d.keywords.map((k) => [k.term, k.rule])).toEqual([['Flying', '702.9'], ['Trample', '702.19']]);
    expect(rulesResponse('https://example.com')).toBeNull();
  });
});
