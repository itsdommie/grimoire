import { expect, test } from '@playwright/test';

const search = (page: import('@playwright/test').Page) => page.getByPlaceholder(/Search/);
const issues = (page: import('@playwright/test').Page) => page.getByLabel('Deck issues');

test.describe.serial('deck formats', () => {
  test('a Modern deck: 60-card rules, 4 copies, sideboard, legality filter', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New deck' });
    await dialog.getByLabel('Deck name').fill('E2E Burn');
    await dialog.getByLabel('New deck format').selectOption('modern');
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(page.locator('.deck h2')).toHaveText('E2E Burn');
    await expect(page.getByLabel('Format', { exact: true })).toHaveValue('modern');
    await expect(page.locator('.deck .count')).toHaveText('0/60+');
    await expect(page.getByRole('heading', { name: 'Commander' })).toHaveCount(0); // no command zone
    await expect(page.locator('.deck h3', { hasText: 'Sideboard' })).toContainText('(0/15)');

    // Four Bolts are fine; the fifth breaks the copy limit.
    await search(page).fill('!"lightning bolt"');
    const tile = page.locator('.tile', { hasText: 'Lightning Bolt' });
    await tile.hover();
    await expect(tile.getByRole('button', { name: '★ Cmdr' })).toHaveCount(0); // constructed has a sideboard instead
    for (let i = 0; i < 4; i++) await tile.getByRole('button', { name: '+ Deck' }).click();
    await expect(page.locator('.deck .count')).toHaveText('4/60+');
    await expect(issues(page)).not.toContainText('Too many copies');
    await tile.getByRole('button', { name: '+ Deck' }).click();
    await expect(issues(page)).toContainText('Too many copies: Lightning Bolt ×5');

    // A sideboard copy sits beside the main-deck copies (they don't replace each other) and counts towards the same limit.
    await tile.getByRole('button', { name: '+ Side' }).click();
    await expect(page.locator('.deck h3', { hasText: 'Sideboard' })).toContainText('(1/15)');
    await expect(page.locator('.deck .count')).toHaveText('5/60+'); // the 5 main copies are still there
    await expect(issues(page)).toContainText('Too many copies: Lightning Bolt ×6');
    // Moving a stack is explicit: ↓ sends all main copies to the sideboard and merges them with the one already there.
    await page.locator('.deck .row', { hasText: 'Lightning Bolt' }).first().hover();
    await page.getByRole('button', { name: 'Move Lightning Bolt to sideboard' }).click();
    await expect(page.locator('.deck h3', { hasText: 'Sideboard' })).toContainText('(6/15)');
    await expect(page.locator('.deck .count')).toHaveText('0/60+');

    // "Only cards legal in Modern" hides Sol Ring (not Modern-legal); turning it off shows it, and adding it is flagged.
    await search(page).fill('!"sol ring"');
    await expect(page.locator('.tile')).toHaveCount(0);
    await page.getByLabel('Only cards legal in Modern').uncheck();
    const sol = page.locator('.tile', { hasText: 'Sol Ring' });
    await expect(sol).toBeVisible();
    await sol.hover();
    await sol.getByRole('button', { name: '+ Deck' }).click();
    await expect(issues(page)).toContainText('Not legal in Modern: Sol Ring');
  });

  test('analysis and simulation use 60-card maths; format can be changed', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.deck h2')).toHaveText('E2E Burn');

    await page.getByRole('tab', { name: 'Analysis' }).click();
    await expect(page.locator('.deck')).toContainText('19.59 + 1.9 × average mana value');
    await expect(page.locator('.findings')).toContainText('of 60 cards');
    await page.getByRole('tab', { name: 'Simulate' }).click();
    await expect(page.getByLabel('On the play')).toBeChecked(); // one-on-one formats default to on the play
    await page.getByLabel('Games').selectOption('2000');
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect(page.getByRole('heading', { name: 'Opening hands' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Commander', exact: true })).toHaveCount(0);

    // Switching to Commander brings back the command zone.
    await page.getByRole('tab', { name: 'Deck' }).click();
    await page.getByLabel('Format', { exact: true }).selectOption('commander');
    await expect(page.locator('.deck h3', { hasText: 'Commander' })).toBeVisible();
    await expect(page.locator('.deck .count')).toContainText('/100');
    await expect(page.locator('.deck h3', { hasText: 'Maybeboard' })).toBeVisible();
  });

  test('importing into a chosen format', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Import' }).click();
    const dlg = page.getByRole('dialog', { name: 'Import deck' });
    await dlg.locator('textarea').fill('Deck\n4 Lightning Bolt\n4 Counterspell\nSideboard\n2 Lightning Bolt');
    await dlg.getByLabel('Format of the imported deck').selectOption('vintage');
    await dlg.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByLabel('Format', { exact: true })).toHaveValue('vintage');
    await expect(issues(page)).toContainText('Too many copies: Lightning Bolt ×6');
    await expect(page.locator('.deck h3', { hasText: 'Sideboard' })).toContainText('(2/15)');
  });
});
