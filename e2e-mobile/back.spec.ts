import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// The Android Back button, as the web UI sees it: the app fires a cancelable "grimoire-back" event and leaves only if nobody cancelled it.
// `back()` fires it the same way and says whether something handled it (true) or the app would leave (false).
// (The real hardware button on an emulator is covered by android-back.spec.ts.)
test.skip(!!process.env.ANDROID_APP, 'uses a synthetic event; android-back.spec.ts uses the real button');

const back = (page: Page) => page.evaluate(() => !window.dispatchEvent(new CustomEvent('grimoire-back', { cancelable: true })));
const views = (page: Page) => page.getByRole('navigation', { name: 'Views' });
const pane = async (page: Page, name: 'Browse' | 'Deck') => { if (await page.evaluate(() => window.innerWidth <= 900)) await page.locator('.mobilebar').getByRole('button', { name: new RegExp(`^${name}`) }).click(); };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __ocr: unknown[] }).__ocr = [];
    window.grimoireNative = { textRecognition: { recognize: async () => ({ width: 400, height: 560, lines: (window as unknown as { __ocr: never[] }).__ocr }) } };
  });
  await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 60_000 });
});

test('with nothing open, Back is left to the app (it leaves)', async ({ page }) => {
  expect(await back(page)).toBe(false);
});

test('Back closes the card detail, then the app would leave', async ({ page }) => {
  await page.locator('.tile').first().getByRole('button', { name: /^Details for/ }).click();
  const detail = page.getByRole('dialog', { name: /details$/ });
  await expect(detail).toBeVisible();
  expect(await back(page)).toBe(true);
  await expect(detail).toHaveCount(0);
  expect(await back(page)).toBe(false);
});

test('Back goes from another view to Cards, and an open dialog is closed before the view changes', async ({ page }) => {
  await views(page).getByRole('button', { name: 'Collection' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Import collection' });
  await expect(dialog).toBeVisible();
  expect(await back(page)).toBe(true);
  await expect(dialog).toHaveCount(0);
  await expect(views(page).getByRole('button', { name: 'Collection' })).toHaveAttribute('aria-current', 'page'); // still in Collection
  expect(await back(page)).toBe(true);
  await expect(views(page).getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-current', 'page');
  expect(await back(page)).toBe(false);
  await views(page).getByRole('button', { name: 'Rules' }).click();
  expect(await back(page)).toBe(true);
  await expect(views(page).getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-current', 'page');
});

test('on a phone, Back goes from the deck to browsing; the new-deck dialog closes first', async ({ page }) => {
  test.skip(!(await page.evaluate(() => window.innerWidth <= 900)), 'panes only exist on a phone-sized screen');
  await pane(page, 'Deck');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const naming = page.getByRole('dialog', { name: 'New deck' });
  await expect(naming).toBeVisible();
  expect(await back(page)).toBe(true);
  await expect(naming).toHaveCount(0);
  await expect(page.locator('.mobilebar').getByRole('button', { name: /^Deck/ })).toHaveAttribute('aria-pressed', 'true'); // still on the deck
  expect(await back(page)).toBe(true);
  await expect(page.locator('.mobilebar').getByRole('button', { name: /^Browse/ })).toHaveAttribute('aria-pressed', 'true');
  expect(await back(page)).toBe(false);
});

test('Back closes the scanner, and the printing question first when it is open', async ({ page }) => {
  await page.getByRole('button', { name: 'Scan cards with the camera' }).click();
  const scanner = page.getByRole('dialog', { name: 'Scan cards' });
  await expect(scanner.getByText('Fit the card inside the outline')).toBeVisible({ timeout: 30_000 });
  // A card with no set code or number makes it ask which printing.
  await page.evaluate(() => { (window as unknown as { __ocr: unknown[] }).__ocr = [{ text: 'Lightning Bolt', left: 30, top: 28, width: 260, height: 34 }]; });
  const picker = page.getByRole('dialog', { name: 'Which printing of Lightning Bolt?' });
  await expect(picker).toBeVisible({ timeout: 20_000 });
  expect(await back(page)).toBe(true);
  await expect(picker).toHaveCount(0);
  await expect(scanner).toBeVisible(); // only the question went away, and nothing was added
  await expect(scanner.getByText('Nothing scanned yet.')).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __ocr: unknown[] }).__ocr = []; });
  expect(await back(page)).toBe(true);
  await expect(scanner).toHaveCount(0);
});

test('on a touch screen the search box does not grab the keyboard at start; on a desktop it is ready to type', async ({ page }) => {
  const touch = await page.evaluate(() => window.matchMedia('(hover: none)').matches);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('placeholder') ?? document.activeElement?.tagName ?? '');
  if (touch) expect(focused).not.toMatch(/Search/);
  else expect(focused).toMatch(/Search/);
});
