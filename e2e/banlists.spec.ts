import { expect, test } from '@playwright/test';

// The banlists inside the Rules tab, from the real card data: pick a format, see what is banned, narrow to what you own.
test('see what is banned in a format, and switch format', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Rules' }).click();
  await page.getByRole('group', { name: 'Rules or banlists' }).getByRole('button', { name: 'Banlists' }).click();

  const formats = page.getByRole('group', { name: 'Format' });
  await expect(formats.getByRole('button', { name: 'Modern', exact: true })).toBeVisible();
  await formats.getByRole('button', { name: 'Modern', exact: true }).click();
  await expect(page.locator('.statline')).toContainText(/\d+ banned in Modern/);
  await expect(page.getByRole('region', { name: 'Banned' }).locator('.tile', { hasText: 'Oko, Thief of Crowns' })).toHaveCount(1);

  // Vintage restricts rather than bans.
  await formats.getByRole('button', { name: 'Vintage', exact: true }).click();
  await expect(page.locator('.statline')).toContainText(/restricted in Vintage/);
  await expect(page.getByRole('region', { name: 'Restricted' }).locator('.tile', { hasText: 'Black Lotus' })).toHaveCount(1);

  // Card details open from a tile, and "Only ones I own" narrows the list (nothing is owned in this database).
  await formats.getByRole('button', { name: 'Commander', exact: true }).click();
  await page.getByRole('region', { name: 'Banned' }).getByRole('button', { name: 'Details for Hullbreacher' }).click();
  await page.getByRole('dialog', { name: 'Hullbreacher details' }).getByRole('button', { name: 'Close' }).click();
  await page.getByLabel('Only ones I own').check();
  await expect(page.getByText('You own none of the cards banned or restricted in Commander.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Banned' })).toHaveCount(0);
});
