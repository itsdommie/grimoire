import { execFileSync } from 'node:child_process';
import { expect, test } from './fixtures';

// The real hardware Back key on an emulator or phone (adb sends it): it closes what is open, walks up the screens, and only leaves the app
// when there is nothing left to close. Run with:  ANDROID_APP=io.github.itsdommie.grimoire npx playwright test -c playwright.mobile.config.ts --project=phone android-back
test.skip(!process.env.ANDROID_APP, 'needs a running Android emulator (set ANDROID_APP)');

const adb = (...args: string[]) => execFileSync('adb', args, { encoding: 'utf8' });
const pressBack = () => adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
const inForeground = () => adb('shell', 'dumpsys', 'activity', 'activities').split('\n').some((l) => /(mResumedActivity|topResumedActivity)/.test(l) && l.includes(process.env.ANDROID_APP!));

test('the Back key closes a card, goes back to Cards, and only then leaves the app', async ({ page }) => {
  test.setTimeout(180_000);
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  // The search box does not take the keyboard at start.
  expect(await page.evaluate(() => document.activeElement?.getAttribute('placeholder') ?? '')).not.toMatch(/Search/);

  await page.locator('.tile').first().getByRole('button', { name: /^Details for/ }).click();
  const detail = page.getByRole('dialog', { name: /details$/ });
  await expect(detail).toBeVisible();
  pressBack();
  await expect(detail).toHaveCount(0);
  expect(inForeground()).toBe(true);

  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
  pressBack();
  await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-current', 'page');
  expect(inForeground()).toBe(true);

  pressBack(); // nothing left to close: the app leaves, to the home screen
  await expect.poll(inForeground, { timeout: 15_000 }).toBe(false);
});
