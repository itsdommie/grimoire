import { expect, test } from './fixtures';
import { api } from './updateHelpers';

// Search by meaning on a real device with the REAL downloads: the language model from Hugging Face (straight from the WebView) and the
// ready-made index from GitHub (through the native downloader). Needs network, an emulator or phone running a debug build, and REAL_GITHUB=1:
//   REAL_GITHUB=1 ANDROID_APP=io.github.itsdommie.grimoire npx playwright test -c playwright.mobile.config.ts --project=phone android-semantic
test.skip(!process.env.ANDROID_APP || !process.env.REAL_GITHUB, 'needs a device and REAL_GITHUB=1');

const QUERY = 'about:"counter target spell unless its controller pays" -t:land';
const search = (page: import('@playwright/test').Page) => api<{ total: number; cards: Array<{ name: string }> }>(page, '/api/cards/search?q=' + encodeURIComponent(QUERY));

test('sets up search by meaning from the real sources, finds cards by what they do, and keeps working after a restart', async ({ page }) => {
  test.setTimeout(900_000);
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  const footer = page.locator('.datafooter', { hasText: 'Semantic search' });
  await expect(footer).toContainText('Set up');

  const t0 = Date.now();
  await footer.getByRole('button', { name: 'Set up…' }).click();
  let last = '';
  await expect.poll(async () => { const t = (await footer.textContent()) ?? ''; if (t !== last && /\d/.test(t)) { last = t; console.log(`+${Math.round((Date.now() - t0) / 1000)}s`, t.slice(0, 120)); } return t; }, { timeout: 800_000, intervals: [3000] }).toMatch(/Ready|went wrong|Couldn't|Try again/);
  console.log('setup took', Math.round((Date.now() - t0) / 1000), 's:', await footer.textContent());
  await expect(footer).toContainText('Ready');

  const t1 = Date.now();
  const first = await search(page);
  console.log('first search (loads the model):', Date.now() - t1, 'ms ->', first.cards.slice(0, 6).map((c) => c.name).join(', '));
  expect(first.cards.slice(0, 12).some((c) => ['Force Spike', 'Complicate', 'Lofty Denial', 'Convolute', 'Override', 'Rethink'].includes(c.name))).toBe(true);
  const t2 = Date.now();
  await search(page);
  console.log('next search:', Date.now() - t2, 'ms');

  // A restart (the page reloads; the model and index are kept)
  await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.datafooter', { hasText: 'Semantic search' })).toContainText('Ready', { timeout: 60_000 });
  const again = await search(page);
  expect(again.cards.slice(0, 12).map((c) => c.name)).toEqual(first.cards.slice(0, 12).map((c) => c.name));
});
