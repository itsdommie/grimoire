import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataStatus } from '@grimoire/shared';
import { dbPathFor, openDb } from './db.js';
import { buildServer } from './server.js';
import { sfCard, tmpDir, writeBulk } from './testutil.js';

const TOKEN = 'secret-token-123';

function desktopServer() {
  const dataDir = tmpDir();
  const webRoot = join(dataDir, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<html><head><meta name="grimoire-token" content="__GRIMOIRE_TOKEN__" /></head><body>app</body></html>');
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
  const db = openDb(dbPathFor(dataDir));
  return { dataDir, app: buildServer({ db, dataDir, webRoot, token: TOKEN, logger: false }) };
}

describe('desktop server protection', () => {
  it('serves the UI with the token injected, uncached, plus static assets', async () => {
    const { app } = desktopServer();
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`content="${TOKEN}"`);
    expect(page.body).not.toContain('__GRIMOIRE_TOKEN__');
    expect(page.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: '/assets/app.js' })).statusCode).toBe(200);
  });

  it('rejects API calls without the token or with a wrong one', async () => {
    const { app } = desktopServer();
    expect((await app.inject({ method: 'GET', url: '/api/decks', headers: { host: '127.0.0.1:1234' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/decks', headers: { host: '127.0.0.1:1234', 'x-grimoire-token': 'nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/data/update', headers: { host: '127.0.0.1:1234' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/decks', headers: { host: '127.0.0.1:1234', 'x-grimoire-token': TOKEN } })).statusCode).toBe(200);
  });

  it('rejects non-loopback Host headers even with the token (DNS rebinding)', async () => {
    const { app } = desktopServer();
    const res = await app.inject({ method: 'GET', url: '/api/decks', headers: { host: 'evil.example.com', 'x-grimoire-token': TOKEN } });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/decks', headers: { host: 'localhost:99', 'x-grimoire-token': TOKEN } })).statusCode).toBe(200);
  });

  it('sends no CORS headers in desktop mode', async () => {
    const { app } = desktopServer();
    const res = await app.inject({ method: 'GET', url: '/api/decks', headers: { host: '127.0.0.1:1', origin: 'https://evil.example', 'x-grimoire-token': TOKEN } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('data API', () => {
  it('reports empty, runs an update from a local file, then ready', async () => {
    const dataDir = tmpDir();
    const db = openDb(dbPathFor(dataDir));
    const app = buildServer({ db, dataDir, logger: false });
    const status = async () => (await app.inject({ method: 'GET', url: '/api/data/status' })).json() as DataStatus;
    expect(await status()).toMatchObject({ state: 'empty', cardCount: 0 });

    app.data.start({ file: writeBulk(dataDir, 'c.jsonl', [sfCard({ name: 'Sol Ring' })]) });
    await app.data.idle();
    expect(await status()).toMatchObject({ state: 'ready', cardCount: 1 });
    const search = (await app.inject({ method: 'GET', url: '/api/cards/search?q=sol' })).json() as { total: number };
    expect(search.total).toBe(1);
  });

  it('POST /api/data/update responds 202 immediately with the updating state', async () => {
    const dataDir = tmpDir();
    const app = buildServer({ db: openDb(dbPathFor(dataDir)), dataDir, logger: false });
    // Point the manager at an unreachable network so the update fails fast without real requests.
    (app.data as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () => { throw new TypeError('offline'); }) as typeof fetch;
    const res = await app.inject({ method: 'POST', url: '/api/data/update' });
    expect(res.statusCode).toBe(202);
    expect((res.json() as DataStatus).state).toBe('updating');
    await app.data.idle();
    expect(((await app.inject({ method: 'GET', url: '/api/data/status' })).json() as DataStatus)).toMatchObject({ state: 'error' });
  });

  it('maps a locked database (update in progress) to 503 on writes', async () => {
    const dataDir = tmpDir();
    const app = buildServer({ db: openDb(dbPathFor(dataDir)), dataDir, logger: false });
    const blocker = openDb(dbPathFor(dataDir));
    blocker.exec('BEGIN IMMEDIATE');
    const res = await app.inject({ method: 'POST', url: '/api/decks', payload: { name: 'x' } });
    blocker.exec('ROLLBACK');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('updating') });
  });
});
