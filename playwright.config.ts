import { defineConfig } from '@playwright/test';

// Uses the system Chromium (no Playwright browser download). Requires `npm run ingest` to have been run.
export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://127.0.0.1:5173', launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium' } },
  webServer: [
    { command: 'npm run start -w @grimoire/server', url: 'http://127.0.0.1:3001/api/health', reuseExistingServer: true },
    { command: 'npm run dev:web', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
  ],
});
