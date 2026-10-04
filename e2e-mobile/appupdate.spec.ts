import { expect, test } from './fixtures';

// The "a newer Brewhall is out" banner, with a stand-in for the bridge's GitHub check (that check, and the choice of release, are
// unit-tested in packages/mobile/src/appUpdate.test.ts).
test.skip(!!process.env.ANDROID_APP, 'uses a stub for the update check');

test('shows a newer version with its download link, and dismissing hides that version but not the next', async ({ page }) => {
  await page.addInitScript(() => {
    const next = (localStorage.getItem('test.next') ?? '0.2.0');
    window.grimoireNative = { appUpdate: { check: async () => ({ version: next, url: `https://example.test/Brewhall-${next}-android.apk`, page: `https://example.test/android-v${next}` }) } };
  });
  await page.goto('/');
  const banner = page.getByRole('status').filter({ hasText: 'is available' });
  await expect(banner).toContainText('Brewhall 0.2.0', { timeout: 60_000 }); // (a fresh profile copies the card database first)
  await expect(banner.getByRole('link', { name: 'Download' })).toHaveAttribute('href', 'https://example.test/Brewhall-0.2.0-android.apk');
  await expect(banner.getByRole('link', { name: "What's new" })).toHaveAttribute('href', 'https://example.test/android-v0.2.0');

  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('status').filter({ hasText: 'is available' })).toHaveCount(0); // still dismissed after a restart

  await page.evaluate(() => localStorage.setItem('test.next', '0.3.0'));
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Brewhall 0.3.0' })).toBeVisible({ timeout: 60_000 }); // a newer one is not hidden
});

test('is not there when there is nothing newer, or when the check fails', async ({ page }) => {
  await page.addInitScript(() => {
    window.grimoireNative = { appUpdate: { check: async () => { if (localStorage.getItem('test.fail')) throw new Error('offline'); return null; } } };
  });
  await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('status').filter({ hasText: 'is available' })).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('test.fail', '1'));
  await page.reload();
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('status').filter({ hasText: 'is available' })).toHaveCount(0);
});
