import { expect, test } from '@playwright/test';

const CSV = `Name,Set code,Collector number,Foil,Quantity,ManaBox ID
Sol Ring,cmm,400,normal,2,1
Cultivate,c21,1,normal,1,2
"Atraxa, Praetors' Voice",2xm,190,normal,1,3
Swords to Plowshares,sta,5,foil,1,4
Command Tower,cmm,1,normal,1,5
Arcane Signet,cmm,1,normal,1,6
Totally Bogus Card,xxx,1,normal,1,7`;

test.describe.serial('collection', () => {
  test('import, steppers, owned badges and filter', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
    await expect(page.getByText('Your collection is empty.')).toBeVisible();

    await page.getByRole('button', { name: 'Import', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Import collection' });
    await dialog.getByLabel('Collection data').fill(CSV);
    await dialog.getByRole('radio', { name: 'Replace my collection' }).check();
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog).toContainText('Imported 7 cards (6 unique) from a manabox CSV');
    await expect(dialog).toContainText('Totally Bogus Card');
    await dialog.getByRole('button', { name: 'Done' }).click();

    await expect(page.locator('.collbar')).toContainText('7 cards · 6 unique');
    await expect(page.locator('.tile')).toHaveCount(6);

    // Stepper changes the count and the summary.
    const sol = page.locator('.tile', { hasText: 'Sol Ring' });
    await sol.getByRole('button', { name: 'Own one more Sol Ring' }).click();
    await expect(sol.locator('.stepper')).toContainText('3');
    await expect(page.locator('.collbar')).toContainText('8 cards · 6 unique');
    // Reaching zero removes the card from the collection view.
    const cult = page.locator('.tile', { hasText: 'Cultivate' });
    await cult.getByRole('button', { name: 'Own one fewer Cultivate' }).click();
    await expect(page.locator('.tile', { hasText: 'Cultivate' })).toHaveCount(0);
    await expect(page.locator('.collbar')).toContainText('7 cards · 5 unique');
    // Put it back so later steps have it.
    await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Cards' }).click();
    await page.getByPlaceholder(/Search/).fill('!"cultivate"');
    const tile = page.locator('.tile', { hasText: 'Cultivate' });
    await tile.hover();
    await tile.getByRole('button', { name: 'Add Cultivate to collection' }).click();
    await expect(tile.locator('.badge.own')).toContainText('Own ×1');

    // Owned badge and "only cards I own" in the Cards view.
    await page.getByPlaceholder(/Search/).fill('t:artifact name:ring');
    await expect(page.locator('.tile', { hasText: 'Sol Ring' }).locator('.badge.own')).toContainText('Own ×3');
    await page.getByPlaceholder(/Search/).fill('t:artifact cmc<=2');
    const unfiltered = await page.locator('.status').innerText();
    await page.getByLabel('Only cards I own').check();
    await expect(page.locator('.tile')).toHaveCount(2); // Sol Ring, Arcane Signet
    expect(unfiltered).toMatch(/\d+ cards/);
  });

  test('commander ideas start a deck, and the deck shows what is missing', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
    const ideas = page.getByRole('region', { name: 'Commander ideas' });
    await expect(ideas).toContainText("Atraxa, Praetors' Voice");
    await ideas.getByRole('button', { name: 'Start deck' }).first().click();

    // Back in Cards view with the new deck selected.
    await expect(page.locator('.deck h2')).toHaveText("Atraxa, Praetors' Voice");
    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('radio', { name: /Replace current deck/ }).check();
    await page.getByRole('dialog').locator('textarea').fill("Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Cultivate\n1 Rhystic Study\n10 Forest");
    await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();

    const panel = page.getByRole('region', { name: 'Collection coverage' });
    await expect(panel).toContainText('You own 3 of 4');
    await expect(panel).toContainText(/Missing 1 for about \$\d/);
    await panel.getByText('Missing cards').click();
    await expect(panel).toContainText('Rhystic Study');
    // Only the unowned card is flagged; basics never are.
    await expect(page.locator('.deck .row', { hasText: 'Rhystic Study' }).getByLabel('Missing from collection')).toBeVisible();
    await expect(page.locator('.deck .row', { hasText: 'Sol Ring' }).getByLabel('Missing from collection')).toHaveCount(0);
    await expect(page.locator('.deck .row', { hasText: 'Forest' }).getByLabel('Missing from collection')).toHaveCount(0);

    // Owning it clears the report.
    await page.getByPlaceholder(/Search/).fill('!"rhystic study"');
    await expect(page.locator('.tile')).toHaveCount(1); // wait for this search's results to replace the last ones before pointing at a card
    const rs = page.locator('.tile', { hasText: 'Rhystic Study' });
    await rs.hover();
    await rs.getByRole('button', { name: 'Add Rhystic Study to collection' }).click();
    await expect(panel).toContainText('You own every card in this deck.');
  });

  test('skipping copies already in decks counts spares, and a deck can be added to the collection', async ({ page }) => {
    // Other specs share this database and some of their decks hold Command Tower, so everything is relative to what is in decks now.
    await page.goto('/');
    const views = page.getByRole('navigation', { name: 'Views' });
    const found = await (await page.request.get('/api/cards/search?q=' + encodeURIComponent('!"command tower"'))).json() as { cards: Array<{ id: string; inDecks: number }> };
    const base = found.cards[0]!.inDecks;
    // Own 3 more than the other decks hold: after First and Second (2 each) exactly one is left for the deck being built.
    await page.request.put('/api/collection/cards', { data: { cardId: found.cards[0]!.id, qty: base + 3 } });
    await page.reload();
    const owned = base + 3;

    const importDeck = async (name: string) => {
      await page.getByRole('button', { name: 'Import' }).click();
      const imp = page.getByRole('dialog', { name: 'Import deck' });
      await imp.locator('textarea').fill('Deck\n2 Command Tower');
      await imp.getByPlaceholder('Deck name').fill(name);
      await imp.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(imp).toHaveCount(0);
      await expect(page.locator('.deckhead h2')).toHaveText(name);
    };
    await importDeck('First deck'); // 2 of the 3 towers
    await importDeck('Second deck'); // wants 2 more, but only 1 is spare

    // Counting everything you own, the deck is covered; counting only spare copies it isn't.
    const panel = page.getByRole('region', { name: 'Collection coverage' });
    await expect(panel).toContainText('You own every card in this deck.');
    await panel.getByLabel('Skip copies already in my decks').check();
    await expect(panel).toContainText('1 of 2 are free');
    await expect(page.locator('.deck .row', { hasText: 'Command Tower' }).getByLabel('Missing from collection')).toBeVisible();

    // Searching your cards (the option is shared, and already on): one tower is spare for this deck, so it is offered.
    await page.getByPlaceholder(/Search/).fill('!"command tower"');
    await page.getByLabel('Only cards I own').check();
    await expect(page.locator('.tile', { hasText: 'Command Tower' })).toHaveCount(1);
    // A third deck holding 2 more leaves none spare for a fourth: the card drops out of the results.
    await importDeck('Third deck');
    await expect(page.locator('.tile')).toHaveCount(0);
    await page.locator('.status').getByLabel('Skip copies already in my decks').uncheck();
    await expect(page.locator('.tile', { hasText: 'Command Tower' })).toHaveCount(1);
    await expect(page.locator('.tile .badge.own')).toContainText(`Own ×${owned} · ${base + 6} in decks`);
    await page.locator('.status').getByLabel('Skip copies already in my decks').check();
    await page.getByLabel('Only cards I own').uncheck();

    // The same choice drives the commander ideas: Atraxa already leads a deck.
    await views.getByRole('button', { name: 'Collection' }).click();
    const ideas = page.getByRole('region', { name: 'Commander ideas' });
    await expect(ideas.getByLabel('Skip copies already in my decks')).toBeChecked();
    await expect(ideas).toContainText('every copy you own is already in a deck');
    await ideas.getByLabel('Skip copies already in my decks').uncheck();
    await expect(ideas).toContainText("Atraxa, Praetors' Voice");
    await views.getByRole('button', { name: 'Cards' }).click();

    // A separate step adds a deck's cards to the collection (asks first).
    page.once('dialog', (d) => { expect(d.message()).toContain('Add the 2 cards'); void d.accept(); });
    await page.getByRole('button', { name: 'Add to collection' }).click();
    await expect(page.getByRole('button', { name: 'Added 2 cards' })).toBeVisible();
    await page.getByPlaceholder(/Search/).fill('!"command tower"');
    const badge = page.locator('.tile', { hasText: 'Command Tower' }).locator('.badge.own');
    await expect(badge).toContainText(`Own ×${owned + 2} · ${base + 6} in decks`);
    await expect(badge).toHaveAttribute('title', /0 spare/);

    // Tidy up: remove the decks this test made.
    for (const name of ['Third deck', 'Second deck', 'First deck']) {
      await page.locator('.deckbar select[aria-label="Deck"]').selectOption({ label: `${name} (2)` });
      await expect(page.locator('.deckhead h2')).toHaveText(name);
      page.once('dialog', (d) => void d.accept());
      await page.getByRole('button', { name: 'Delete' }).click();
      await expect(page.locator('.deckbar select[aria-label="Deck"] option', { hasText: name })).toHaveCount(0);
    }
  });

  test('clearing the collection leaves decks alone', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText('Your collection is empty.')).toBeVisible();
    await expect(page.locator('.deck h2')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Collection coverage' })).toHaveCount(0);
  });
});
