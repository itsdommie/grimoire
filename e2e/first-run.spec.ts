import { expect, test } from '@playwright/test';

test('first run shows the setup screen, imports the card data, then the app works', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Grimoire' })).toBeVisible();
  await expect(page.getByText(/needs the card database/)).toBeVisible();
  await expect(page.getByPlaceholder(/Search/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Download card data' }).click();

  // Setup disappears once the cards are in; the footer shows the count.
  await expect(page.getByPlaceholder(/Search/)).toBeVisible();
  await expect(page.getByText('3 cards')).toBeVisible();
  await page.getByPlaceholder(/Search/).fill('sol ring');
  await expect(page.locator('.tile .name')).toHaveText(['Sol Ring']);
});
