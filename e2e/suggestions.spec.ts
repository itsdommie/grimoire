import { expect, test } from '@playwright/test';

// "Ideas from your collection" in a deck's Analysis tab, on the real card data: a green commander, a small collection, and the cards that
// fit it grouped by role. (Set up through the API for speed; the e2e database is shared, so this cleans up after itself.)
test('suggests owned cards that fit the deck by role, and adds one', async ({ page, request }) => {
  const imported = await request.post('/api/collection/import', { data: { text: '1 Cultivate\n1 Sol Ring\n1 Kodama\'s Reach\n1 Lightning Bolt\n1 Swords to Plowshares', mode: 'merge' } });
  expect(imported.ok()).toBe(true);
  const deck = await request.post('/api/decks/import', { data: { text: 'Commander\n1 Titania, Protector of Argoth\nDeck\n', name: 'Suggest deck', format: 'commander' } });
  expect(deck.ok()).toBe(true);
  const deckId = ((await deck.json()) as { deck: { id: number } }).deck.id;

  try {
    await page.goto('/');
    await page.getByLabel('Deck', { exact: true }).selectOption(String(deckId));
    await expect(page.getByRole('heading', { name: 'Suggest deck' })).toBeVisible();
    await page.getByRole('tab', { name: 'Analysis' }).click();

    const panel = page.getByRole('region', { name: 'Ideas from your collection' });
    await expect(panel).toBeVisible();
    const ramp = panel.locator('details', { hasText: 'Ramp' }).first();
    await expect(ramp).toContainText('Low'); // a deck with no ramp is short, so that role is open and flagged
    await expect(ramp.getByRole('button', { name: 'Cultivate', exact: true })).toBeVisible();
    await expect(ramp.getByRole('button', { name: 'Sol Ring', exact: true })).toBeVisible();
    await expect(ramp.getByRole('button', { name: "Kodama's Reach", exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Lightning Bolt', exact: true })).toHaveCount(0); // red: outside Titania's colours
    await expect(panel.getByRole('button', { name: 'Swords to Plowshares', exact: true })).toHaveCount(0); // white

    // Adding a card puts it in the deck and takes it off the list.
    await ramp.getByRole('button', { name: 'Add Cultivate to the deck' }).click();
    await expect(ramp.getByRole('button', { name: 'Cultivate', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Deck', exact: true }).click();
    await expect(page.locator('.deck .row .rname', { hasText: 'Cultivate' })).toBeVisible();
  } finally {
    const decks = (await (await request.get('/api/decks')).json()) as Array<{ id: number; name: string }>;
    for (const d of decks.filter((x) => x.name === 'Suggest deck')) await request.delete(`/api/decks/${d.id}`);
    await request.delete('/api/collection');
  }
});
