import { expect, test } from '@playwright/test';

const LIST = `Commander
1 Atraxa, Praetors' Voice

Deck
1 Sol Ring
1 Arcane Signet
1 Cultivate
1 Kodama's Reach
1 Birds of Paradise
1 Rhystic Study
1 Night's Whisper
1 Swords to Plowshares
1 Beast Within
1 Counterspell
1 Wrath of God
1 Eternal Witness
1 Command Tower
1 Hallowed Fountain
1 Watery Grave
1 Breeding Pool
1 Overgrown Tomb
10 Forest
8 Island
6 Plains
6 Swamp`;

test.describe.serial('analysis and simulation', () => {
  test('analysis tab shows curve, findings, colours and roles', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('dialog').locator('textarea').fill(LIST);
    await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.locator('.deck h2')).toBeVisible();

    await page.getByRole('tab', { name: 'Analysis' }).click();
    await expect(page.getByRole('img', { name: /Cards by mana value/ })).toBeVisible();
    await expect(page.locator('.findings')).toContainText('Deck is incomplete');
    await expect(page.locator('.findings')).toContainText(/short on ramp/i); // 4 ramp pieces

    // Table view of the curve.
    const curve = page.locator('.viz', { hasText: 'Cards by mana value' });
    await curve.getByRole('button', { name: 'Table' }).click();
    await expect(curve.locator('.viz-table tbody tr')).toHaveCount(8);
    await curve.getByRole('button', { name: 'Chart' }).click();

    // Hover tooltip on a column.
    await page.getByRole('listitem', { name: /mana value 2/ }).hover();
    await expect(page.getByRole('tooltip')).toContainText('mana value 2');

    // Colour table covers the commander's four colours; status uses icon + text.
    await expect(page.locator('.data-table > tbody > tr:not(.subrow)')).toHaveCount(4);
    await expect(page.locator('.badge-status').first()).toContainText(/OK|Low|High|n\/a/);

    // Role lists name the cards that were counted.
    await page.locator('.roles summary', { hasText: 'Ramp' }).click();
    await expect(page.locator('.roles')).toContainText('Sol Ring');
    await expect(page.locator('.roles')).toContainText('Cultivate');
    await page.getByText('How these numbers are calculated').click();
    await expect(page.locator('.assumptions')).toContainText('not his published table');
  });

  test('simulate tab runs in a worker and shows results', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Simulate' }).click();
    await page.getByLabel('Games').selectOption('2000');
    await page.getByRole('button', { name: 'Run simulation' }).click();

    await expect(page.getByRole('heading', { name: 'Opening hands' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.statline').first()).toContainText('keepable');
    await expect(page.getByRole('img', { name: /Atraxa, Praetors' Voice castable by turn/ })).toBeVisible();

    const mana = page.locator('.viz', { hasText: 'Land drops, mana and colour trouble by turn' });
    await expect(mana.locator('.viz-legend li')).toHaveCount(3); // legend with 2+ series
    await mana.getByRole('button', { name: 'Table' }).click();
    await expect(mana.locator('tbody tr')).toHaveCount(10);

    await expect(page.locator('.data-table tbody tr')).toHaveCount(10);
    await expect(page.getByText('Based on 2,000 games')).toBeVisible();
  });

  test('changing the deck marks simulation results as stale', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Simulate' }).click();
    await page.getByLabel('Games').selectOption('2000');
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('The deck changed since this run')).toHaveCount(0);

    // Remove a card through the Deck tab, return to Simulate.
    await page.getByRole('tab', { name: 'Deck' }).click();
    await page.locator('.deck .row', { hasText: 'Sol Ring' }).hover();
    await page.getByRole('button', { name: 'Remove Sol Ring', exact: true }).click();
    await page.getByRole('tab', { name: 'Simulate' }).click();
    await expect(page.getByText('The deck changed since this run')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Opening hands' })).toBeVisible(); // old results are still shown, but flagged
  });
});
