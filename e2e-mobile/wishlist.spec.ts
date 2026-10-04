import { expect, test } from './fixtures';

// The wishlist on the on-device database: want a card from its details, see it listed, take it off.
test('want a card from its details and see it on the wishlist', async ({ page }) => {
  test.setTimeout(180_000);
  if (!process.env.ANDROID_APP) await page.goto('/');
  const search = page.getByPlaceholder(/Search/);
  await expect(search).toBeVisible({ timeout: 90_000 });
  await search.fill('!"sol ring"');
  await page.getByRole('button', { name: 'Details for Sol Ring' }).click({ timeout: 60_000 });
  const dialog = page.getByRole('dialog', { name: 'Sol Ring details' });
  await dialog.getByRole('group', { name: 'Copies wanted' }).getByRole('button', { name: 'Want one more' }).click();
  await expect(dialog.getByRole('group', { name: 'Copies wanted' })).toContainText('1', { timeout: 20_000 }); // (the on-device database is slower on a CI runner)
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Wishlist' }).click();
  const rows = page.getByRole('list', { name: 'Cards to find' });
  await expect(rows.getByRole('button', { name: 'Sol Ring', exact: true })).toBeVisible({ timeout: 20_000 });
  // The Price watch panel above the list fills in once its answer arrives: let the page settle before aiming at a button below it.
  await expect(page.locator('.pricewatch summary')).not.toContainText('checking…', { timeout: 20_000 });
  await rows.getByRole('button', { name: 'Want one fewer Sol Ring' }).click();
  await expect(page.getByText('Your wishlist is empty.')).toBeVisible({ timeout: 20_000 });
});
