import { expect, test } from '@playwright/test';

// Self-contained (other specs share one database): it makes its own deck and removes it again.
test('cards printed under another name import and search by either name', async ({ page }) => {
  await page.goto('/');

  // Avengers Monitoring Station is Herald's Horn; a deck list written with the Universes Beyond name must not skip it.
  await page.getByRole('button', { name: 'Import' }).click();
  const imp = page.getByRole('dialog', { name: 'Import deck' });
  await imp.locator('textarea').fill('Deck\n1 Avengers Monitoring Station\n1 Sol Ring\n1 Definitely Not A Card');
  await imp.getByPlaceholder('Deck name').fill('Other names');
  await imp.getByRole('button', { name: 'Import', exact: true }).click();
  // Only the genuinely unknown line is reported.
  await expect(imp).toContainText('1 line(s) were not recognised');
  await expect(imp.locator('.issues li')).toHaveText(['Definitely Not A Card']);
  await imp.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.deckhead h2')).toHaveText('Other names');
  await expect(page.locator('.deck .row .rname', { hasText: "Herald's Horn" })).toBeVisible();
  await expect(page.locator('.deck .row .rname', { hasText: 'Sol Ring' })).toBeVisible();

  // Searching by the other name finds the card too.
  await page.getByPlaceholder(/Search/).fill('avengers monitoring station');
  await expect(page.locator('.tile')).toHaveCount(1);
  await expect(page.locator('.tile', { hasText: "Herald's Horn" })).toBeVisible();

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.deckbar select[aria-label="Deck"] option', { hasText: 'Other names' })).toHaveCount(0);
});
