import { expect, test } from '@playwright/test';

// The header (name, search, six views, sort order) must stay inside the browse column at ordinary desktop widths, or it spills over the deck
// panel and covers its buttons (the Windows desktop smoke test caught this at about 1000px).
for (const width of [920, 1000, 1100, 1280]) {
  test(`the header stays clear of the deck panel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await expect(page.getByPlaceholder(/Search/)).toBeVisible();
    const deck = await page.locator('.deck').boundingBox();
    const header = page.locator('.browse > header');
    for (const el of await header.locator('> *').all()) {
      const box = await el.boundingBox();
      if (box) expect(box.x + box.width).toBeLessThanOrEqual(deck!.x + 1);
    }
    await page.getByRole('button', { name: 'New', exact: true }).click(); // would time out if something covered it
    await expect(page.getByRole('dialog', { name: 'New deck' })).toBeVisible();
  });
}
