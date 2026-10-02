import { expect, test } from '@playwright/test';

test('searching shows matching cards', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder(/Search/).fill('!"sol ring"');
  await expect(page.locator('.tile .name')).toHaveText(['Sol Ring']);
  await expect(page.locator('.status')).toContainText('1 cards');
});

test('example chips fill the search box', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /is:commander/ }).click();
  await expect(page.getByPlaceholder(/Search/)).toHaveValue(/is:commander/);
  await expect(page.locator('.tile').first()).toBeVisible();
});

test('bad queries show an error instead of crashing', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder(/Search/).fill('bogus:1');
  await expect(page.locator('.status .error')).toContainText('Unknown search keyword');
});
