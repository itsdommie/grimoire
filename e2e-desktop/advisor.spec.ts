import { cpSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

// The advisor's key in the real desktop app: the operating system's keychain protects it (a file of ciphertext in the profile), it
// survives a restart, and it goes away when removed. Where the machine has no keychain (a CI runner), the app must say so and refuse to
// store the key instead. With REAL_GITHUB=1 it also sends a message with a made-up key: the real Anthropic API answers "rejected", which
// proves the packaged app reaches it. Like desktop.spec.ts, GRIMOIRE_EXE tests a packaged binary instead of the dev build.
const require = createRequire(import.meta.url);
function isolated(path: string | undefined): string | undefined {
  if (!path) return path;
  if (relative(process.cwd(), path).startsWith('..')) return path;
  const dest = mkdtempSync(join(tmpdir(), 'grimoire-app-'));
  if (statSync(path).isFile() && /\.AppImage$/i.test(path)) { cpSync(path, join(dest, basename(path))); return join(dest, basename(path)); }
  cpSync(dirname(path), dest, { recursive: true });
  return join(dest, basename(path));
}
const exe = isolated(process.env.GRIMOIRE_EXE);
const fixture = resolve('e2e/fixtures/cards.jsonl');
const launch = (userData: string, extraEnv: Record<string, string> = {}): Promise<ElectronApplication> =>
  electron.launch({
    executablePath: exe ?? (require('electron') as string),
    args: [...(exe ? [] : ['packages/desktop']), '--no-sandbox'],
    env: { ...process.env, GRIMOIRE_USER_DATA: userData, GRIMOIRE_BULK_FILE: fixture, GRIMOIRE_DISABLE_UPDATES: '1', ANTHROPIC_API_KEY: '', ...extraEnv },
  });

const KEY = 'sk-ant-api03-made-up-key-for-a-desktop-test-0123456789';

test('the key is kept by the OS keychain across a restart and removed on request (or refused where there is no keychain)', async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), 'grimoire-advisor-'));
  const keyFile = join(userData, 'advisor-key.bin');

  let app = await launch(userData);
  let page = await app.firstWindow();
  await page.getByRole('button', { name: 'Download card data' }).click();
  await expect(page.getByPlaceholder(/Search/)).toBeVisible();
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Advisor' }).click();

  const field = page.getByLabel('Anthropic API key');
  await expect(field.or(page.getByText(/no keychain/))).toBeVisible();
  if (!(await field.isVisible())) {
    // No keychain here: it says so, points at the environment variable, and nothing is written.
    await expect(page.getByText(/ANTHROPIC_API_KEY/)).toBeVisible();
    expect(existsSync(keyFile)).toBe(false);
    await app.close();
    return;
  }

  await field.fill(KEY);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByLabel('Message the advisor')).toBeVisible();
  expect(existsSync(keyFile)).toBe(true);
  expect(readFileSync(keyFile).toString('latin1')).not.toContain('made-up-key'); // ciphertext, not the key
  await app.close();

  // After a restart the key is still there.
  app = await launch(userData);
  page = await app.firstWindow();
  await expect(page.getByPlaceholder(/Search/)).toBeVisible();
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Advisor' }).click();
  await expect(page.getByLabel('Message the advisor')).toBeVisible();

  if (process.env.REAL_GITHUB) {
    await page.getByLabel('Message the advisor').fill('hello');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('alert')).toContainText('rejected the API key', { timeout: 60_000 });
  }

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.getByLabel('Anthropic API key')).toBeVisible(); // (a new window since the restart: look the field up again)
  expect(existsSync(keyFile)).toBe(false);
  await app.close();
});
