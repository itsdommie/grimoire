import { execFileSync } from 'node:child_process';
import { expect, test } from './fixtures';

// The advisor on a real device, against the REAL Anthropic API. There is no real key in a test, and none is needed: a made-up key proves
// the whole path (the WebView's call to api.anthropic.com is allowed, carries the header, and Anthropic answers "no") and that the key
// is kept in the Android Keystore across a restart. Needs network, an emulator or phone running a debug build, and REAL_GITHUB=1:
//   REAL_GITHUB=1 ANDROID_APP=io.github.itsdommie.grimoire npx playwright test -c playwright.mobile.config.ts --project=phone android-advisor
test.skip(!process.env.ANDROID_APP || !process.env.REAL_GITHUB, 'needs a device and REAL_GITHUB=1');

test('keeps the key in the Keystore across a restart, reaches Anthropic, and removes the key on request', async ({ page }) => {
  test.setTimeout(240_000);
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  const tab = () => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Advisor' });
  await tab().click();
  await expect(page.getByLabel('Anthropic API key')).toBeVisible();

  await page.getByLabel('Anthropic API key').fill('sk-ant-api03-made-up-key-for-a-device-test-0123456789');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByLabel('Message the advisor')).toBeVisible();

  // The key is not in the page's storage: it is in the Keystore-encrypted preferences, which hold ciphertext only.
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('made-up-key');
  // (Android writes preferences a moment after they are set.)
  const readPrefs = () => { try { return execFileSync('adb', ['shell', 'run-as', process.env.ANDROID_APP!, 'cat', 'shared_prefs/grimoire_secrets.xml'], { stdio: 'pipe' }).toString(); } catch { return ''; } };
  await expect.poll(readPrefs, { timeout: 15_000 }).toContain('anthropic-key');
  expect(readPrefs()).not.toContain('made-up-key');

  // A restart: the key is still there.
  await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  await tab().click();
  await expect(page.getByLabel('Message the advisor')).toBeVisible();

  // The real API says no to a made-up key, which shows the request got there.
  await page.getByLabel('Message the advisor').fill('hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('alert')).toContainText('rejected the API key', { timeout: 60_000 });

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.getByLabel('Anthropic API key')).toBeVisible();
  await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  await tab().click();
  await expect(page.getByLabel('Anthropic API key')).toBeVisible(); // gone after a restart too
});
