import { expect, test } from '@playwright/test';

const search = (page: import('@playwright/test').Page) => page.getByPlaceholder(/Search/);

test('first run shows the setup screen, imports the card data, then the app works', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Brewhall' })).toBeVisible();
  await expect(page.getByText(/needs the card database/)).toBeVisible();
  await expect(page.getByPlaceholder(/Search/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Download card data' }).click();

  // Setup disappears once the cards are in; the footer shows the count.
  await expect(page.getByPlaceholder(/Search/)).toBeVisible();
  await expect(page.getByText('3 cards')).toBeVisible();
  await page.getByPlaceholder(/Search/).fill('sol ring');
  await expect(page.locator('.tile .name')).toHaveText(['Sol Ring']);

  // Rulings and function tags came along with the cards.
  await page.getByPlaceholder(/Search/).fill('otag:ramp');
  await expect(page.locator('.tile .name')).toHaveText(['Sol Ring']); // mana-rock is a child of ramp
  await page.locator('.tile').getByRole('button', { name: 'Details for Sol Ring' }).click();
  const detail = page.getByRole('dialog', { name: 'Sol Ring details' });
  await expect(detail).toContainText('Fixture ruling: Sol Ring taps for two colourless mana.');
  await expect(detail).toContainText('No price'); // the fixture card has no featured price
  await page.keyboard.press('Escape');

  // Opt in to cheapest-printing prices: the cheapest real paper printing (0.90, not the digital 0.05) is used.
  const prices = page.locator('.datafooter', { hasText: 'Prices:' });
  await expect(prices).toContainText('featured printing (rough)');
  await prices.getByRole('button', { name: 'What is this?' }).click();
  await expect(prices).toContainText('about 79 MB');
  await prices.getByRole('button', { name: 'Use cheapest-printing prices' }).click();
  await expect(prices.getByRole('button', { name: 'Update prices' })).toBeVisible({ timeout: 20_000 }); // only shown once the import has finished
  await expect(prices).toContainText('cheapest printing');
  await page.locator('.tile').getByRole('button', { name: 'Details for Sol Ring' }).click();
  await expect(page.getByRole('dialog', { name: 'Sol Ring details' })).toContainText('From $0.90 (cheapest printing, C21)');
  await page.keyboard.press('Escape');
  await search(page).fill('usd<1');
  await expect(page.locator('.tile .name')).toHaveText(['Sol Ring']);

  // And back off again.
  await prices.getByRole('button', { name: 'Turn off' }).click();
  await expect(prices).toContainText('featured printing (rough)');
  await search(page).fill('usd<1');
  await expect(page.locator('.tile')).toHaveCount(0);
});
