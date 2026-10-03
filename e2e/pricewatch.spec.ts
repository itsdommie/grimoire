import { expect, test } from '@playwright/test';

// Price watch on the real server. Scryfall gives only today's price, so a fresh database has no history: the panel must say so plainly
// rather than show nothing, and must be on both the Collection and Wishlist tabs. (The movers themselves are covered by the unit tests,
// which can set the history; here there is no way to make a price move.)
const view = (page: import('@playwright/test').Page, name: string) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name, exact: true }).click();

test('the collection tab has a price watch that says what it is watching', async ({ page }) => {
  await page.goto('/');
  await view(page, 'Collection');
  const panel = page.locator('.pricewatch');
  await expect(panel).toBeVisible();
  await expect(panel.locator('summary')).toContainText('Price watch');
  await panel.locator('summary').click();
  await expect(panel.getByRole('group', { name: 'Time window' }).getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: '7 days' }).click();
  await expect(panel.locator('summary')).toContainText('in 7 days');
  await expect(panel).toContainText(/Not watching any prices yet|Nothing has moved in this time yet|Fallers|Risers/);
});

test('the wishlist has one too once it has a card', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder(/Search/).fill('!"doubling season"');
  await page.getByRole('button', { name: 'Details for Doubling Season' }).click();
  const dialog = page.getByRole('dialog', { name: 'Doubling Season details' });
  await dialog.getByRole('button', { name: 'Want one more' }).click();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await view(page, 'Wishlist');
  await expect(page.locator('.pricewatch summary')).toContainText('Price watch');
  await page.locator('.pricewatch summary').click();
  await expect(page.locator('.pricewatch')).toContainText(/Watching 1 card since \d{4}-\d\d-\d\d|Cheaper now|Dearer now/);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('Your wishlist is empty.')).toBeVisible();
});

test('risers and fallers are listed with their change, and the value you hold', async ({ page }) => {
  const mover = (id: string, name: string, then: number, now: number, owned: number) => ({
    card: { id, name }, then, now, change: Math.round((now - then) * 100) / 100, pct: Math.round(((now - then) / then) * 1000) / 10, owned, wanted: 0, effectUsd: (now - then) * owned,
  });
  await page.route('**/api/prices*', (route) => route.fulfill({ json: {
    days: 30, since: '2026-01-01', tracked: 3, valueNow: 12.25, valueThen: 8.5,
    up: [mover('a', 'Sol Ring', 2, 3, 4)], down: [mover('b', 'Cultivate', 0.5, 0.25, 1)],
  } }));
  await page.goto('/');
  await view(page, 'Collection');
  const panel = page.locator('.pricewatch');
  await expect(panel.locator('summary')).toContainText('2 cards moved in 30 days');
  await panel.locator('summary').click();
  await expect(panel.locator('.statline')).toContainText('$12.25');
  await expect(panel.locator('.statline')).toContainText('+$3.75');
  const risers = panel.getByRole('list', { name: 'Risers' });
  await expect(risers).toContainText('Sol Ring');
  await expect(risers).toContainText('$2.00 → $3.00');
  await expect(risers).toContainText('+$1.00');
  await expect(risers).toContainText('(+50%)');
  await expect(risers).toContainText('4 owned');
  const fallers = panel.getByRole('list', { name: 'Fallers' });
  await expect(fallers).toContainText('Cultivate');
  await expect(fallers).toContainText('−$0.25');
  await expect(fallers).toContainText('(−50%)');
});
