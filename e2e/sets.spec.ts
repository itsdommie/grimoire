import { expect, test } from '@playwright/test';

// Browsing by set with real printings data (the e2e database is a copy of the developer's): the list, one set's cards with what you own,
// recording a copy as that set's printing, the progress and cost, and jumping to a search of the set.
const tab = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Sets' });
/** Cards are shown 120 at a time, in collector-number order: keep asking for more until the one we want is there. */
async function reveal(page: import('@playwright/test').Page, name: string) {
  const tile = page.locator('.settile', { has: page.getByText(name, { exact: true }) });
  for (let i = 0; i < 10 && (await tile.count()) === 0; i++) {
    const more = page.getByRole('button', { name: /Show more/ });
    await expect(more).toBeVisible();
    await more.click();
    await expect.poll(async () => (await tile.count()) + (await more.count()) > 0).toBe(true);
  }
  await expect(tile).toHaveCount(1);
  return tile;
}
const owned = async (page: import('@playwright/test').Page) => Number(/^\s*([\d,]+)\s+of/.exec(await page.locator('.setprogress').innerText())![1]!.replace(/,/g, ''));

test('browse sets, open one, record a copy as that printing, and search the set', async ({ page }) => {
  await page.goto('/');
  await tab(page).click();
  await page.getByLabel('Find a set').fill('limited edition alpha');
  await expect(page.locator('.setlist li')).toHaveCount(1);
  await page.getByRole('button', { name: /Limited Edition Alpha \(LEA\)/ }).click();

  await expect(page.getByRole('heading', { name: /Limited Edition Alpha/ })).toBeVisible();
  const before = await owned(page);
  const setTotal = Number(/of ([\d,]+) cards/.exec(await page.locator('.setprogress').innerText())![1]!.replace(/,/g, ''));
  const tile = await reveal(page, 'Black Lotus');
  await expect(tile).toHaveClass(/missing/);

  await tile.getByRole('button', { name: /One more Black Lotus/ }).click();
  await expect(tile).toHaveClass(/have/);
  await expect(tile.locator('.badge.own')).toContainText('Own ×');
  await expect.poll(() => owned(page)).toBe(before + 1);
  await page.getByRole('group', { name: 'Which cards' }).getByRole('button', { name: 'Owned' }).click();
  await expect(page.locator('.settile', { has: page.getByText('Black Lotus', { exact: true }) })).toHaveCount(1);
  await page.getByRole('group', { name: 'Which cards' }).getByRole('button', { name: 'Missing' }).click();
  await expect(page.locator('.settile', { has: page.getByText('Black Lotus', { exact: true }) })).toHaveCount(0);

  // The card detail opens from a tile, and a search of the set finds cards printed in it.
  await page.getByRole('group', { name: 'Which cards' }).getByRole('button', { name: 'All' }).click();
  await page.getByRole('button', { name: 'Search this set in Cards' }).click();
  await expect(page.getByPlaceholder(/Search/)).toHaveValue('set:lea');
  // The search finds the set's cards (shown by popularity). The Cards view may also be filtered (an open deck's format, owned only), which
  // only ever removes a few, so the count is the set's or a little under it.
  const found = async () => Number(/^([\d,]+) cards/.exec(await page.locator('.status').innerText())?.[1]?.replace(/,/g, '') ?? 0);
  await expect.poll(async () => { const n = await found(); return n > setTotal - 30 && n <= setTotal; }).toBe(true); // (until the new search has replaced the old results)

  // Back in Sets, undo: the copy is taken off again.
  await tab(page).click();
  await page.getByLabel('Find a set').fill('limited edition alpha');
  await page.getByRole('button', { name: /Limited Edition Alpha \(LEA\)/ }).click();
  const again = await reveal(page, 'Black Lotus');
  await again.getByRole('button', { name: /One fewer Black Lotus/ }).click();
  await expect(again).toHaveClass(/missing/);
  await expect.poll(() => owned(page)).toBe(before);
});

test('only sets I own cards from, and the back button returns to the list', async ({ page }) => {
  await page.goto('/');
  await tab(page).click();
  await expect(page.locator('.setlist li').first()).toBeVisible();
  const all = await page.locator('.setlist li').count();
  expect(all).toBeGreaterThan(100);
  await page.getByRole('button', { name: /Limited Edition Alpha/ }).first().click();
  await expect(page.getByRole('heading', { name: /Limited Edition Alpha/ })).toBeVisible();
  await page.getByRole('button', { name: '← All sets' }).click();
  await expect(page.getByLabel('Find a set')).toBeVisible();
  await page.getByLabel('Only sets I own cards from').check();
  expect(await page.locator('.setlist li').count()).toBeLessThanOrEqual(all);
});
