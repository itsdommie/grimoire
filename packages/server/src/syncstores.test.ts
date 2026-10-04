import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, type NodeDb as Db } from './db.js';
import { runSync, SyncConflict, exportItems } from './sync.js';
import { FolderStore, SYNC_FILE_NAME } from './syncFolder.js';
import { DriveStore, SyncAuthError } from './syncDrive.js';
import { tmpDir } from './testutil.js';

describe('a folder as the sync file\'s home', () => {
  it('reads nothing before the first write, then what was written', async () => {
    const dir = tmpDir(), store = new FolderStore(dir);
    expect(await store.read()).toBeNull();
    const v1 = await store.write('{"a":1}', null);
    expect(await store.read()).toEqual({ text: '{"a":1}', version: v1 });
    expect(existsSync(join(dir, SYNC_FILE_NAME))).toBe(true);
  });

  it('refuses to overwrite a file somebody else wrote after it was read', async () => {
    const dir = tmpDir(), a = new FolderStore(dir), b = new FolderStore(dir);
    const v1 = await a.write('one', null);
    await b.write('two', v1); // b got there first
    await expect(a.write('three', v1)).rejects.toThrow(SyncConflict);
    await expect(a.write('four', null)).rejects.toThrow(SyncConflict); // nor "create" over an existing one
    expect(readFileSync(join(dir, SYNC_FILE_NAME), 'utf8')).toBe('two');
  });

  it('leaves no temporary files behind', async () => {
    const dir = tmpDir(), store = new FolderStore(dir);
    let v = await store.write('1', null);
    v = await store.write('2', v);
    await store.write('3', v);
    expect(readdirSync(dir)).toEqual([SYNC_FILE_NAME]);
  });

  it('says what is wrong with a folder that cannot be used', () => {
    expect(() => new FolderStore(join(tmpDir(), 'nope')).check()).toThrow(/doesn't exist/);
    const dir = tmpDir(); writeFileSync(join(dir, 'a-file'), '');
    expect(() => new FolderStore(join(dir, 'a-file')).check()).toThrow(/doesn't exist/); // a file, not a folder
    expect(() => new FolderStore(dir).check()).not.toThrow();
  });
});

/** Just enough of Google Drive's v3 API (app data folder, files.list/get/create/update) to check we speak it correctly. */
function fakeDrive(opts: { validToken?: () => string } = {}) {
  const files: Array<{ id: string; name: string; parents: string[]; content: string; version: number; created: number }> = [];
  const log: string[] = [];
  let clock = 0;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const auth = (init.headers as Record<string, string>).Authorization;
    log.push(`${method} ${url.pathname}${url.search.includes('uploadType') ? '?' + url.searchParams.get('uploadType') : ''}`);
    if (auth !== `Bearer ${opts.validToken ? opts.validToken() : 'tok'}`) return new Response('unauthorized', { status: 401 });
    const json = (o: unknown) => Response.json(o);
    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      expect(url.searchParams.get('spaces')).toBe('appDataFolder');
      expect(url.searchParams.get('q')).toContain("name = 'grimoire-sync.json'");
      const hit = files.filter((f) => f.name === 'grimoire-sync.json').sort((a, b) => a.created - b.created).slice(0, 1);
      return json({ files: hit.map((f) => ({ id: f.id, version: String(f.version) })) });
    }
    const m = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(url.pathname) as RegExpExecArray | null;
    if (method === 'GET' && m && url.searchParams.get('alt') === 'media') return new Response(files.find((f) => f.id === m[1]!)!.content);
    if (method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const boundary = /boundary=(.+)$/.exec((init.headers as Record<string, string>)['Content-Type'] ?? '')![1]!;
      const parts = String(init.body).split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== '--');
      const meta = JSON.parse(parts[0]!.split('\r\n\r\n')[1]!.trim());
      const content = parts[1]!.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
      expect(meta.parents).toEqual(['appDataFolder']);
      const f = { id: `f${files.length + 1}`, name: meta.name as string, parents: meta.parents as string[], content, version: ++clock, created: clock };
      files.push(f);
      return json({ id: f.id, version: String(f.version) });
    }
    if (method === 'PATCH' && m) {
      const f = files.find((x) => x.id === m[1]!)!;
      f.content = String(init.body); f.version = ++clock;
      return json({ version: String(f.version) });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, files, log };
}

describe('Google Drive as the sync file\'s home', () => {
  it('reads nothing before the first write, creates the file in the app data folder, then updates it in place', async () => {
    const d = fakeDrive(), store = new DriveStore(async () => 'tok', d.fetchImpl);
    expect(await store.read()).toBeNull();
    const v1 = await store.write('hello', null);
    expect(d.files).toHaveLength(1);
    expect(d.files[0]!.parents).toEqual(['appDataFolder']);
    expect(await store.read()).toEqual({ text: 'hello', version: v1 });
    const v2 = await store.write('hello again', v1);
    expect(v2).not.toBe(v1);
    expect(d.files).toHaveLength(1); // updated, not duplicated
    expect((await store.read())!.text).toBe('hello again');
  });

  it('keeps JSON containing quotes, newlines and unicode intact through the upload', async () => {
    const d = fakeDrive(), store = new DriveStore(async () => 'tok', d.fetchImpl);
    const text = JSON.stringify({ name: 'Jötun "Grunt"\nsecond line', emoji: '🎴' });
    await store.write(text, null);
    expect((await store.read())!.text).toBe(text);
  });

  it('refuses to overwrite a file another device wrote after it was read', async () => {
    const d = fakeDrive(), a = new DriveStore(async () => 'tok', d.fetchImpl), b = new DriveStore(async () => 'tok', d.fetchImpl);
    const v1 = await a.write('one', null);
    await b.write('two', v1);
    await expect(a.write('three', v1)).rejects.toThrow(SyncConflict);
    await expect(a.write('four', null)).rejects.toThrow(SyncConflict);
    expect((await a.read())!.text).toBe('two');
  });

  it('refreshes an expired token once and carries on', async () => {
    let valid = 'new';
    const d = fakeDrive({ validToken: () => valid });
    const asked: boolean[] = [];
    const store = new DriveStore(async (force) => { asked.push(!!force); return force ? 'new' : 'old'; }, d.fetchImpl);
    expect(await store.read()).toBeNull();
    expect(asked.slice(0, 2)).toEqual([false, true]);
    valid = 'newer';
    await expect(store.read()).rejects.toBeInstanceOf(SyncAuthError); // still refused after refreshing: signed out
  });

  it('turns a missing permission into a request to sign in again, and other failures into plain messages', async () => {
    const f = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    await expect(new DriveStore(async () => 't', f(403, '{"error":{"errors":[{"reason":"insufficientPermissions"}]}}')).read()).rejects.toThrow(/Sign in again and allow it/);
    await expect(new DriveStore(async () => 't', f(403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}')).read()).rejects.toThrow(/too many requests/);
    await expect(new DriveStore(async () => 't', f(500, '')).read()).rejects.toThrow(/HTTP 500/);
  });

  it('uses the older file if two devices created one at the same moment', async () => {
    const d = fakeDrive(), store = new DriveStore(async () => 'tok', d.fetchImpl);
    await store.write('first', null);
    d.files.push({ id: 'dup', name: 'grimoire-sync.json', parents: ['appDataFolder'], content: 'second', version: 9, created: 99 });
    expect((await store.read())!.text).toBe('first');
  });
});

describe('a full sync through each store', () => {
  const state = (db: Db) => exportItems(db).map((i) => `${i.kind}|${i.key}|${i.at}|${JSON.stringify(i.value)}`).sort();
  const seed = (db: Db) => {
    db.exec("INSERT INTO collection (card_id, qty) VALUES ('c1', 2)");
    db.exec("INSERT INTO decks (name, format) VALUES ('Through Drive', 'commander'); INSERT INTO deck_cards (deck_id, card_id, board, qty) VALUES (1, 'c1', 'main', 1)");
  };

  it('works end to end through Google Drive for two devices', async () => {
    const d = fakeDrive(), a = openDb(':memory:'), b = openDb(':memory:');
    const store = () => new DriveStore(async () => 'tok', d.fetchImpl);
    seed(a);
    await runSync(a, store(), 'A');
    await runSync(b, store(), 'B');
    expect(state(b)).toEqual(state(a));
    expect(d.files).toHaveLength(1);
    b.exec("INSERT INTO collection (card_id, qty) VALUES ('c9', 4)");
    await runSync(b, store(), 'B'); await runSync(a, store(), 'A');
    expect(state(a)).toEqual(state(b));
    expect((a.prepare("SELECT qty FROM collection WHERE card_id = 'c9'").get() as { qty: number }).qty).toBe(4);
  });

  it('works end to end through a folder for two devices', async () => {
    const dir = tmpDir(), a = openDb(':memory:'), b = openDb(':memory:');
    seed(a);
    await runSync(a, new FolderStore(dir), 'A');
    await runSync(b, new FolderStore(dir), 'B');
    expect(state(b)).toEqual(state(a));
  });
});
