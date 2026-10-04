import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, type NodeDb as Db } from './db.js';
import { createRouter } from './routes.js';
import { SyncConflict, type SyncStore } from './sync.js';
import { SyncController, type SyncAuth } from './syncController.js';
import { FolderStore, SYNC_FILE_NAME } from './syncFolder.js';
import { SyncAuthError } from './syncDrive.js';
import { tmpDir } from './testutil.js';

/** A scheduler we can fire by hand. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>(); let n = 0;
  return {
    schedule: { set: (fn: () => void, ms: number) => { pending.set(++n, { fn, ms }); return n; }, clear: (h: unknown) => { pending.delete(h as number); } },
    count: () => pending.size,
    delays: () => [...pending.values()].map((p) => p.ms),
    /** How many timers with this delay are waiting. */
    waiting: (ms: number) => [...pending.values()].filter((p) => p.ms === ms).length,
    /** Fire the timers with this delay (and only those). */
    fire: (ms: number) => { const hit = [...pending.entries()].filter(([, p]) => p.ms === ms); for (const [id, p] of hit) { pending.delete(id); p.fn(); } },
  };
}

/** Google, as far as sync can tell: an account, tokens, and a sign-in that works or does not. */
function fakeAuth(over: Partial<{ available: boolean; signInFails: boolean }> = {}) {
  let account: string | null = null; const calls: string[] = [];
  const auth: SyncAuth = {
    available: () => over.available ?? true,
    account: async () => account,
    signIn: async () => { calls.push('signIn'); if (over.signInFails) throw new Error('The sign-in was closed.'); account = 'person@example.com'; },
    signOut: async () => { calls.push('signOut'); account = null; },
    accessToken: async () => 'tok',
  };
  return { auth, calls, signedIn: () => account };
}

/** A tiny fake of Drive's API with one file, enough for a DriveStore. */
function fakeDriveFetch(opts: { fail?: () => Response | null } = {}) {
  let text: string | null = null; let version = 0;
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const failure = opts.fail?.(); if (failure) return failure;
    const url = new URL(String(input)); const method = init.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/drive/v3/files') return Response.json({ files: text === null ? [] : [{ id: 'f1', version: String(version) }] });
    if (method === 'GET') return new Response(text ?? '');
    if (method === 'POST') { text = String(init.body).split('\r\n\r\n').slice(2).join('\r\n\r\n').replace(/\r\n--[^\r\n]+--$/, ''); return Response.json({ id: 'f1', version: String(++version) }); }
    text = String(init.body); return Response.json({ version: String(++version) });
  }) as typeof fetch;
}

const folderFactory = (p: string) => new FolderStore(p);
const make = (db: Db, o: Partial<ConstructorParameters<typeof SyncController>[0]> = {}) => new SyncController({ db, folder: folderFactory, ...o });
const seed = (db: Db) => db.exec("INSERT INTO collection (card_id, qty) VALUES ('c1', 3)");

describe('what sync offers', () => {
  it('starts disconnected, and says what this build can do', async () => {
    const db = openDb(':memory:');
    expect(await make(db).status()).toMatchObject({ available: true, folderSupported: true, googleSupported: false, provider: null, account: null, lastAt: null, error: null, running: false, needsSignIn: false });
    expect(await make(db, { folder: undefined, auth: fakeAuth().auth }).status()).toMatchObject({ folderSupported: false, googleSupported: true });
    expect(await make(db, { auth: fakeAuth({ available: false }).auth }).status()).toMatchObject({ googleSupported: false });
  });

  it('is not offered at all where there is nothing it could do (no folder, no Google sign-in)', async () => {
    const db = openDb(':memory:');
    expect((await make(db, { folder: undefined }).status()).available).toBe(false);
    expect((await make(db, { folder: undefined, auth: fakeAuth({ available: false }).auth }).status()).available).toBe(false);
    expect((await make(db, { folder: undefined, auth: fakeAuth().auth }).status()).available).toBe(true);
  });
});

describe('connecting a folder', () => {
  it('syncs once to prove it works, and remembers the folder', async () => {
    const db = openDb(':memory:'); seed(db);
    const dir = tmpDir();
    const status = await make(db).connectFolder(`  ${dir}  `);
    expect(status).toMatchObject({ provider: 'folder', folderPath: dir, error: null, lastPushed: true });
    expect(status.lastAt).toMatch(/^\d{4}-/);
    await expect(new FolderStore(dir).read()).resolves.not.toBeNull();
  });

  it('refuses a folder that does not exist, an empty one, and a build with no folder support, changing nothing', async () => {
    const db = openDb(':memory:');
    await expect(make(db).connectFolder(join(tmpDir(), 'nope'))).rejects.toThrow(/doesn't exist/);
    await expect(make(db).connectFolder('   ')).rejects.toThrow(/Choose a folder/);
    await expect(make(db, { folder: undefined }).connectFolder('/x')).rejects.toThrow(/desktop app/);
    expect(await make(db).status()).toMatchObject({ provider: null, folderPath: null });
  });

  it('does not stay connected if the first sync fails, and says why', async () => {
    const db = openDb(':memory:'), dir = tmpDir();
    writeFileSync(join(dir, SYNC_FILE_NAME), '{"somebody":"elses file"}');
    await expect(make(db).connectFolder(dir)).rejects.toThrow(/isn't a Brewhall sync file/);
    expect(await make(db).status()).toMatchObject({ provider: null, folderPath: null });
  });

  it('a second device joining the same folder gets the first one\'s data', async () => {
    const a = openDb(':memory:'), b = openDb(':memory:'), dir = tmpDir();
    seed(a);
    await make(a).connectFolder(dir);
    const status = await make(b).connectFolder(dir);
    expect(status.lastPulled).toBeGreaterThan(0);
    expect((b.prepare('SELECT qty FROM collection').get() as { qty: number }).qty).toBe(3);
  });
});

describe('connecting Google', () => {
  it('signs in, syncs once through Drive, and shows the account', async () => {
    const db = openDb(':memory:'); seed(db);
    const { auth, calls } = fakeAuth();
    const status = await make(db, { auth, fetchImpl: fakeDriveFetch() }).connectGoogle();
    expect(calls).toEqual(['signIn']);
    expect(status).toMatchObject({ provider: 'google', account: 'person@example.com', needsSignIn: false, error: null, lastPushed: true });
  });

  it('says so when Google sign-in is not set up, or the person closes the sign-in, and connects nothing', async () => {
    const db = openDb(':memory:');
    await expect(make(db).connectGoogle()).rejects.toThrow(/not set up in this build/);
    await expect(make(db, { auth: fakeAuth({ available: false }).auth }).connectGoogle()).rejects.toThrow(/not set up in this build/);
    await expect(make(db, { auth: fakeAuth({ signInFails: true }).auth }).connectGoogle()).rejects.toThrow(/sign-in was closed/);
    expect((await make(db).status()).provider).toBeNull();
  });

  it('signs out again and connects nothing if the first sync through Drive fails', async () => {
    const db = openDb(':memory:');
    const { auth, calls, signedIn } = fakeAuth();
    await expect(make(db, { auth, fetchImpl: fakeDriveFetch({ fail: () => new Response('', { status: 500 }) }) }).connectGoogle()).rejects.toThrow(/HTTP 500/);
    expect(calls).toEqual(['signIn', 'signOut']);
    expect(signedIn()).toBeNull();
    expect((await make(db).status()).provider).toBeNull();
  });

  it('asks the person to sign in again when Google has signed this device out, and recovers when they do', async () => {
    const db = openDb(':memory:'); seed(db);
    let revoked = false;
    const { auth } = fakeAuth();
    const c = make(db, { auth, fetchImpl: fakeDriveFetch({ fail: () => (revoked ? new Response('', { status: 401 }) : null) }) });
    await c.connectGoogle();
    revoked = true;
    const out = await c.syncNow();
    expect(out).toMatchObject({ needsSignIn: true });
    expect(out.error).toMatch(/Sign in again/);
    revoked = false;
    await c.connectGoogle();
    expect(await c.status()).toMatchObject({ needsSignIn: false, error: null });
  });
});

describe('syncing and disconnecting', () => {
  it('records what the last sync did, and reports a failure in words without throwing', async () => {
    const db = openDb(':memory:'); seed(db);
    const dir = tmpDir();
    const c = make(db);
    await c.connectFolder(dir);
    expect(await c.syncNow()).toMatchObject({ error: null, lastPulled: 0, lastPushed: false });
    writeFileSync(join(dir, SYNC_FILE_NAME), 'garbage');
    const bad = await c.syncNow();
    expect(bad.error).toMatch(/isn't readable/);
    expect(bad.lastAt).not.toBeNull(); // the earlier success is still remembered
    expect(bad.provider).toBe('folder'); // and it stays connected, to try again
  });

  it('does nothing when not connected', async () => {
    const db = openDb(':memory:');
    expect(await make(db).syncNow()).toMatchObject({ provider: null, lastAt: null });
  });

  it('shares one sync between callers who ask at the same time', async () => {
    const db = openDb(':memory:'), dir = tmpDir();
    const c = make(db); await c.connectFolder(dir);
    const [a, b] = [c.syncNow(), c.syncNow()];
    expect(a).toBe(b);
    await a;
  });

  it('disconnecting forgets the connection but keeps the data here, and signs out of Google', async () => {
    const db = openDb(':memory:'); seed(db);
    const { auth, calls } = fakeAuth();
    const c = make(db, { auth, fetchImpl: fakeDriveFetch() });
    await c.connectGoogle();
    expect(await c.disconnect()).toMatchObject({ provider: null, account: null, lastAt: null, error: null });
    expect(calls).toEqual(['signIn', 'signOut']);
    expect((db.prepare('SELECT qty FROM collection').get() as { qty: number }).qty).toBe(3);
  });

  it('turns a "someone else is writing" conflict that will not clear into a plain message', async () => {
    const db = openDb(':memory:'), dir = tmpDir();
    const busy: SyncStore & { check(): void } = { check() {}, read: async () => null, write: async () => { throw new SyncConflict('stale'); } };
    const c = new SyncController({ db, folder: () => busy });
    await expect(c.connectFolder(dir)).rejects.toThrow(/Try again in a moment/);
  });
});

describe('syncing in the background', () => {
  const DEBOUNCE = 20_000, EVERY = 600_000;

  it('syncs shortly after a change, once for several changes close together', async () => {
    const db = openDb(':memory:'), dir = tmpDir(), timers = fakeTimers();
    const c = make(db, { schedule: timers.schedule, debounceMs: DEBOUNCE, intervalMs: EVERY });
    await c.connectFolder(dir);
    seed(db);
    c.noteChange(); c.noteChange(); c.noteChange();
    expect(timers.waiting(DEBOUNCE)).toBe(1);
    timers.fire(DEBOUNCE);
    await c.syncNow(); // joins the sync the timer started
    expect((await c.status()).lastPushed).toBe(true);
    expect((await new FolderStore(dir).read())!.text).toContain('"c1"');
    c.stop();
  });

  it('does nothing about changes when it is not connected', async () => {
    const timers = fakeTimers();
    const c = make(openDb(':memory:'), { schedule: timers.schedule });
    c.noteChange(); c.start();
    expect(timers.waiting(DEBOUNCE)).toBe(0);
    expect(timers.waiting(EVERY)).toBe(0);
  });

  it('syncs when the app starts and then every so often, and stops when told', async () => {
    const db = openDb(':memory:'), dir = tmpDir(), timers = fakeTimers();
    const c = make(db, { schedule: timers.schedule, intervalMs: EVERY });
    await c.connectFolder(dir);
    expect(timers.waiting(EVERY)).toBe(1);
    c.stop();
    expect(timers.waiting(EVERY)).toBe(0);
    const restarted = make(db, { schedule: timers.schedule, intervalMs: EVERY });
    restarted.start(); // the app has been restarted: connected already, so it syncs and keeps going
    await restarted.syncNow();
    expect((await restarted.status()).lastAt).not.toBeNull();
    expect(timers.waiting(EVERY)).toBe(1);
    timers.fire(EVERY); // the interval comes round: it syncs again and sets the next one
    await restarted.syncNow();
    await new Promise((r) => setTimeout(r, 0));
    expect(timers.waiting(EVERY)).toBe(1);
    restarted.stop();
    expect(timers.waiting(EVERY)).toBe(0);
  });

  it('syncs again after a sync that ran while something changed', async () => {
    const db = openDb(':memory:'), dir = tmpDir(), timers = fakeTimers();
    const c = make(db, { schedule: timers.schedule, debounceMs: DEBOUNCE, intervalMs: EVERY });
    await c.connectFolder(dir);
    const running = c.syncNow();
    c.noteChange(); // while it runs
    expect(timers.waiting(DEBOUNCE)).toBe(0); // not yet: it waits for the running sync
    await running;
    expect(timers.waiting(DEBOUNCE)).toBe(1); // then a follow-up is queued
    c.stop();
  });
});

describe('the routes', () => {
  const call = (sync?: SyncController) => createRouter({ db: openDb(':memory:'), data: {} as never, semantic: {} as never, sync });
  it('say sync is not available when there is no controller', async () => {
    const r = call();
    expect((await r({ method: 'GET', path: '/api/sync' })).body).toMatchObject({ available: false });
    expect((await r({ method: 'POST', path: '/api/sync/folder', body: { path: '/x' } })).status).toBe(400);
    expect((await r({ method: 'POST', path: '/api/sync/google' })).status).toBe(400);
  });

  it('connect, sync and disconnect, with problems as 400s', async () => {
    const db = openDb(':memory:'), dir = tmpDir(); seed(db);
    const sync = make(db);
    const r = createRouter({ db, data: {} as never, semantic: {} as never, sync });
    expect((await r({ method: 'POST', path: '/api/sync/folder', body: { path: join(dir, 'missing') } })).status).toBe(400);
    expect((await r({ method: 'POST', path: '/api/sync/folder', body: { path: dir } })).body).toMatchObject({ provider: 'folder' });
    expect((await r({ method: 'POST', path: '/api/sync/run' })).body).toMatchObject({ error: null });
    expect((await r({ method: 'GET', path: '/api/sync' })).body).toMatchObject({ provider: 'folder', folderPath: dir });
    expect((await r({ method: 'DELETE', path: '/api/sync' })).body).toMatchObject({ provider: null });
  });

  it('notes a change after something that edits decks, the collection or the wishlist, and not after reading or syncing', async () => {
    const db = openDb(':memory:'), timers = fakeTimers(); seed(db);
    const sync = make(db, { schedule: timers.schedule, intervalMs: 600_000 });
    await sync.connectFolder(tmpDir());
    const r = createRouter({ db, data: {} as never, semantic: {} as never, sync });
    await r({ method: 'GET', path: '/api/collection/summary' });
    await r({ method: 'POST', path: '/api/sync/run' });
    expect(timers.waiting(20_000)).toBe(0);
    await r({ method: 'PUT', path: '/api/wishlist', body: { cardId: 'nope', want: 0 } });
    expect(timers.waiting(20_000)).toBe(1);
    sync.stop();
  });
});
