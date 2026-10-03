import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { expectUpdated, makeUserData, publishUpdate } from './updateHelpers';

// Card data updates, end to end in a browser: a real update is built from the app's own database (Sol Ring renamed, a version far in
// the future), served from a local server, downloaded by the app, applied at the next start, and the user's deck and collection survive.
// (The same flow with the real native download is in android-update.spec.ts.)
test.skip(!!process.env.ANDROID_APP, 'built-in server; android-update.spec.ts covers the device');

let published: Awaited<ReturnType<typeof publishUpdate>>;
test.beforeAll(async ({}, testInfo) => {
  test.setTimeout(240_000);
  test.skip(testInfo.project.name !== 'wide', 'one browser size is enough');
  published = await publishUpdate();
});
test.afterAll(() => { published?.close(); });

async function openApp(page: Page, metered: boolean) {
  await page.addInitScript(([b, m]) => { try { localStorage.setItem('grimoire.dataBase', b!); localStorage.setItem('grimoire.metered', m!); } catch { /* ignore */ } }, [published.base, metered ? '1' : '0']);
  await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
}

test('the weekly check downloads a newer card update and applies it at the next start, keeping decks and collection', async ({ page }) => {
  test.setTimeout(240_000);
  published.hits.length = 0;
  await openApp(page, false);
  const user = await makeUserData(page);
  // Nothing was asked of the server yet: the app's own look comes a few seconds after it starts, and downloads on its own off mobile data.
  await expectUpdated(page, user);
  expect(published.hits.filter((h) => h === 'card-data.json')).toHaveLength(1);
  expect(published.hits.filter((h) => h === 'card-data.db.gz')).toHaveLength(1);

  // Asking again finds nothing newer.
  await page.getByRole('button', { name: 'Check for card updates' }).click();
  await expect(page.locator('.datafooter', { hasText: '(up to date)' })).toBeVisible({ timeout: 30_000 });
  expect(published.hits.filter((h) => h === 'card-data.db.gz')).toHaveLength(1);
});

test('on mobile data it only says an update is waiting, and downloads it when asked', async ({ page }) => {
  test.setTimeout(240_000);
  published.hits.length = 0;
  await openApp(page, true);
  const user = await makeUserData(page);
  const footer = page.locator('.datafooter', { hasText: 'cards' });
  await expect(footer).toContainText('Update available', { timeout: 60_000 });
  await expect(footer).toContainText(/\(\d+\.\d MB\)/);
  expect(published.hits).toEqual(['card-data.json']); // the small manifest only: no big download on its own
  await footer.getByRole('button', { name: 'Download' }).click();
  await expectUpdated(page, user);
  expect(published.hits.filter((h) => h === 'card-data.db.gz')).toHaveLength(1);
});
