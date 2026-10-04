import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The website's page that hands Google's answer back to the phone app. A desktop browser can't follow the app's own link (it ends up on an
// error page), so the page is served from a made-up https address with that one navigation swapped for a recorder: everything else is the
// real file, and the address bar, the button and the requests are the real thing.
const SITE = 'https://site.test';
const APP = 'io.github.itsdommie.grimoire://oauth';
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

async function serve(page: Page) {
  const outside: string[] = [];
  const html = readFileSync(resolve('site/oauth-callback.html'), 'utf8');
  expect(html).toContain('location.replace(link);');
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== SITE) { outside.push(url.href); await route.abort(); return; }
    const file = url.pathname === '/oauth-callback.html' ? null : resolve('site', url.pathname.slice(1));
    try {
      const body = file ? readFileSync(file) : html.replace('location.replace(link);', 'window.__went = link;');
      await route.fulfill({ contentType: TYPES[extname(url.pathname)] ?? 'application/octet-stream', body });
    } catch { await route.fulfill({ status: 404 }); }
  });
  return outside;
}
const went = (page: Page) => page.evaluate(() => (window as unknown as { __went?: string }).__went);

test('passes Google\'s answer to the app\'s link, then scrubs it from the address bar', async ({ page }) => {
  await serve(page);
  await page.goto(`${SITE}/oauth-callback.html?code=4%2Fthe-code&state=abc123&scope=x`);
  const link = `${APP}?code=4%2Fthe-code&state=abc123&scope=x`;
  expect(await went(page)).toBe(link);
  await expect(page.getByRole('link', { name: 'Open Grimoire' })).toHaveAttribute('href', link); // the button is the fallback if the app doesn't open by itself
  expect(new URL(page.url()).search).toBe(''); // the code is not left in the browser's history
});

test('passes on a refusal (the person said no) the same way', async ({ page }) => {
  await serve(page);
  await page.goto(`${SITE}/oauth-callback.html?error=access_denied&state=abc123`);
  expect(await went(page)).toBe(`${APP}?error=access_denied&state=abc123`);
});

test('says what it is for when someone opens it without signing in, and offers no way into the app', async ({ page }) => {
  await serve(page);
  await page.goto(`${SITE}/oauth-callback.html`);
  await expect(page.getByRole('heading', { name: 'Nothing to do here' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Grimoire' })).toBeHidden();
  expect(await went(page)).toBeUndefined();
});

test('cannot be turned against the app: whatever follows the address, it only ever goes to the app\'s own link', async ({ page }) => {
  await serve(page);
  await page.goto(`${SITE}/oauth-callback.html?code=x&state=y&redirect=https://evil.example/&next=javascript:alert(1)`);
  expect((await went(page))!.startsWith(`${APP}?`)).toBe(true);
});

test('loads nothing from any other site', async ({ page }) => {
  const outside = await serve(page);
  await page.goto(`${SITE}/oauth-callback.html?code=c&state=s`);
  await page.waitForTimeout(300);
  expect(outside).toEqual([]);
});
