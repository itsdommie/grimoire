import { expect, test } from '@playwright/test';

const search = (page: import('@playwright/test').Page) => page.getByPlaceholder(/Search/);

test('card detail shows text, legality, rulings and function tags; tags search', async ({ page }) => {
  await page.goto('/');
  await search(page).fill('!"sol ring"');
  await page.getByRole('button', { name: 'Details for Sol Ring' }).click();

  const dialog = page.getByRole('dialog', { name: 'Sol Ring details' });
  await expect(dialog.getByRole('heading', { name: 'Sol Ring' })).toBeVisible();
  await expect(dialog.locator('.cdtext')).toContainText('Add'); // (the {T} and {C} are symbols, each labelled with its own text)
  await expect(dialog.locator('.cdtext').getByRole('img', { name: '{T}' })).toBeVisible();
  await expect(dialog.locator('.cdtext').getByRole('img', { name: '{C}' })).toHaveCount(2);
  await expect(dialog.getByLabel('Format legality')).toContainText('Commander: Legal');
  await expect(dialog.getByRole('region', { name: 'Rulings' })).toContainText('No rulings for this card.'); // Sol Ring genuinely has none
  await expect(dialog.getByRole('link', { name: 'View on Scryfall' })).toHaveAttribute('href', /scryfall\.com/);

  // Function tags are real community tags; clicking one searches for it.
  const rock = dialog.getByRole('button', { name: 'mana rock', exact: true });
  await expect(rock).toBeVisible();
  await rock.click();
  await expect(dialog).toHaveCount(0);
  await expect(search(page)).toHaveValue('otag:mana-rock');
  await expect(page.locator('.tile', { hasText: 'Sol Ring' })).toBeVisible();
});

test('rulings are listed oldest first with their source', async ({ page }) => {
  await page.goto('/');
  await search(page).fill('!"doubling season"');
  await page.getByRole('button', { name: 'Details for Doubling Season' }).click();
  const rulings = page.getByRole('dialog', { name: 'Doubling Season details' }).getByRole('region', { name: 'Rulings' });
  await expect(rulings).toContainText('(5)');
  await expect(rulings.locator('li')).toHaveCount(5);
  await expect(rulings.locator('li').first()).toContainText(/\d{4}-\d{2}-\d{2} · (Wizards|Scryfall)/);
  const dates = await rulings.locator('li .muted').allTextContents();
  const sorted = [...dates].sort();
  expect(dates).toEqual(sorted);
});

test('double-faced cards can be flipped', async ({ page }) => {
  await page.goto('/');
  await search(page).fill('!"Delver of Secrets // Insectile Aberration"');
  await page.getByRole('button', { name: /Details for Delver of Secrets/ }).click();
  const dialog = page.getByRole('dialog', { name: /Delver of Secrets.* details/ });
  await expect(dialog.getByRole('img', { name: /Delver of Secrets/ })).not.toHaveAttribute('alt', /back face/);
  await dialog.getByRole('button', { name: 'Flip card' }).click();
  await expect(dialog.getByRole('img', { name: /back face/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Show front' }).click();
  await expect(dialog.getByRole('button', { name: 'Flip card' })).toBeVisible();
});

test('owning a card from the detail dialog, Escape closes it', async ({ page }) => {
  await page.goto('/');
  await search(page).fill('!"arcane signet"');
  await page.getByRole('button', { name: 'Details for Arcane Signet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Arcane Signet details' });
  const owned = dialog.getByRole('group', { name: 'Copies owned' });
  await expect(owned).toContainText('0');
  await owned.getByRole('button', { name: 'Own one more' }).click();
  await expect(owned).toContainText('1');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // The badge in the grid reflects it too.
  await expect(page.locator('.tile', { hasText: 'Arcane Signet' }).locator('.badge.own')).toContainText('Own ×1');
  // Clean up so other specs see an empty collection.
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Clear' }).click();
});

test('unknown function tags explain themselves; deck rows open details', async ({ page }) => {
  await page.goto('/');
  await search(page).fill('otag:definitely-not-a-tag');
  await expect(page.locator('.status .error')).toContainText('Unknown function tag');

  await search(page).fill('otag:ramp t:artifact cmc<=1');
  await expect(page.locator('.tile').first()).toBeVisible();

  // From the deck panel (imported deck row) as well.
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByRole('dialog').locator('textarea').fill('Deck\n1 Sol Ring');
  await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('.deck .row .rname', { hasText: 'Sol Ring' }).click();
  await expect(page.getByRole('dialog', { name: 'Sol Ring details' })).toBeVisible();
});
