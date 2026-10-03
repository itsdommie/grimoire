import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** The card data a test publishes: the app's own database with Sol Ring renamed and a version far in the future. */
export const UPDATE_VERSION = '2099-01-01T00:00:00.000+00:00';

/** Build that update with the real packaging code (what CI runs) and serve it from this machine, with the headers a browser needs. */
export async function publishUpdate(host = '127.0.0.1'): Promise<{ base: string; hits: string[]; close(): void }> {
  const work = mkdtempSync(join(tmpdir(), 'grimoire-update-'));
  mkdirSync(join(work, 'data'));
  copyFileSync(resolve('packages/mobile/dist/grimoire.db'), join(work, 'data', 'grimoire.db'));
  const db = new DatabaseSync(join(work, 'data', 'grimoire.db'));
  db.exec("UPDATE cards SET name = 'Sol Ring (Updated)' WHERE name = 'Sol Ring'");
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('bulk_updated_at', ?)").run(UPDATE_VERSION);
  db.close();
  const outDir = join(work, 'published');
  execFileSync(resolve('node_modules/.bin/tsx'), ['packages/server/src/cli.ts', 'carddata', '--export', outDir], { env: { ...process.env, GRIMOIRE_DATA_DIR: join(work, 'data') }, stdio: 'pipe' });

  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const name = (req.url ?? '').split('?')[0]!.replace(/^\//, '');
    hits.push(name);
    if (name !== 'card-data.json' && name !== 'card-data.db.gz') { res.writeHead(404).end(); return; }
    const file = join(outDir, name);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(file).size, 'access-control-allow-origin': '*' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, host, r));
  return { base: `http://${host}:${(server.address() as AddressInfo).port}`, hits, close: () => { server.close(); } };
}

/** Call the app's API from inside the page (the bridge answers it from the on-device database). */
export const api = <T>(page: Page, path: string, init?: { method: string; body: unknown }) =>
  page.evaluate(async ([p, i]) => (await fetch(p as string, i ? { method: (i as { method: string }).method, body: JSON.stringify((i as { body: unknown }).body) } : undefined)).json(), [path, init] as const) as Promise<T>;

/** The things that belong to the person, not the card data: a collection and a deck. */
export async function makeUserData(page: Page) {
  const card = await api<{ id: string }>(page, '/api/cards/by-name/Sol%20Ring');
  await api(page, '/api/collection/cards', { method: 'PUT', body: { cardId: card.id, qty: 2 } });
  const deck = await api<{ id: number }>(page, '/api/decks', { method: 'POST', body: { name: 'Survivor' } });
  await api(page, `/api/decks/${deck.id}/cards`, { method: 'PUT', body: { cardId: card.id, board: 'main', qty: 1 } });
  return { cardId: card.id, deckId: deck.id };
}

/** The page reloads itself, applies the update behind a splash message, and comes back with the new card data and the same user data. */
export async function expectUpdated(page: Page, user: { cardId: string; deckId: number }, timeout = 180_000) {
  // (the page reloads itself part-way through, and a poll that lands on the reload is just "not yet")
  try {
    await expect.poll(async () => {
      try { return await page.evaluate(async () => { try { return (await (await fetch('/api/cards/search?q=' + encodeURIComponent('name:"Sol Ring (Updated)"'))).json()).total; } catch { return -1; } }); } catch { return -1; }
    }, { timeout, intervals: [1000] }).toBe(1);
  } catch (err) {
    // Say what the app thought was going on, so a slow runner and a real failure can be told apart.
    const status = await page.evaluate(async () => { try { return JSON.stringify(await (await fetch('/api/data/status')).json()); } catch (e) { return `status unavailable: ${String(e)}`; } }).catch(() => 'page unavailable');
    throw new Error(`the card update was not applied in time. The app's status: ${status}\n${String(err)}`);
  }
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 60_000 });
  expect((await api<{ total: number }>(page, '/api/cards/search?q=' + encodeURIComponent('!"Sol Ring"'))).total).toBe(0); // the old name is gone: the card pool really was replaced
  const deck = await api<{ deck: { name: string }; entries: Array<{ card: { name: string; owned: number }; qty: number }> }>(page, `/api/decks/${user.deckId}`);
  expect(deck.deck.name).toBe('Survivor');
  expect(deck.entries.map((e) => `${e.qty} ${e.card.name} (own ${e.card.owned})`)).toEqual(['1 Sol Ring (Updated) (own 2)']);
  expect(await api(page, '/api/collection/summary')).toMatchObject({ total: 2, unique: 1 });
  const status = await api<{ bulkUpdatedAt: string; warning?: string }>(page, '/api/data/status');
  expect(status.bulkUpdatedAt).toBe(UPDATE_VERSION);
  expect(status.warning).toBeUndefined();
}
