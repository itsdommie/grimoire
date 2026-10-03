import { expect, test } from '@playwright/test';

// Self-contained (other specs share one database): it replaces the collection, and clears it again at the end.
test('a collection file that names printings is matched to them, and the card detail records the one you have', async ({ page }) => {
  await page.goto('/');
  const views = page.getByRole('navigation', { name: 'Views' });
  await views.getByRole('button', { name: 'Collection' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Import collection' });
  await dialog.getByLabel('Collection data').fill('Name,Set code,Collector number,Foil,Quantity\nSol Ring,c21,263,normal,2\nCommand Tower,c21,284,normal,1');
  await dialog.getByRole('radio', { name: 'Replace my collection' }).check();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toContainText('Imported 3 cards (2 unique)');
  await expect(dialog).toContainText('3 copies were matched to a specific printing');
  await dialog.getByRole('button', { name: 'Done' }).click();

  // The tile shows the printing you own, by set and number.
  const tile = page.locator('.tile', { hasText: 'Sol Ring' });
  await expect(tile.locator('.printline')).toHaveText('C21 #263');

  // The card detail lists every printing and what you own of each; every copy here already has its printing.
  await tile.getByRole('button', { name: 'Details for Sol Ring' }).click();
  const detail = page.getByRole('dialog', { name: 'Sol Ring details' });
  const printings = detail.getByRole('region', { name: 'Printings' });
  await expect(printings).toContainText('Every copy has its printing recorded');
  await expect(printings.getByRole('group', { name: 'Normal copies of Commander 2021 number 263' })).toContainText('2');

  // Another printing, in foil: a new copy (nothing is left unrecorded to claim), so the total goes to 3.
  await printings.getByLabel('Filter printings').fill('masters');
  await printings.getByRole('button', { name: 'One more foil Commander Masters 410' }).click();
  await expect(detail.getByRole('group', { name: 'Copies owned' })).toContainText('3');
  await expect(printings.getByRole('group', { name: 'Foil copies of Commander Masters number 410' })).toContainText('1');
  await detail.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.collbar')).toContainText('4 cards · 2 unique');
  await expect(page.locator('.tile', { hasText: 'Sol Ring' }).locator('.printline')).toHaveText('CMM #410 · foil'); // the one you added last

  // Taking the card's total down trims the printing records rather than leaving more printings than copies.
  const sol = page.locator('.tile', { hasText: 'Sol Ring' });
  for (const left of ['2', '1']) { await sol.getByRole('button', { name: 'Own one fewer Sol Ring' }).click(); await expect(sol.locator('.stepper')).toContainText(left); }
  await sol.getByRole('button', { name: 'Own one fewer Sol Ring' }).click();
  await expect(page.locator('.tile', { hasText: 'Sol Ring' })).toHaveCount(0);

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('Your collection is empty.')).toBeVisible();
});
