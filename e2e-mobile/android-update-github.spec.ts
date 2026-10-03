import { expect, test } from './fixtures';
import { api, makeUserData } from './updateHelpers';

// A post-publish smoke check: the app downloads the REAL published card data from GitHub, natively on the device, and applies it.
// Needs network, an emulator or phone with a build older than the published card data, and: REAL_GITHUB=1
//   REAL_GITHUB=1 ANDROID_APP=io.github.itsdommie.grimoire npx playwright test -c playwright.mobile.config.ts --project=phone android-update-github
test.skip(!process.env.ANDROID_APP || !process.env.REAL_GITHUB, 'needs a device and REAL_GITHUB=1');

test('downloads the published card data from GitHub and applies it, keeping decks and collection', async ({ page }) => {
  test.setTimeout(420_000);
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  const before = await api<{ bulkUpdatedAt: string; cardCount: number }>(page, '/api/data/status');
  const user = await makeUserData(page);
  await page.evaluate(() => { localStorage.setItem('grimoire.metered', '1'); });
  await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });

  const footer = page.locator('.datafooter', { hasText: 'cards' });
  await expect(footer).toContainText('Update available', { timeout: 60_000 }); // the weekly look reached GitHub (natively) and found it
  console.log('footer:', await footer.textContent());
  await footer.getByRole('button', { name: 'Download' }).click();
  await expect.poll(async () => (await api<{ bulkUpdatedAt: string }>(page, '/api/data/status').catch(() => ({ bulkUpdatedAt: '' }))).bulkUpdatedAt, { timeout: 300_000, intervals: [2000] }).not.toBe(before.bulkUpdatedAt);
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 60_000 });

  const after = await api<{ bulkUpdatedAt: string; cardCount: number; warning?: string }>(page, '/api/data/status');
  console.log('before', before.bulkUpdatedAt, '-> after', after.bulkUpdatedAt, after.cardCount, 'cards');
  expect(after.warning).toBeUndefined();
  expect(after.cardCount).toBeGreaterThan(30000);
  const deck = await api<{ deck: { name: string }; entries: Array<{ qty: number; card: { owned: number } }> }>(page, `/api/decks/${user.deckId}`);
  expect(deck.deck.name).toBe('Survivor');
  expect(deck.entries).toHaveLength(1);
  expect(deck.entries[0]!.card.owned).toBe(2);
  expect(await api(page, '/api/collection/summary')).toMatchObject({ total: 2 });
});
