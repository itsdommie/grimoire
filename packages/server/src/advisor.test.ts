import { beforeEach, describe, expect, it } from 'vitest';
import { dbPathFor, openDb, type NodeDb as Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { Advisor, AdvisorError, keyFromEnvironment, ADVISOR_MODELS, type KeyStore } from './advisor.js';
import { createRouter } from './routes.js';
import { createDeck, setCardQty } from './decks.js';
import { getCardByName } from './cards.js';
import { sfCard, tmpDir } from './testutil.js';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const CARDS = [
  sfCard({ name: 'Sol Ring', type_line: 'Artifact', mana_cost: '{1}', cmc: 1, oracle_text: '{T}: Add {C}{C}.', legalities: { commander: 'legal', modern: 'banned' } }),
  sfCard({ name: 'Rampant Growth', type_line: 'Sorcery', mana_cost: '{1}{G}', cmc: 2, color_identity: ['G'], colors: ['G'], oracle_text: 'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.' }),
  sfCard({ name: 'Counterspell', type_line: 'Instant', mana_cost: '{U}{U}', cmc: 2, color_identity: ['U'], colors: ['U'], oracle_text: 'Counter target spell.' }),
  sfCard({ name: 'Mana Drain', type_line: 'Instant', mana_cost: '{U}{U}', cmc: 2, color_identity: ['U'], colors: ['U'], oracle_text: 'Counter target spell. At the beginning of your next main phase, add an amount of {C} equal to that spell\'s mana value.', legalities: { commander: 'banned' } }),
  sfCard({ name: 'Forest', type_line: 'Basic Land — Forest', color_identity: ['G'], oracle_text: '({T}: Add {G}.)' }),
];
const asLines = (cards: unknown[]) => (async function* () { for (const c of cards) yield JSON.stringify(c); })();

let db: Db;
beforeEach(async () => { db = openDb(dbPathFor(tmpDir())); await loadJsonl(db, asLines(CARDS)); });

const memoryKeys = (initial: string | null = null, canStore = true): KeyStore => {
  let key = initial;
  return { canStore, get: () => key, set: (k) => { key = k; }, clear: () => { key = null; } };
};

/** A scripted stand-in for api.anthropic.com: replies in order and records every request. */
type Scripted = { status?: number; body: unknown } | Error;
function fakeApi(script: Scripted[]) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const next = script.shift();
    if (!next) throw new Error('the advisor asked for more than the script has');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { requests, fetchFn };
}
const text = (t: string) => ({ body: { stop_reason: 'end_turn', content: [{ type: 'text', text: t }] } });
const tool = (name: string, input: unknown, id = 'tu_1') => ({ body: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id, name, input }] } });
const ask = (content: string) => [{ role: 'user', content }];

const make = (script: Scripted[], extra: Partial<ConstructorParameters<typeof Advisor>[0]> = {}) => {
  const api = fakeApi(script);
  return { api, advisor: new Advisor({ db, keys: memoryKeys(KEY), fetch: api.fetchFn, ...extra }) };
};
const lastToolResult = (api: ReturnType<typeof fakeApi>, round = 1) => {
  const m = api.requests[round]!.body.messages.at(-1);
  return { ...m.content[0], parsed: (() => { try { return JSON.parse(m.content[0].content); } catch { return null; } })() };
};

describe('the key', () => {
  it('waits for a slow store (a phone\'s native one) before reporting the key as saved', async () => {
    let held: string | null = null;
    const slow: KeyStore = { canStore: true, get: () => held, set: async (k) => { await new Promise((r) => setTimeout(r, 20)); held = k; }, clear: async () => { await new Promise((r) => setTimeout(r, 20)); held = null; } };
    const advisor = new Advisor({ db, keys: keyFromEnvironment(slow, {}) });
    expect(await advisor.setKey(KEY)).toMatchObject({ configured: true, source: 'stored' });
    expect(await advisor.clearKey()).toMatchObject({ configured: false });
  });

  it('is configured from the environment, or from what the user saved, and says which', () => {
    const none = keyFromEnvironment(null, {});
    expect(none.get()).toBeNull();
    expect(new Advisor({ db, keys: none }).status()).toMatchObject({ configured: false, source: null, canStore: false });
    const env = keyFromEnvironment(null, { ANTHROPIC_API_KEY: ` ${KEY} ` });
    expect(env.get()).toBe(KEY);
    expect(new Advisor({ db, keys: env }).status()).toMatchObject({ configured: true, source: 'environment' });
    const stored = keyFromEnvironment(memoryKeys(KEY), { ANTHROPIC_API_KEY: 'sk-ant-other' });
    expect(new Advisor({ db, keys: stored }).status()).toMatchObject({ configured: true, source: 'stored' });
    expect(stored.get()).toBe(KEY); // what the user saved wins over the environment
  });

  it('is saved only when it looks like an Anthropic key, never shown again, and can be removed', async () => {
    const advisor = new Advisor({ db, keys: keyFromEnvironment(memoryKeys(), {}) });
    await expect(advisor.setKey('hunter2')).rejects.toThrow(/sk-ant-/);
    await expect(advisor.setKey(undefined)).rejects.toThrow(AdvisorError);
    const status = await advisor.setKey(`  ${KEY}\n`);
    expect(status).toMatchObject({ configured: true, source: 'stored' });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(await advisor.clearKey()).toMatchObject({ configured: false });
  });

  it('cannot be saved where nothing safe can keep it, and says what to do instead', async () => {
    const advisor = new Advisor({ db, keys: keyFromEnvironment(memoryKeys(null, false), {}) });
    expect(advisor.status().canStore).toBe(false);
    await expect(advisor.setKey(KEY)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('remembers the chosen model, and only accepts known ones', () => {
    const { advisor } = make([]);
    expect(advisor.status().model).toBe(ADVISOR_MODELS[0]!.id);
    expect(advisor.setModel('claude-haiku-4-5-20251001').model).toBe('claude-haiku-4-5-20251001');
    expect(advisor.status().model).toBe('claude-haiku-4-5-20251001');
    expect(() => advisor.setModel('gpt-4')).toThrow(/Unknown model/);
  });
});

describe('a conversation', () => {
  it('answers from database lookups: sends the key and tools, runs the search, returns only cards it really found', async () => {
    const { advisor, api } = make([
      tool('search_cards', { query: 'o:"counter target spell" f:commander' }),
      text('Take **Counterspell**: it is cheap. (You could also dream of **Mana Crypt**, but I never looked it up.)'),
    ]);
    const out = await advisor.chat(ask('best counterspell for my deck?'));
    expect(out.lookups).toBe(1);
    expect(out.reply).toContain('Counterspell');
    expect(out.cards.map((c) => c.name)).toEqual(['Counterspell']); // Mana Crypt was mentioned but never looked up: not offered as a card

    const first = api.requests[0]!;
    expect(first.url).toBe('https://api.anthropic.com/v1/messages');
    expect(first.headers['x-api-key']).toBe(KEY);
    expect(first.headers['anthropic-version']).toBe('2023-06-01');
    expect(first.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(first.body.model).toBe(ADVISOR_MODELS[0]!.id);
    expect(first.body.tools.map((t: { name: string }) => t.name)).toEqual(['search_cards', 'get_card', 'get_deck']);
    expect(first.body.system).toMatch(/Never suggest a card you have not seen in a tool result/);

    const result = lastToolResult(api);
    expect(result.tool_use_id).toBe('tu_1');
    expect(result.parsed.cards.map((c: { name: string }) => c.name)).toEqual(['Counterspell']); // Mana Drain is banned in commander, so f:commander left it out
    expect(result.parsed.cards[0]).toMatchObject({ cost: '{U}{U}', legal_in_commander: 'legal' });
    expect(api.requests[1]!.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('can be told a card is banned: legality for the deck format is in every result', async () => {
    const { advisor, api } = make([tool('get_card', { name: 'mana drain' }), text('Mana Drain is banned in Commander.')]);
    await advisor.chat(ask('is mana drain ok?'));
    const parsed = lastToolResult(api).parsed;
    expect(parsed).toMatchObject({ name: 'Mana Drain', legal_in_commander: 'banned' });
    expect(parsed.legalities.commander).toBe('banned');
  });

  it('tells the model when a card does not exist, and when a search is malformed or needs the index, instead of failing', async () => {
    const { advisor, api } = make([
      tool('get_card', { name: 'Black Lotus Prime' }, 'a'),
      tool('search_cards', { query: 'c:' }, 'b'),
      tool('search_cards', { query: 'about:"protect my commander"' }, 'c'),
      text('Sorry, nothing found.'),
    ]);
    const out = await advisor.chat(ask('hi'));
    expect(out.reply).toBe('Sorry, nothing found.');
    expect(lastToolResult(api, 1).parsed.error).toMatch(/No card is named/);
    expect(lastToolResult(api, 2).is_error).toBe(true);
    const third = lastToolResult(api, 3);
    expect(third.is_error).toBe(true);
    expect(third.content).toMatch(/set up|semantic/i);
  });

  it('uses the ranking for about: searches when semantic search is available', async () => {
    const { advisor, api } = make([tool('search_cards', { query: 'about:"anything" t:instant' }), text('ok')], {
      rankerFor: async () => ({ rank: (ids) => ids.map((id) => ({ id, score: id === getCardByName(db, 'Mana Drain')!.id ? 1 : 0 })) }),
    });
    await advisor.chat(ask('x'));
    expect(lastToolResult(api).parsed.cards[0].name).toBe('Mana Drain');
  });

  it('shows the open deck, its problems and its analysis, and only works with a deck open', async () => {
    const deck = createDeck(db, 'Ramp', 'commander');
    setCardQty(db, deck.id, getCardByName(db, 'Mana Drain')!.id, 'main', 1);
    setCardQty(db, deck.id, getCardByName(db, 'Forest')!.id, 'main', 3);
    const { advisor, api } = make([tool('get_deck', {}), text('Your deck has a banned card.')]);
    await advisor.chat(ask('review my deck'), { deckId: deck.id });
    const parsed = lastToolResult(api).parsed;
    expect(parsed).toMatchObject({ name: 'Ramp', format: 'commander', main: ['3 Forest', '1 Mana Drain'] });
    expect(parsed.problems.join(' ')).toMatch(/Banned in Commander: Mana Drain/);
    expect(parsed.analysis.curve).toBeDefined();
    expect(parsed.analysis.roles.length).toBeGreaterThan(0);

    const none = make([tool('get_deck', {}), text('You have no deck open.')]);
    await none.advisor.chat(ask('review my deck'));
    expect(lastToolResult(none.api).parsed.error).toMatch(/No deck is open/);
  });

  it('judges legality by the open deck\'s format', async () => {
    const deck = createDeck(db, 'Modern pile', 'modern');
    const { advisor, api } = make([tool('get_card', { name: 'Sol Ring' }), text('Banned in Modern.')]);
    await advisor.chat(ask('sol ring?'), { deckId: deck.id });
    expect(lastToolResult(api).parsed).toMatchObject({ legal_in_modern: 'banned' });
  });

  it('adds the browser-access header only when a page (not the desktop server) makes the call', async () => {
    const { advisor, api } = make([text('hi')], { directBrowserAccess: true });
    await advisor.chat(ask('hello'));
    expect(api.requests[0]!.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('gives up after too many lookups', async () => {
    const script: Scripted[] = Array.from({ length: 5 }, () => tool('search_cards', { query: 'Sol' }));
    const { advisor } = make(script, { maxRounds: 3 });
    await expect(advisor.chat(ask('x'))).rejects.toThrow(/too many lookups/);
  });
});

describe('when things go wrong', () => {
  const failing = (status: number, body: unknown = { error: { message: 'detail from the API' } }) => make([{ status, body }]);

  it.each([
    [401, 401, /rejected the API key/],
    [403, 401, /rejected the API key/],
    [429, 429, /too many requests/],
    [529, 502, /overloaded/],
    [500, 502, /overloaded|unavailable/],
    [400, 502, /error \(400\).*detail from the API/],
  ])('maps Anthropic status %i to a plain message', async (apiStatus, status, message) => {
    const { advisor } = failing(apiStatus);
    const err = await advisor.chat(ask('hi')).catch((e: AdvisorError) => e);
    expect(err).toBeInstanceOf(AdvisorError);
    expect((err as AdvisorError).status).toBe(status);
    expect((err as AdvisorError).message).toMatch(message);
    expect((err as AdvisorError).message).not.toContain(KEY);
  });

  it('says so when offline', async () => {
    const { advisor } = make([new Error('getaddrinfo ENOTFOUND api.anthropic.com')]);
    await expect(advisor.chat(ask('hi'))).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/Couldn't reach Anthropic/) });
  });

  it('asks for a key when there is none, without calling out', async () => {
    const api = fakeApi([]);
    const advisor = new Advisor({ db, keys: memoryKeys(null), fetch: api.fetchFn });
    await expect(advisor.chat(ask('hi'))).rejects.toMatchObject({ status: 409 });
    expect(api.requests).toHaveLength(0);
  });

  it.each([
    ['nothing', []],
    ['not a list', 'hello'],
    ['a bad role', [{ role: 'system', content: 'x' }]],
    ['a huge message', [{ role: 'user', content: 'x'.repeat(8001) }]],
    ['ending on the advisor', [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]],
    
  ])('rejects %s without calling out', async (_why, messages) => {
    const { advisor, api } = make([]);
    await expect(advisor.chat(messages)).rejects.toMatchObject({ status: 400 });
    expect(api.requests).toHaveLength(0);
  });

  it('only sends the latest part of a long conversation', async () => {
    const long = Array.from({ length: 41 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }));
    const { advisor, api } = make([text('ok')]);
    await advisor.chat(long);
    const sent = api.requests[0]!.body.messages;
    expect(sent.length).toBeLessThanOrEqual(24);
    expect(sent[0].role).toBe('user');
  });
});

describe('through the API routes', () => {
  it('reports status, saves and removes a key, and never returns it', async () => {
    const call = createRouter({ db, data: {} as never, semantic: {} as never, advisor: { keys: keyFromEnvironment(memoryKeys(), {}) } });
    expect((await call({ method: 'GET', path: '/api/advisor/status' })).body).toMatchObject({ configured: false, canStore: true });
    const bad = await call({ method: 'PUT', path: '/api/advisor/key', body: { key: 'nope' } });
    expect(bad.status).toBe(400);
    const ok = await call({ method: 'PUT', path: '/api/advisor/key', body: { key: KEY } });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain(KEY);
    expect((await call({ method: 'GET', path: '/api/advisor/status' })).body).toMatchObject({ configured: true, source: 'stored' });
    expect((await call({ method: 'DELETE', path: '/api/advisor/key' })).body).toMatchObject({ configured: false });
  });

  it('answers a chat, and turns advisor errors into status codes with a message', async () => {
    const api = fakeApi([text('Use Sol Ring.'), { status: 401, body: {} }]);
    const call = createRouter({ db, data: {} as never, semantic: {} as never, advisor: { keys: memoryKeys(KEY), fetch: api.fetchFn } });
    const good = await call({ method: 'POST', path: '/api/advisor/chat', body: { messages: ask('help') } });
    expect(good).toMatchObject({ status: 200, body: { reply: 'Use Sol Ring.', cards: [], lookups: 0 } });
    const rejected = await call({ method: 'POST', path: '/api/advisor/chat', body: { messages: ask('help') } });
    expect(rejected.status).toBe(401);
    expect((rejected.body as { error: string }).error).toMatch(/rejected the API key/);
  });

  it('without any advisor setup says it is not configured', async () => {
    const call = createRouter({ db, data: {} as never, semantic: {} as never });
    expect((await call({ method: 'GET', path: '/api/advisor/status' })).body).toMatchObject({ configured: false, canStore: false });
    expect((await call({ method: 'POST', path: '/api/advisor/chat', body: { messages: ask('hi') } })).status).toBe(409);
  });
});
