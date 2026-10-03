import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from './fixtures';
import { api } from './updateHelpers';

// Search by meaning on the phone, end to end in a browser, with the REAL language model and a REAL ready-made index (exported from the
// developer's own database, whose card text the app's database was copied from). The "release" is a local server. It needs the model
// the desktop app downloaded (data/models) and a built index in data/grimoire.db, so it skips itself where those aren't there.
// (The same flow against the real Hugging Face and GitHub is run on a device by hand.)
const MODEL_DIR = resolve('data/models/bge-small-en-v1.5');
test.skip(!!process.env.ANDROID_APP, 'built-in server; the device is exercised by hand');
test.skip(!existsSync(join(MODEL_DIR, 'model.onnx')) || !existsSync(resolve('data/grimoire.db')), 'needs the desktop model and index');

let base = '';
let hits: string[] = [];
let close = () => {};
test.beforeAll(async ({}, testInfo) => {
  test.setTimeout(300_000);
  test.skip(testInfo.project.name !== 'wide', 'one browser size is enough');
  const out = mkdtempSync(join(tmpdir(), 'grimoire-semantic-'));
  execFileSync(resolve('node_modules/.bin/tsx'), ['packages/server/src/cli.ts', 'semantic', '--export', out], { stdio: 'pipe', timeout: 240_000 });
  const files: Record<string, string> = {
    '/prebuilt/semantic-index.json': join(out, 'semantic-index.json'),
    [`/prebuilt/${(JSON.parse(readFileSync(join(out, 'semantic-index.json'), 'utf8')) as { file: string }).file}`]: '',
    '/model/onnx/model_quantized.onnx': join(MODEL_DIR, 'model.onnx'),
    '/model/tokenizer.json': join(MODEL_DIR, 'tokenizer.json'),
  };
  const asset = Object.keys(files).find((k) => files[k] === '')!;
  files[asset] = join(out, asset.split('/').pop()!);
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    hits.push(path);
    const file = files[path];
    if (!file) { res.writeHead(404, { 'access-control-allow-origin': '*' }).end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(file).size, 'access-control-allow-origin': '*' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => { server.close(); };
});
test.afterAll(() => { close(); });

test('turning on search by meaning downloads the model and index, then finds cards by what they do, and survives a restart', async ({ page }) => {
  test.setTimeout(300_000);
  hits = [];
  await page.addInitScript(([s, m]) => { try { localStorage.setItem('grimoire.semanticBase', s!); localStorage.setItem('grimoire.modelBase', m!); } catch { /* ignore */ } }, [`${base}/prebuilt`, `${base}/model`]);
  await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });

  const footer = page.locator('.datafooter', { hasText: 'Semantic search' });
  await expect(footer).toContainText('Set up');
  // Searching by meaning before it is set up says so instead of failing quietly.
  const early = await api<{ error?: string }>(page, '/api/cards/search?q=' + encodeURIComponent('about:"counter target spell unless its controller pays"'));
  expect(JSON.stringify(early)).toMatch(/set up|semantic/i);

  await footer.getByRole('button', { name: 'Set up…' }).click();
  await expect(footer).toContainText('Ready', { timeout: 240_000 });
  await expect(footer).toContainText(/3\d,\d{3} cards indexed/);
  expect(hits.filter((h) => h.endsWith('model_quantized.onnx'))).toHaveLength(1);
  expect(hits.filter((h) => h.endsWith('.bin.gz'))).toHaveLength(1);

  const top = async () => {
    const r = await api<{ cards: Array<{ name: string }> }>(page, '/api/cards/search?q=' + encodeURIComponent('about:"counter target spell unless its controller pays" -t:land'));
    return r.cards.slice(0, 12).map((c) => c.name);
  };
  const names = await top();
  expect(names.some((n) => ['Force Spike', 'Complicate', 'Lofty Denial', 'Convolute', 'Override', 'Rethink'].includes(n)), names.join(', ')).toBe(true);

  // A restart keeps the index and the model: nothing is downloaded again and the search still works.
  const before = hits.length;
  await page.reload();
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.datafooter', { hasText: 'Semantic search' })).toContainText('Ready', { timeout: 30_000 });
  expect(await top()).toEqual(names);
  expect(hits.length).toBe(before);

  await page.locator('.datafooter', { hasText: 'Semantic search' }).getByRole('button', { name: 'Turn off and delete' }).click();
  await expect(page.locator('.datafooter', { hasText: 'Semantic search' })).toContainText('Set up', { timeout: 30_000 });
});
