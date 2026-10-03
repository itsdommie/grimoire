import { expect, test } from './fixtures';

// Browsing by set inside the app (SQLite WASM in a browser, or the real WebView with ANDROID_APP): the list loads, a set opens, a copy can
// be recorded as that printing and taken off again, and the progress follows.
test('browse sets, open one, record a copy as that printing and take it off again', async ({ page }) => {
  test.setTimeout(180_000);
  if (!process.env.ANDROID_APP) await page.goto('/'); // (on a device the fixture has already started the app: reloading it mid-setup would interrupt that)
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  const t0 = Date.now();
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Sets' }).click();
  await expect(page.locator('.setlist li').first()).toBeVisible({ timeout: 60_000 });
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/sets-list.png` });
  console.log('set list ready in', Date.now() - t0, 'ms,', await page.locator('.setlist li').count(), 'sets');

  await page.getByLabel('Find a set').fill('limited edition alpha');
  await expect(page.locator('.setlist li')).toHaveCount(1);
  const t1 = Date.now();
  await page.getByRole('button', { name: /Limited Edition Alpha \(LEA\)/ }).click();
  await expect(page.getByRole('heading', { name: /Limited Edition Alpha/ })).toBeVisible();
  console.log('set page ready in', Date.now() - t1, 'ms');
  const progress = async () => Number(/^\s*([\d,]+)\s+of/.exec(await page.locator('.setprogress').innerText())![1]!.replace(/,/g, ''));
  const before = await progress();
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/sets-page.png` });

  const tile = page.locator('.settile').first();
  const name = (await tile.locator('.name').innerText()).trim();
  await expect(tile).toHaveClass(/missing/);
  await tile.getByRole('button', { name: new RegExp(`One more ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click();
  await expect(tile).toHaveClass(/have/);
  await expect.poll(progress).toBe(before + 1);
  await tile.getByRole('button', { name: /One fewer/ }).click();
  await expect(tile).toHaveClass(/missing/);
  await expect.poll(progress).toBe(before);

  await page.getByRole('button', { name: '← All sets' }).click();
  await expect(page.getByLabel('Find a set')).toBeVisible();
});
