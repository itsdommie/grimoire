import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { createRouter, type ApiRequest, type ApiResponse } from './routes.js';
import { sfCard } from './testutil.js';

let db: Db;
let call: (req: ApiRequest) => Promise<ApiResponse>;
const get = (path: string, query?: Record<string, string>) => call({ method: 'GET', path, query });
const send = (method: string, path: string, body?: unknown) => call({ method, path, body });

beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, (async function* () {
    for (const c of [sfCard({ name: 'Sol Ring', type_line: 'Artifact', cmc: 1 }), sfCard({ name: 'Ur-Dragon, The', type_line: 'Legendary Creature — Dragon' })]) yield JSON.stringify(c);
  })());
  // The router is what the Android app calls in-process: no Fastify, no HTTP.
  call = createRouter({ db, data: { status: () => ({ state: 'ready' }) as never, start: () => {} }, semantic: {} as never });
});

describe('the in-process router', () => {
  it('serves JSON routes with query strings and returns 404 for unknown routes and wrong methods', async () => {
    expect(await get('/api/health')).toEqual({ status: 200, body: { ok: true } });
    const search = await get('/api/cards/search', { q: 'sol' });
    expect(search.status).toBe(200);
    expect((search.body as { cards: Array<{ name: string }> }).cards.map((c) => c.name)).toEqual(['Sol Ring']);
    expect((await get('/api/nope')).status).toBe(404);
    expect((await send('DELETE', '/api/health')).status).toBe(404);
  });

  it('decodes path parameters', async () => {
    const res = await get(`/api/cards/by-name/${encodeURIComponent('Ur-Dragon, The')}`);
    expect(res.status).toBe(200);
    expect((res.body as { name: string }).name).toBe('Ur-Dragon, The');
    expect((await get('/api/cards/by-name/Nobody')).status).toBe(404);
  });

  it('maps domain errors to statuses and a search syntax error to a 400 search response', async () => {
    expect(await send('POST', '/api/decks', { name: '  ' })).toMatchObject({ status: 400, body: { error: 'Deck name is required' } });
    expect((await get('/api/decks/99')).status).toBe(404);
    expect(await get('/api/decks/abc')).toMatchObject({ status: 400, body: { error: 'Invalid deck id' } });
    expect(await get('/api/cards/search', { q: 'cmc>>' })).toMatchObject({ status: 400, body: { total: 0, cards: [] } });
  });

  it('uses 201 / 204 and sends text with a type and download name for exports', async () => {
    const made = await send('POST', '/api/decks', { name: 'My Deck' });
    expect(made.status).toBe(201);
    const id = (made.body as { id: number }).id;
    const cardId = ((await get('/api/cards/by-name/Sol%20Ring')).body as { id: string }).id;
    await send('PUT', `/api/decks/${id}/cards`, { cardId, board: 'main', qty: 2 });
    const exported = await get(`/api/decks/${id}/export`, { style: 'plain' });
    expect(exported).toMatchObject({ status: 200, type: 'text/plain; charset=utf-8', headers: { 'Content-Disposition': 'attachment; filename="My_Deck.txt"' } });
    expect(exported.body).toContain('2 Sol Ring');
    expect(await send('DELETE', `/api/decks/${id}`)).toEqual({ status: 204, body: undefined });
    expect((await get(`/api/decks/${id}`)).status).toBe(404);
  });

  it('runs the collection and spare-copy flow end to end', async () => {
    const cardId = ((await get('/api/cards/by-name/Sol%20Ring')).body as { id: string }).id;
    await send('PUT', '/api/collection/cards', { cardId, qty: 2 });
    const deck = ((await send('POST', '/api/decks', { name: 'D' })).body as { id: number }).id;
    await send('PUT', `/api/decks/${deck}/cards`, { cardId, board: 'main', qty: 1 });
    const names = async (q: string, deckId?: number) => ((await get('/api/cards/search', { q, ...(deckId ? { deck: String(deckId) } : {}) })).body as { cards: Array<{ name: string }> }).cards.map((c) => c.name);
    expect(await names('spare>=2')).toEqual([]);
    expect(await names('spare>=1')).toEqual(['Sol Ring']);
    expect((await get('/api/collection/summary')).body).toMatchObject({ total: 2 });
    expect((await send('DELETE', '/api/collection')).status).toBe(204);
  });
});
