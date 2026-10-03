import { execFileSync, spawn } from 'node:child_process';
import { _android as android, expect, test } from '@playwright/test';

// The app is killed while its very first launch is still copying the card database into storage. The next start must come up cleanly:
// the file store only shows a database once its whole import has finished, so a half-copied one is never opened and the copy simply
// runs again. (Reloading the page mid-copy is different: it leaves storage locked until the process restarts, but nothing a person does
// can cause that, so it isn't handled.) Needs a running emulator or phone: set ANDROID_APP.
test.skip(!process.env.ANDROID_APP, 'needs a running Android emulator (set ANDROID_APP)');
const adb = (...args: string[]) => execFileSync('adb', args, { stdio: 'ignore' });
const log = () => execFileSync('adb', ['logcat', '-d'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Start the app fresh and run `interrupt` the moment the first-launch copy begins (it takes well under a second on the emulator). */
async function interruptedFirstLaunch(app: string, interrupt: () => Promise<void> | void) {
  adb('shell', 'pm', 'clear', app);
  adb('logcat', '-c');
  const watcher = spawn('adb', ['logcat']);
  const hit = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the first-launch copy never started')), 60_000);
    watcher.stdout.on('data', (chunk: Buffer) => {
      if (!chunk.toString().includes('copying the card database')) return;
      clearTimeout(timer);
      Promise.resolve(interrupt()).then(resolve, reject);
    });
  });
  adb('shell', 'am', 'start', '-n', `${app}/.MainActivity`);
  await hit;
  watcher.kill();
}

async function expectWorking(app: string) {
  const [device] = await android.devices();
  try {
    const page = await (await device!.webView({ pkg: app })).page();
    await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('.tile').first()).toBeVisible();
    const status = await page.evaluate(async () => (await fetch('/api/data/status')).json()) as { state: string; cardCount: number };
    expect(status).toMatchObject({ state: 'ready' });
    expect(status.cardCount).toBeGreaterThan(30000);
  } finally {
    await device!.close();
  }
}

test('killed during the first launch: starts over cleanly the next time', async () => {
  test.setTimeout(240_000);
  const app = process.env.ANDROID_APP!;
  await interruptedFirstLaunch(app, () => adb('shell', 'am', 'force-stop', app));
  expect(log(), 'the copy finished before the app was killed').not.toContain('card database copied');
  adb('shell', 'am', 'start', '-n', `${app}/.MainActivity`);
  await expectWorking(app);
});
