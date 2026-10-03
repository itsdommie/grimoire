import { expect, test } from '@playwright/test';

// The e2e server swaps the language model for a tiny hashing embedder (GRIMOIRE_FAKE_EMBEDDINGS), so this tests the whole
// flow (setup, indexing, about: queries, filters, removal) without downloading anything.
const search = (page: import('@playwright/test').Page) => page.getByPlaceholder(/Search|Filter/);

const startOff = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  const off = page.locator('.datafooter', { hasText: 'Semantic search:' }).getByRole('button', { name: 'Turn off and delete' });
  if (await off.isVisible().catch(() => false)) await off.click();
};

test('semantic search: not set up, set up, search by meaning, turn off', async ({ page }) => {
  await startOff(page);

  // Not set up: the footer offers it, and about: explains what to do.
  const footer = page.locator('.datafooter', { hasText: 'Semantic search:' });
  await expect(footer.getByRole('button', { name: 'Set up…' })).toBeVisible();
  await footer.getByRole('button', { name: 'What is this?' }).click();
  await expect(footer).toContainText('about 34 MB');
  await search(page).fill('about:"draw a card unless that player pays"');
  await expect(page.locator('.status .error')).toContainText("isn't set up yet");

  // Set up (the fake model needs no download).
  await footer.getByRole('button', { name: 'Set up…' }).click();
  await expect(footer).toContainText(/Ready · [\d,]+ cards indexed/, { timeout: 60_000 });

  // Search by meaning: best matches first, and the example chip appears.
  await search(page).fill('about:"whenever an opponent casts a spell you may draw a card unless that player pays"');
  await expect(page.locator('.status')).toContainText('best matches first');
  await expect(page.locator('.tile .name').first()).toHaveText('Rhystic Study');

  // Ordinary filters still apply and decide what can appear.
  await search(page).fill('about:"opponent casts a spell you may draw a card" t:enchantment c:u');
  await expect(page.locator('.tile').first()).toBeVisible();
  const titles = () => page.locator('.tile').evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
  // Wait for the new results to replace the previous query's tiles.
  await expect.poll(async () => { const t = await titles(); return t.length > 3 && t.every((x) => x.includes('Enchantment')); }).toBe(true);

  // Bad combinations are explained.
  await search(page).fill('-about:"draw"');
  await expect(page.locator('.status .error')).toContainText("can't be negated");
  await search(page).fill('about:"a" about:"b"');
  await expect(page.locator('.status .error')).toContainText('one about');

  // Example chip shows once ready.
  await search(page).fill('');
  await expect(page.getByRole('button', { name: /about:"punish opponents for drawing extra cards"/ })).toBeVisible();

  // Turning it off deletes the index again.
  await footer.getByRole('button', { name: 'Turn off and delete' }).click();
  await expect(footer.getByRole('button', { name: 'Set up…' })).toBeVisible();
});

test('about: works inside the collection view too', async ({ page }) => {
  await startOff(page);
  const footer = page.locator('.datafooter', { hasText: 'Semantic search:' });
  await footer.getByRole('button', { name: 'Set up…' }).click();
  await expect(footer).toContainText(/Ready/, { timeout: 60_000 });

  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Import collection' });
  await dlg.getByLabel('Collection data').fill('Counterspell\nRhystic Study\nSol Ring');
  await dlg.getByRole('radio', { name: 'Replace my collection' }).check();
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();
  await dlg.getByRole('button', { name: 'Done' }).click();

  await search(page).fill('about:"counter target spell"');
  await expect(page.locator('.tile .name').first()).toHaveText('Counterspell');
  await expect(page.locator('.tile')).toHaveCount(3); // only what I own

  // Clean up for other specs.
  await page.getByRole('button', { name: 'Clear' }).click();
  await footer.getByRole('button', { name: 'Turn off and delete' }).click();
});
