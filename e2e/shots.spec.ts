import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// A tour of the app for taking pictures: `SHOTS_DIR=/some/folder npx playwright test e2e/shots.spec.ts`. Skipped otherwise. It seeds a believable
// collection and deck through the API (and removes them again), then captures each main view in dark and light, at desktop and phone size.
const DIR = process.env.SHOTS_DIR;
test.skip(!DIR, 'set SHOTS_DIR to take screenshots');
test.setTimeout(900_000);

const COLLECTION = `4 Sol Ring
2 Arcane Signet
3 Command Tower
2 Cultivate
2 Kodama's Reach
2 Swords to Plowshares
2 Counterspell
1 Doubling Season
2 Rhystic Study
1 Cyclonic Rift
2 Smothering Tithe
2 Lightning Greaves
3 Swiftfoot Boots
1 Heroic Intervention
2 Beast Within
2 Farseek
3 Birds of Paradise
4 Llanowar Elves
1 Sylvan Library
1 Atraxa, Praetors' Voice
1 Titania, Protector of Argoth
2 Mana Crypt
1 Black Lotus
3 Lightning Bolt
2 Brainstorm
2 Mystic Remora
1 Craterhoof Behemoth
2 Eternal Witness
2 Rampant Growth
1 Nature's Lore`;
const DECK = `Commander
1 Atraxa, Praetors' Voice
Deck
1 Sol Ring
1 Arcane Signet
1 Command Tower
1 Cultivate
1 Kodama's Reach
1 Swords to Plowshares
1 Doubling Season
1 Rhystic Study
1 Cyclonic Rift
1 Smothering Tithe
1 Lightning Greaves
1 Swiftfoot Boots
1 Heroic Intervention
1 Beast Within
1 Farseek
1 Birds of Paradise
1 Llanowar Elves
1 Sylvan Library
1 Eternal Witness
1 Rampant Growth
1 Nature's Lore
1 Counterspell
12 Forest
10 Plains
8 Island`;

async function shoot(page: Page, name: string, opts: { full?: boolean } = {}) {
  // Let the card pictures arrive (they come from Scryfall), up to a few seconds.
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), undefined, { timeout: 6000 }).catch(() => undefined);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(DIR!, `${name}.png`), fullPage: opts.full ?? false });
}
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name, exact: true }).click();

test('tour', async ({ page, request }) => {
  mkdirSync(DIR!, { recursive: true });
  expect((await request.post('/api/collection/import', { data: { text: COLLECTION, mode: 'replace' } })).ok()).toBe(true);
  const deck = await request.post('/api/decks/import', { data: { text: DECK, name: 'Atraxa Superfriends', format: 'commander' } });
  const deckId = ((await deck.json()) as { deck: { id: number } }).deck.id;
  const cards = (await (await request.get('/api/cards/search?q=!%22doubling%20season%22')).json()) as { cards: Array<{ id: string }> };
  await request.put('/api/wishlist', { data: { cardId: cards.cards[0]!.id, want: 2 } });
  try {
    for (const [size, w, h] of ([['desktop', 1440, 900], ['phone', 390, 844]] as const).filter(([n]) => !process.env.SHOTS_ONLY || process.env.SHOTS_ONLY === n)) {
      for (const scheme of ['dark', 'light'] as const) {
        const p = (n: string) => `${size}-${scheme}-${n}`;
        await page.setViewportSize({ width: w, height: h });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/');
        if (size === 'phone') await page.locator('.mobilebar').getByRole('button', { name: /^Deck/ }).click(); // the deck is its own pane on a phone
        await page.getByLabel('Deck', { exact: true }).selectOption(String(deckId));
        if (size === 'phone') await page.locator('.mobilebar').getByRole('button', { name: /Browse/ }).click();
        await page.getByPlaceholder(/Search/).fill('t:legendary o:draw');
        await page.waitForTimeout(900);
        await shoot(page, p('cards'));
        if (size === 'phone') { await page.locator('.mobilebar').getByRole('button', { name: /^Deck/ }).click(); await shoot(page, p('deck')); await page.getByRole('tab', { name: 'Analysis' }).click(); await shoot(page, p('analysis'), { full: true }); await page.locator('.mobilebar').getByRole('button', { name: /Browse/ }).click(); }
        else { await shoot(page, p('cards-deck-analysis-pre')); await page.getByRole('tab', { name: 'Analysis' }).click(); await shoot(page, p('analysis'));
          if (scheme === 'dark') { // the simulation takes a few seconds to run
            await page.getByRole('tab', { name: 'Simulate' }).click();
            await page.getByRole('button', { name: 'Run simulation' }).click();
            await page.getByRole('button', { name: 'Run again' }).waitFor({ timeout: 90_000 });
            await shoot(page, p('simulate'));
          }
          await page.getByRole('tab', { name: 'Deck' }).click(); }
        await page.getByPlaceholder(/Search/).fill('!"sol ring"');
        await page.getByRole('button', { name: 'Details for Sol Ring' }).first().click();
        await shoot(page, p('detail'));
        await page.keyboard.press('Escape');
        for (const [name, label] of [['collection', 'Collection'], ['sets', 'Sets'], ['wishlist', 'Wishlist'], ['rules', 'Rules'], ['advisor', 'Advisor'], ['play', 'Play']] as const) {
          await tab(page, label);
          await shoot(page, p(name));
        }
        await tab(page, 'Sets');
        await page.getByLabel('Find a set').fill('2xm');
        await page.getByRole('button', { name: /Double Masters \(2XM\)/ }).click();
        await shoot(page, p('setpage'));
        // dialogs, and the first-run screen (the data status is faked as empty, so nothing is downloaded)
        await tab(page, 'Cards');
        if (size === 'phone') await page.locator('.mobilebar').getByRole('button', { name: /^Deck/ }).click();
        await page.getByRole('button', { name: 'New', exact: true }).click();
        await shoot(page, p('dialog-new'));
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Import', exact: true }).first().click();
        await shoot(page, p('dialog-import'));
        await page.keyboard.press('Escape');
        await page.route('**/api/data/status', (route) => route.fulfill({ json: { state: 'empty', cardCount: 0, bulkUpdatedAt: null } }));
        await page.goto('/');
        await shoot(page, p('setup'));
        await page.unroute('**/api/data/status');
      }
    }
  } finally {
    await request.delete(`/api/decks/${deckId}`);
    await request.delete('/api/collection');
    await request.delete('/api/wishlist');
  }
});
