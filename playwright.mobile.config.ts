import { defineConfig, devices } from '@playwright/test';

// The Android app's web content (packages/mobile/dist) in a desktop browser: the real UI over the shared API running on SQLite WASM.
// Build it first with `npm run build -w @grimoire/mobile`.
export default defineConfig({
  testDir: 'e2e-mobile',
  workers: 1,
  timeout: 90_000,
  use: { baseURL: 'http://127.0.0.1:8124', launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium' } },
  projects: [
    { name: 'wide', use: {} },
    // A phone-sized touch screen: the layout the Android app actually shows (panes behind a bottom bar, no hover).
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: { command: 'node packages/mobile/serve.mjs', url: 'http://127.0.0.1:8124/index.html', reuseExistingServer: false, timeout: 30_000 },
});
