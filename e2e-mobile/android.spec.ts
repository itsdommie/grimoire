import { expect, test } from './fixtures';

// The real scanner pipeline in the app's real WebView on a running emulator or phone: the page's camera is replaced by a video
// stream showing real card images (so no hardware is needed), but everything after that is real: the frame crop, the ML Kit plugin,
// the matching in the on-device database, and the writes to the collection.
// Run with:  ANDROID_APP=io.github.itsdommie.grimoire npx playwright test -c playwright.mobile.config.ts --project=phone android
test.skip(!process.env.ANDROID_APP, 'needs a running Android emulator or phone (set ANDROID_APP)');

test('scans real cards through ML Kit into the collection', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Scan cards with the camera' })).toBeVisible();

  // A fake camera: a portrait frame with a black background and, when asked, a card drawn where the on-screen outline is.
  await page.evaluate(async () => {
    const load = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => resolve(img); img.onerror = () => reject(new Error(`could not load ${url}`)); img.src = url;
    });
    const images: Record<string, HTMLImageElement> = {};
    for (const name of ['Sol Ring', 'Lightning Bolt']) {
      const card = await (await fetch(`/api/cards/by-name/${encodeURIComponent(name)}`)).json();
      images[name] = await load(card.imageUrl);
    }
    const W = 720, H = 1280, ASPECT = 63 / 88;
    // The same outline the scanner uses: 80% of the height, or 90% of the width if the card would be wider than that.
    let h = 0.8, w = (h * H * ASPECT) / W;
    if (w > 0.9) { w = 0.9; h = (w * W) / (ASPECT * H); }
    const gx = ((1 - w) / 2) * W, gy = ((1 - h) / 2) * H;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    let showing: string | null = null;
    const draw = () => {
      ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, W, H);
      if (showing) ctx.drawImage(images[showing]!, gx, gy, w * W, h * H);
      requestAnimationFrame(draw);
    };
    draw();
    (window as unknown as { __show: (n: string | null) => void }).__show = (n) => { showing = n; };
    const stream = canvas.captureStream(15);
    navigator.mediaDevices.getUserMedia = async () => stream;
  });
  const show = (name: string | null) => page.evaluate((n) => (window as unknown as { __show: (n: string | null) => void }).__show(n), name);

  await page.getByRole('button', { name: 'Scan cards with the camera' }).click();
  const scanner = page.getByRole('dialog', { name: 'Scan cards' });
  const list = scanner.getByRole('list', { name: 'Scanned this session' });
  await expect(scanner.getByText('Fit the card inside the outline')).toBeVisible({ timeout: 30_000 });

  await show('Sol Ring');
  await expect(list.getByRole('group', { name: 'Copies of Sol Ring scanned' })).toContainText('1', { timeout: 60_000 });
  // Real OCR of the bottom of the card ("U 0021 / FRC • EN") names the exact printing, not just the card.
  await expect(list.locator('li', { hasText: 'Sol Ring' })).toContainText('#21', { timeout: 30_000 });
  await show(null);
  await page.waitForTimeout(1500);
  await show('Lightning Bolt');
  await expect(list.getByRole('group', { name: 'Copies of Lightning Bolt scanned' })).toContainText('1', { timeout: 60_000 });
  await expect(list.locator('li', { hasText: 'Lightning Bolt' })).toContainText('#806', { timeout: 30_000 }); // the Marvel printing, not Alpha or the featured one
  // Still in front of the camera: not added twice.
  await page.waitForTimeout(3000);
  await expect(list.getByRole('group', { name: 'Copies of Lightning Bolt scanned' })).toContainText('1');
  await show(null);

  await scanner.getByRole('button', { name: /^Done \(2\)/ }).click();
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
  await expect(page.locator('.collbar')).toContainText('2 cards · 2 unique');
  await expect(page.locator('.tile', { hasText: 'Sol Ring' }).locator('.printline')).toHaveText('FRC #21');
  await expect(page.locator('.tile', { hasText: 'Lightning Bolt' }).locator('.printline')).toHaveText('MSC #806');
});
