import { expect, test } from '@playwright/test';

const play = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Play' }).click();
};
const player = (page: import('@playwright/test').Page, n: number) => page.getByRole('region', { name: new RegExp(`^Player ${n}`) });

test('life totals, undo and the active player', async ({ page }) => {
  await play(page);
  await expect(page.locator('.turninfo')).toContainText("Turn 1 · Player 1's turn");
  await expect(page.getByRole('region', { name: /^Player/ })).toHaveCount(4);
  await expect(player(page, 2).getByRole('status', { name: /has 40 life/ })).toBeVisible();

  await player(page, 2).getByRole('button', { name: 'Player 2 loses 5 life' }).click();
  await player(page, 2).getByRole('button', { name: 'Player 2 loses 1 life' }).click();
  await expect(player(page, 2).getByRole('status', { name: /has 34 life/ })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(player(page, 2).getByRole('status', { name: /has 35 life/ })).toBeVisible();

  await page.getByRole('button', { name: 'Next turn' }).click();
  await expect(page.locator('.turninfo')).toContainText("Player 2's turn");
  await expect(player(page, 2)).toHaveAttribute('aria-current', 'true');
});

test('commander damage lowers life, poison eliminates, turns skip eliminated players', async ({ page }) => {
  await play(page);
  const p3 = player(page, 3);
  await p3.getByText('Commander damage taken').click();
  for (let i = 0; i < 3; i++) await p3.getByRole('button', { name: 'Add 1 commander damage from Player 1 to Player 3' }).click();
  await expect(p3.getByRole('status', { name: /has 37 life/ })).toBeVisible();
  await expect(p3).toContainText('highest 3/21');

  // Ten poison counters eliminate Player 2.
  const p2 = player(page, 2);
  for (let i = 0; i < 10; i++) await p2.getByRole('button', { name: 'Add one poison counter to Player 2' }).click();
  await expect(page.getByRole('region', { name: /^Player 2.*eliminated: poisoned/ })).toBeVisible();

  // Turn order: 1 -> (2 is out) -> 3.
  await page.getByRole('button', { name: 'Next turn' }).click();
  await expect(page.locator('.turninfo')).toContainText("Player 3's turn");
});

test('the last player standing wins, and a new game resets everything', async ({ page }) => {
  await play(page);
  for (const n of [2, 3, 4]) {
    for (let i = 0; i < 8; i++) await player(page, n).getByRole('button', { name: `Player ${n} loses 5 life` }).click();
  }
  await expect(page.locator('.turninfo')).toContainText('Player 1 wins!');
  await expect(page.getByRole('button', { name: 'Next turn' })).toBeDisabled();

  await page.getByRole('button', { name: 'New game…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New game' });
  await dialog.getByLabel('Players').selectOption('2');
  await dialog.getByLabel('Starting life').selectOption('20');
  await dialog.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('region', { name: /^Player/ })).toHaveCount(2);
  await expect(player(page, 1).getByRole('status', { name: /has 20 life/ })).toBeVisible();
  await expect(page.locator('.turninfo')).toContainText("Turn 1 · Player 1's turn");
});

test('names and the game survive a reload; dice give valid results', async ({ page }) => {
  await play(page);
  await page.getByLabel('Name for player 1').fill('Ada');
  await page.getByRole('button', { name: 'Ada gains 5 life' }).click();
  await page.getByRole('button', { name: 'd20' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^d20: (?:[1-9]|1\d|20)$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Coin' }).click();
  await expect(page.locator('.rollresult')).toHaveText(/^Coin: (Heads|Tails)$/);

  await page.reload();
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Play' }).click();
  await expect(page.getByLabel('Name for player 1')).toHaveValue('Ada');
  await expect(page.getByRole('status', { name: 'Ada has 45 life' })).toBeVisible();
});
