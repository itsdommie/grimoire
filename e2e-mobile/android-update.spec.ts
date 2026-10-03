import { expect, test } from './fixtures';
import { expectUpdated, makeUserData, publishUpdate } from './updateHelpers';

// A card data update on a real device or emulator, through the real native download: a real update is built from the app's database,
// served from this computer (the emulator reaches it as 10.0.2.2), downloaded by Capacitor's Filesystem plugin (which, unlike a web page,
// is not stopped by GitHub's lack of CORS headers), streamed into storage, applied at the next start, and the user's data survives.
// Run with:  ANDROID_APP=io.github.itsdommie.grimoire npx playwright test -c playwright.mobile.config.ts --project=phone android-update
test.skip(!process.env.ANDROID_APP, 'needs a running Android emulator (set ANDROID_APP)');

test('downloads a card update natively and applies it, keeping decks and collection', async ({ page }) => {
  test.setTimeout(300_000);
  const published = await publishUpdate();
  try {
    const port = new URL(published.base).port;
    await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 }); // let the first launch finish before restarting it
    await page.evaluate(([b]) => { localStorage.setItem('grimoire.dataBase', b!); localStorage.setItem('grimoire.metered', '1'); }, [`http://10.0.2.2:${port}`]);
    await page.goto('/'); // start again so the worker reads the setting
    await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
    const user = await makeUserData(page);

    const footer = page.locator('.datafooter', { hasText: 'cards' });
    await expect(footer).toContainText('Update available', { timeout: 60_000 }); // the weekly look found it, and (metered) waited
    await footer.getByRole('button', { name: 'Download' }).click();
    await expectUpdated(page, user, 180_000);
    expect(published.hits).toEqual(['card-data.json', 'card-data.json', 'card-data.db.gz']); // checked on its own, then again when asked, then the file
  } finally {
    published.close();
  }
});
