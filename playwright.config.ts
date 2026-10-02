import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

// Uses the system Chromium (no Playwright browser download) and a throwaway copy of the card
// database on separate ports, so e2e runs never touch your real decks. Requires `npm run ingest`.
const API = 3101;
const WEB = 5273;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${WEB}`, launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium' } },
  webServer: [
    {
      command: 'node scripts/prepare-e2e-db.mjs && npm run start -w @grimoire/server',
      env: { PORT: String(API), GRIMOIRE_DB: resolve('data/e2e.db') },
      url: `http://127.0.0.1:${API}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev:web',
      env: { WEB_PORT: String(WEB), GRIMOIRE_API: `http://127.0.0.1:${API}` },
      url: `http://127.0.0.1:${WEB}`,
      reuseExistingServer: false,
    },
  ],
});
