import { expect, test } from './fixtures';

// Sync is not on the phone yet (it needs Google sign-in there): the app must say so honestly by offering nothing, rather than a setup that
// cannot work, and everything else must be unaffected by the schema that sync needed.
test('the phone does not offer sync yet, and its data model is the new one', async ({ page }) => {
  test.setTimeout(180_000);
  if (!process.env.ANDROID_APP) await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  const out = await page.evaluate(async () => {
    const status = await (await fetch('/api/sync')).json();
    await fetch('/api/decks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Phone deck', format: 'commander' }) });
    return { status, decks: await (await fetch('/api/decks')).json() };
  });
  expect(out.status).toMatchObject({ available: false, provider: null });
  await expect(page.locator('.syncfooter')).toHaveCount(0);
  expect(out.decks).toHaveLength(1);
});
