import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** On a phone the browse area and the deck are separate panes behind a bar at the bottom; on a wide screen the bar is hidden and these do nothing. */
const pane = async (page: Page, name: 'Browse' | 'Deck') => {
  // Decide from the screen width, not from whether the bar is on screen yet (after a reload it appears a moment later).
  if (await page.evaluate(() => window.innerWidth <= 900)) await page.locator('.mobilebar').getByRole('button', { name: new RegExp(`^${name}`) }).click();
};

// One long flow in one browser context: the database lives in that context's private storage, like the app's own.
test('the full UI works on the on-device database, and keeps its data across a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');

  // Cards search against the bundled card database.
  await page.getByPlaceholder(/Search/).fill('t:artifact cmc<=1 name:ring');
  await expect(page.locator('.tile', { hasText: 'Sol Ring' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.status')).toContainText(/\d+ cards/);

  // A deck with cards found under another name.
  await pane(page, 'Deck');
  await page.getByRole('button', { name: 'Import' }).click();
  const imp = page.getByRole('dialog', { name: 'Import deck' });
  await imp.locator('textarea').fill('Commander\n1 Atraxa, Praetors\' Voice\n\nDeck\n1 Sol Ring\n1 Avengers Monitoring Station\n10 Forest');
  await imp.getByPlaceholder('Deck name').fill('Phone deck');
  await imp.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(imp).toHaveCount(0);
  await expect(page.locator('.deckhead h2')).toHaveText('Phone deck');
  await expect(page.locator('.deck .row .rname', { hasText: "Herald's Horn" })).toBeVisible();

  // Collection import, coverage and the spare-copies option.
  await pane(page, 'Browse');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  const col = page.getByRole('dialog', { name: 'Import collection' });
  await col.getByLabel('Collection data').fill('2 Sol Ring\n1 Atraxa, Praetors\' Voice\n1 Herald\'s Horn');
  await col.getByRole('radio', { name: 'Replace my collection' }).check();
  await col.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(col).toContainText('Imported 4 cards');
  await col.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.collbar')).toContainText('4 cards');
  await expect(page.getByRole('region', { name: 'Commander ideas' })).toContainText("Atraxa, Praetors' Voice");
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Cards' }).click();
  await pane(page, 'Deck');
  await expect(page.getByRole('region', { name: 'Collection coverage' })).toContainText('You own');
  await pane(page, 'Browse');

  // Rules, and a card's detail dialog (rulings and tags come from the same database).
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Rules' }).click();
  await expect(page.getByText(/Comprehensive Rules|Game Concepts/).first()).toBeVisible();
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Cards' }).click();

  // The data is in on-device storage: a reload keeps the deck and the collection.
  await page.reload();
  await pane(page, 'Deck');
  await expect(page.locator('.deckhead h2')).toHaveText('Phone deck', { timeout: 60_000 });
  await expect(page.locator('.deck .row .rname', { hasText: "Herald's Horn" })).toBeVisible();
  await pane(page, 'Browse');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
  await expect(page.locator('.collbar')).toContainText('4 cards');

  expect(errors).toEqual([]);
});
