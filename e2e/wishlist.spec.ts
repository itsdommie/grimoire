import { expect, test } from '@playwright/test';

// The wishlist: want a card from its details, see what is left to find and what it would cost, have it tick off as the collection grows,
// and add what a deck is missing. (The e2e database is shared between specs, so this one cleans up after itself.)
const search = (page: import('@playwright/test').Page) => page.getByPlaceholder(/Search/);
const tab = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Wishlist' });

test('want a card, collect it, and take it off', async ({ page }) => {
  await page.goto('/');
  await tab(page).click();
  await expect(page.getByText('Your wishlist is empty.')).toBeVisible();

  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Cards' }).click();
  await search(page).fill('!"doubling season"');
  await page.getByRole('button', { name: 'Details for Doubling Season' }).click();
  const dialog = page.getByRole('dialog', { name: 'Doubling Season details' });
  const want = dialog.getByRole('group', { name: 'Copies wanted' });
  await expect(want).toContainText('0');
  await want.getByRole('button', { name: 'Want one more' }).click();
  await expect(want).toContainText('1');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await tab(page).click();
  const rows = page.getByRole('list', { name: 'Cards to find' });
  await expect(rows.getByRole('button', { name: 'Doubling Season', exact: true })).toBeVisible();
  await expect(page.locator('.collbar')).toContainText('1 card to find');
  await rows.getByRole('button', { name: 'Want one more Doubling Season' }).click();
  await expect(rows.getByRole('group', { name: 'Copies of Doubling Season you want' })).toContainText('2');

  // Owning copies ticks it off: with 2 wanted and 2 owned it moves to "Got them".
  await rows.getByRole('button', { name: 'Doubling Season', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Doubling Season details' });
  await detail.getByRole('button', { name: 'Own one more' }).click();
  await detail.getByRole('button', { name: 'Own one more' }).click();
  await detail.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('list', { name: 'Wishes you have met' }).getByRole('button', { name: 'Doubling Season', exact: true })).toBeVisible();
  await expect(page.locator('.collbar')).toContainText('0 cards to find');

  // Clean up: no longer wanted, and not owned.
  await page.getByRole('list', { name: 'Wishes you have met' }).getByRole('button', { name: 'Doubling Season', exact: true }).click();
  const again = page.getByRole('dialog', { name: 'Doubling Season details' });
  await again.getByRole('button', { name: 'Own one fewer' }).click();
  await again.getByRole('button', { name: 'Own one fewer' }).click();
  await again.getByRole('button', { name: 'Close' }).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('Your wishlist is empty.')).toBeVisible();
});

test('a deck\'s missing cards go on the wishlist', async ({ page }) => {
  await page.goto('/');
  // The deck panel only shows coverage once there is a collection: own a Cultivate, then build a deck that also wants a Mox Emerald (not owned).
  await search(page).fill('!"cultivate"');
  await page.getByRole('button', { name: 'Details for Cultivate' }).click();
  const own = page.getByRole('dialog', { name: 'Cultivate details' });
  await own.getByRole('button', { name: 'Own one more' }).click();
  await own.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('dialog', { name: 'New deck' }).getByLabel('Deck name').fill('Wish deck');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Wish deck' })).toBeVisible();
  await search(page).fill('!"mox emerald"');
  await page.getByRole('button', { name: 'Details for Mox Emerald' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mox Emerald details' });
  await dialog.getByRole('button', { name: '+ Deck' }).click();
  await dialog.getByRole('button', { name: 'Close' }).click();

  const panel = page.getByRole('region', { name: 'Collection coverage' });
  await expect(panel).toBeVisible();
  await panel.getByText('Missing cards').click();
  await panel.getByRole('button', { name: 'Add these to my wishlist' }).click();
  await expect(panel.getByRole('status')).toContainText(/Added \d+ to your wishlist|already/);

  await tab(page).click();
  await expect(page.getByRole('list', { name: 'Cards to find' }).getByRole('button', { name: 'Mox Emerald', exact: true })).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('Your wishlist is empty.')).toBeVisible();

  // Clean up the Cultivate.
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Cards' }).click();
  await search(page).fill('!"cultivate"');
  await page.getByRole('button', { name: 'Details for Cultivate' }).click();
  await page.getByRole('dialog', { name: 'Cultivate details' }).getByRole('button', { name: 'Own one fewer' }).click();
});
