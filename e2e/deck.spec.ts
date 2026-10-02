import { expect, test } from '@playwright/test';

const search = (page: import('@playwright/test').Page) => page.getByPlaceholder(/Search/);

test.describe.serial('deck builder', () => {
  test('create a deck, set a commander, add cards, see validation', async ({ page }) => {
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'E2E Atraxa' : undefined));
    await page.goto('/');

    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'E2E Atraxa' })).toBeVisible();
    await expect(page.getByText('0/100')).toBeVisible();

    await search(page).fill('!"atraxa, praetors\' voice"');
    const tile = page.locator('.tile', { hasText: "Atraxa, Praetors' Voice" });
    await tile.hover();
    await tile.getByRole('button', { name: /Cmdr/ }).click();
    await expect(page.locator('.deck .list .rname', { hasText: "Atraxa, Praetors' Voice" })).toBeVisible();
    await expect(page.getByText('1/100')).toBeVisible();

    // With a commander, search is narrowed to its colours: a red-only card disappears.
    await search(page).fill('!"lightning bolt"');
    await expect(page.locator('.tile')).toHaveCount(0);
    await page.getByLabel(/Only Commander-legal/).uncheck();
    await expect(page.locator('.tile')).toHaveCount(1);
    await page.locator('.tile').hover();
    await page.getByRole('button', { name: '+ Deck' }).click();
    await expect(page.locator('.issues .error', { hasText: 'colour identity' })).toContainText('Lightning Bolt');

    // Adding twice breaks singleton; removing it clears the errors.
    await page.locator('.tile').hover();
    await page.getByRole('button', { name: '+ Deck' }).click();
    await expect(page.locator('.issues .error', { hasText: 'Singleton' })).toContainText('Lightning Bolt ×2');
    await page.locator('.deck .row', { hasText: 'Lightning Bolt' }).hover();
    await page.getByRole('button', { name: 'Remove Lightning Bolt', exact: true }).click();
    await expect(page.locator('.issues .error')).toHaveCount(0);
  });

  test('deck persists across reloads', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'E2E Atraxa' })).toBeVisible();
    await expect(page.locator('.deck .rname', { hasText: "Atraxa, Praetors' Voice" })).toBeVisible();
  });

  test('import replaces the deck and reports unknown cards', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('radio', { name: /Replace current deck/ }).check();
    await page.getByRole('dialog').locator('textarea').fill("Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring (CMM) 400 *F*\n30 Forest\n1 Definitely Not A Card");
    await page.getByRole('button', { name: 'Import', exact: true }).last().click();
    await expect(page.getByRole('dialog')).toContainText('Definitely Not A Card');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('32/100')).toBeVisible();
    await expect(page.locator('.issues')).toContainText('needs 68 more cards');
    await expect(page.locator('.deck h3', { hasText: 'Land' })).toBeVisible();
  });

  test('download saves a re-importable list', async ({ page }) => {
    await page.goto('/');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    expect(download.suggestedFilename()).toBe('E2E_Atraxa.txt');
    const { readFile } = await import('node:fs/promises');
    expect(await readFile((await download.path())!, 'utf8')).toBe("Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n30 Forest\n1 Sol Ring\n");
  });
});
