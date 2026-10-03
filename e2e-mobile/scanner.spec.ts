import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// The scanner screen with a fake camera and a stand-in for ML Kit: the camera frame is ignored and the "OCR" returns whatever the test
// puts in window.__ocr. (The real recognizer is covered by android.spec.ts on an emulator.)
test.skip(!!process.env.ANDROID_APP, 'uses a stub recognizer; android.spec.ts covers the real one');

const title = (text: string) => [{ text, left: 30, top: 28, width: 260, height: 34 }];
const setOcr = (page: Page, lines: unknown[] | null) => page.evaluate((l) => { (window as unknown as { __ocr: unknown }).__ocr = l; }, lines);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __ocr: unknown }).__ocr = [];
    window.grimoireNative = {
      textRecognition: { recognize: async () => ({ width: 400, height: 560, lines: (window as unknown as { __ocr: never[] }).__ocr }) },
    };
  });
});

test('scans cards into the collection: confirmed over two frames, once per card until it is taken away, and can be taken back', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Scan cards with the camera' }).click();
  const scanner = page.getByRole('dialog', { name: 'Scan cards' });
  await expect(scanner.getByText('Fit the card inside the outline')).toBeVisible({ timeout: 30_000 });
  await expect(scanner.getByText('Nothing scanned yet.')).toBeVisible();

  await setOcr(page, title('Sol Rlng'));  // a slightly misread title still finds the card
  await expect(scanner.getByRole('status').filter({ hasText: '✓ Sol Ring' })).toBeVisible({ timeout: 15_000 });
  const list = scanner.getByRole('list', { name: 'Scanned this session' });
  await expect(list.locator('li')).toHaveCount(1);
  await expect(list.getByRole('group', { name: 'Copies of Sol Ring scanned' })).toContainText('1');

  // The same card staying in view is not added again.
  await page.waitForTimeout(1500);
  await expect(list.getByRole('group', { name: 'Copies of Sol Ring scanned' })).toContainText('1');

  // Taken away, then shown again: a second copy.
  await setOcr(page, []);
  await page.waitForTimeout(800);
  await setOcr(page, title('Sol Ring'));
  await expect(list.getByRole('group', { name: 'Copies of Sol Ring scanned' })).toContainText('2', { timeout: 15_000 });

  // Rules text that happens to be a card name is not in the title band, so it is ignored; a different card is found next.
  await setOcr(page, [{ text: 'Command Tower', left: 30, top: 400, width: 260, height: 30 }]);
  await page.waitForTimeout(1500);
  await expect(list.locator('li')).toHaveCount(1);
  await setOcr(page, title('Command Tower'));
  await expect(list.locator('li')).toHaveCount(2, { timeout: 15_000 });

  // Manual correction: take one back.
  await list.getByRole('button', { name: 'Take back one Sol Ring' }).click();
  await expect(list.getByRole('group', { name: 'Copies of Sol Ring scanned' })).toContainText('1');
  await setOcr(page, []);

  // Done: the collection really has them.
  await scanner.getByRole('button', { name: /^Done \(2\)/ }).click();
  await expect(scanner).toHaveCount(0);
  const summary = await (await page.request.get('/api/collection/summary')).json().catch(() => null);
  void summary; // (the on-device API is not reachable over HTTP; check through the UI instead)
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
  await expect(page.locator('.collbar')).toContainText('2 cards · 2 unique');
  await expect(page.locator('.tile', { hasText: 'Sol Ring' }).locator('.stepper')).toContainText('1');
  await expect(page.locator('.tile', { hasText: 'Command Tower' }).locator('.stepper')).toContainText('1');
});

test('scans cards into the open deck, and says so when the camera is unavailable', async ({ page }) => {
  await page.goto('/');
  // A deck to scan into.
  const phone = await page.evaluate(() => window.innerWidth <= 900);
  if (phone) await page.locator('.mobilebar').getByRole('button', { name: /^Deck/ }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('dialog', { name: 'New deck' }).getByLabel('Deck name').fill('Scanned deck');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.deckhead h2')).toHaveText('Scanned deck');
  if (phone) await page.locator('.mobilebar').getByRole('button', { name: /^Browse/ }).click();

  await page.getByRole('button', { name: 'Scan cards with the camera' }).click();
  const scanner = page.getByRole('dialog', { name: 'Scan cards' });
  await scanner.getByRole('button', { name: 'Deck', exact: true }).click();
  await expect(scanner.getByRole('status').filter({ hasText: 'adding to “Scanned deck”' })).toBeVisible({ timeout: 30_000 });
  await setOcr(page, title('Arcane Signet'));
  // (the empty list is itself an <li>, so look for the card, not a count)
  await expect(scanner.getByRole('list', { name: 'Scanned this session' }).locator('li', { hasText: 'Arcane Signet' })).toBeVisible({ timeout: 15_000 });
  await setOcr(page, []);
  await scanner.getByRole('button', { name: /^Done/ }).click();
  if (phone) await page.locator('.mobilebar').getByRole('button', { name: /^Deck/ }).click();
  await expect(page.locator('.deck .row .rname', { hasText: 'Arcane Signet' })).toBeVisible();

  // No camera permission: a clear message and a way to retry, not a blank screen.
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
  if (phone) await page.locator('.mobilebar').getByRole('button', { name: /^Browse/ }).click();
  await page.getByRole('button', { name: 'Scan cards with the camera' }).click();
  await expect(page.getByRole('alert')).toContainText('Camera access was denied');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});
