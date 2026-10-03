import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

// Launches the real desktop app. By default the dev build (`electron packages/desktop`); set GRIMOIRE_EXE to
// test a packaged binary (e.g. release/linux-unpacked/grimoire) instead.
const require = createRequire(import.meta.url);
const exe = process.env.GRIMOIRE_EXE;
const fixture = resolve('e2e/fixtures/cards.jsonl');

const launch = (userData: string): Promise<ElectronApplication> =>
  electron.launch({
    executablePath: exe ?? (require('electron') as string),
    args: [...(exe ? [] : ['packages/desktop']), '--no-sandbox'],
    env: { ...process.env, GRIMOIRE_USER_DATA: userData, GRIMOIRE_BULK_FILE: fixture },
  });

test.describe.serial('desktop app', () => {
  const userData = mkdtempSync(join(tmpdir(), 'grimoire-desktop-'));

  test('first run: setup, download, search, protected API', async () => {
    const app = await launch(userData);
    const page = await app.firstWindow();

    await expect(page).toHaveTitle('Grimoire');
    await expect(page.getByText(/needs the card database/)).toBeVisible();
    await page.getByRole('button', { name: 'Download card data' }).click();
    await expect(page.getByPlaceholder(/Search/)).toBeVisible();
    await page.getByPlaceholder(/Search/).fill('sol ring');
    await expect(page.locator('.tile .name')).toHaveText(['Sol Ring']);

    // Build a deck so we can check persistence after a restart.
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('dialog', { name: 'New deck' }).getByLabel('Deck name').fill('Desktop Deck');
    await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Desktop Deck' })).toBeVisible();
    await page.locator('.tile').hover();
    await page.getByRole('button', { name: '+ Deck' }).click();
    await expect(page.locator('.deck .rname', { hasText: 'Sol Ring' })).toBeVisible();

    // The local API refuses requests that lack the per-launch token, and non-loopback Host headers.
    const origin = new URL(page.url()).origin;
    const res = await page.evaluate(async (o) => (await fetch(`${o}/api/decks`)).status, origin);
    expect(res).toBe(401);
    const withToken = await page.evaluate(async (o) => {
      const token = document.querySelector('meta[name="grimoire-token"]')!.getAttribute('content')!;
      return (await fetch(`${o}/api/decks`, { headers: { 'x-grimoire-token': token } })).status;
    }, origin);
    expect(withToken).toBe(200);

    // The app window never navigates away from its own origin.
    await page.evaluate(() => { location.href = 'http://example.invalid/'; });
    await page.waitForTimeout(500);
    expect(new URL(page.url()).origin).toBe(origin);

    await app.close();
  });

  test('second launch: data and decks persisted, no setup screen', async () => {
    const app = await launch(userData);
    const page = await app.firstWindow();
    await expect(page.getByPlaceholder(/Search/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Desktop Deck' })).toBeVisible();
    await expect(page.locator('.deck .rname', { hasText: 'Sol Ring' })).toBeVisible();
    await app.close();
  });

  test('analysis and the simulation worker run under the packaged CSP', async () => {
    const app = await launch(userData);
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (/Content Security Policy|Refused/i.test(m.text())) errors.push(m.text()); });

    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('radio', { name: /Replace current deck/ }).check();
    await page.getByRole('dialog').locator('textarea').fill('Commander\n1 Fixture Commander\n\nDeck\n1 Sol Ring\n38 Forest');
    await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.locator('.deck .rname', { hasText: 'Fixture Commander' })).toBeVisible();

    await page.getByRole('tab', { name: 'Analysis' }).click();
    await expect(page.getByRole('img', { name: /Cards by mana value/ })).toBeVisible();
    await expect(page.locator('.roles')).toContainText('Ramp');

    await page.getByRole('tab', { name: 'Simulate' }).click();
    await page.getByLabel('Games').selectOption('2000');
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect(page.getByRole('heading', { name: 'Opening hands' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('img', { name: /Fixture Commander castable by turn/ })).toBeVisible();
    expect(errors).toEqual([]);
    await app.close();
  });

  test('semantic search runs the real language model from the packaged app', async () => {
    // Reuse a model already on this machine (a dev checkout) to avoid the 34 MB download; CI downloads it.
    const devModel = resolve('data/models/bge-small-en-v1.5');
    if (existsSync(join(devModel, 'model.onnx'))) {
      mkdirSync(join(userData, 'data', 'models'), { recursive: true });
      cpSync(devModel, join(userData, 'data', 'models', 'bge-small-en-v1.5'), { recursive: true });
    }
    const app = await launch(userData);
    const page = await app.firstWindow();
    const footer = page.locator('.datafooter', { hasText: 'Semantic search:' });
    await footer.getByRole('button', { name: 'Set up…' }).click();
    await expect(footer).toContainText(/Ready · 3 cards indexed/, { timeout: 120_000 });

    await page.getByPlaceholder(/Search/).fill('about:"tap for mana, a rock that adds two colorless"');
    await expect(page.locator('.status')).toContainText('best matches first');
    await expect(page.locator('.tile .name').first()).toHaveText('Sol Ring'); // the real model, in the packaged app
    await app.close();
  });

  test('a second instance does not open another window', async () => {
    const first = await launch(userData);
    await first.firstWindow();
    const second = await launch(userData).catch(() => null);
    // The second process exits immediately (single-instance lock); Playwright either fails to attach or sees no window.
    if (second) {
      await expect.poll(() => second.windows().length, { timeout: 3000 }).toBe(0);
      await second.close().catch(() => {});
    }
    expect(first.windows()).toHaveLength(1);
    await first.close();
  });
});
