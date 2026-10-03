import { expect, test } from './fixtures';

// Price watch on the on-device database: the app notes prices when it starts, and the Collection tab says what it is watching.
test('the collection tab shows the price watch', async ({ page }) => {
  test.setTimeout(180_000);
  if (!process.env.ANDROID_APP) await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
  const panel = page.locator('.pricewatch');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await panel.locator('summary').click();
  await expect(panel).toContainText(/Not watching any prices yet|Watching \d+ cards? since|Fallers|Risers/);
});
