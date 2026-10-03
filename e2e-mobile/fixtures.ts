import { _android as android, expect, test as base, type Page } from '@playwright/test';

/**
 * `test` for the mobile content. Normally Playwright makes its own browser. With ANDROID_APP=<package id> it instead drives that
 * app's real WebView on the running emulator or USB-connected phone (debug builds only), through adb.
 */
const appId = process.env.ANDROID_APP;

export const test = base.extend<{ page: Page }>(
  appId
    ? {
        // The WebView has exactly one page; reuse it, and make '/' mean the app's own origin.
        page: async ({}, use) => {
          const [device] = await android.devices();
          if (!device) throw new Error('No Android device or emulator is connected (see `adb devices`).');
          const page = await (await device.webView({ pkg: appId })).page();
          const goto = page.goto.bind(page);
          page.goto = ((url: string, opts?: Parameters<Page['goto']>[1]) => goto(url.startsWith('/') ? `https://localhost${url}` : url, opts)) as Page['goto'];
          await use(page);
          await device.close();
        },
      }
    : {},
);
export { expect };
