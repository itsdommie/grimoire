import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeAnthropic } from '../packages/server/src/advisor-fake';
import { expect, test } from './fixtures';

// The advisor inside the app, in a browser: the real router and tools over the on-device database (SQLite WASM), talking to a scripted
// stand-in for Anthropic on this machine. The key is held in memory here (the Android Keystore is exercised on the device).
test.skip(!!process.env.ANDROID_APP, 'built-in server; android-advisor.spec.ts covers the device');

let base = '';
let close = () => {};
const requests: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
test.beforeAll(async () => {
  const fake = fakeAnthropic();
  const server = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) });
      const out = await fake('http://x/v1/messages', { method: 'POST', headers: req.headers as Record<string, string>, body: raw });
      res.writeHead(out.status, { ...cors, 'content-type': 'application/json' }).end(await out.text());
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => { server.close(); };
});
test.afterAll(() => { close(); });

test('asks for a key, then answers from lookups in the on-device database, and a bad key is reported', async ({ page }) => {
  requests.length = 0;
  await page.addInitScript((b) => { try { localStorage.setItem('grimoire.advisorBase', b); } catch { /* ignore */ } }, base);
  await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Advisor' }).click();

  await expect(page.getByText(/sent to Anthropic/)).toBeVisible();
  await page.getByLabel('Anthropic API key').fill('sk-ant-invalid-key-0123456789abcdef');
  await page.getByRole('button', { name: 'Save key' }).click();
  await page.getByLabel('Message the advisor').fill('hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('alert')).toContainText('rejected the API key');
  expect(requests[0]!.headers['anthropic-dangerous-direct-browser-access']).toBe('true'); // what lets a page call the API at all

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Remove key' }).click();
  await page.getByLabel('Anthropic API key').fill('sk-ant-api03-test-key-0123456789abcdef');
  await page.getByRole('button', { name: 'Save key' }).click();
  await page.getByLabel('Message the advisor').fill('cheap artifacts please');
  await page.getByRole('button', { name: 'Send' }).click();
  const answer = page.locator('.chatmsg.assistant').last();
  await expect(answer).toContainText('Sol Ring', { timeout: 60_000 });
  await expect(answer).toContainText('looked at 1 thing');
  await expect(answer.getByRole('list', { name: 'Cards mentioned' }).getByRole('button')).toHaveCount(1); // Mana Crypt was never looked up
  // The tool result the model saw came from the on-device database.
  const toolResult = requests.at(-1)!.body.messages.at(-1).content[0].content as string;
  expect(JSON.parse(toolResult).cards.some((c: { name: string }) => c.name === 'Sol Ring')).toBe(true);
});
