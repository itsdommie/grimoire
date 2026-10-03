import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

// Uses the system Chromium (no Playwright browser download) and throwaway data on separate ports, so e2e
// runs never touch your real decks. The "main" servers need `npm run ingest` to have been run once.
const MAIN = { api: 3101, web: 5273, dir: resolve('data/e2e') };
const FIRST_RUN = { api: 3102, web: 5274, dir: resolve('data/e2e-first-run') };
const fixture = resolve('e2e/fixtures/cards.jsonl');
const rulings = resolve('e2e/fixtures/rulings.jsonl');
const tags = resolve('e2e/fixtures/tags.jsonl');
const prices = resolve('e2e/fixtures/prices.jsonl');

const servers = (s: typeof MAIN, prepare: string, extraEnv: Record<string, string> = {}) => [
  {
    command: `${prepare}npm run start -w @grimoire/server`,
    env: { PORT: String(s.api), GRIMOIRE_DATA_DIR: s.dir, ...extraEnv },
    url: `http://127.0.0.1:${s.api}/api/health`,
    reuseExistingServer: false,
  },
  {
    command: 'npm run dev:web',
    env: { WEB_PORT: String(s.web), GRIMOIRE_API: `http://127.0.0.1:${s.api}` },
    url: `http://127.0.0.1:${s.web}`,
    reuseExistingServer: false,
  },
];

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  use: { launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium' } },
  projects: [
    { name: 'app', testIgnore: /first-run/, use: { baseURL: `http://127.0.0.1:${MAIN.web}` } },
    { name: 'first-run', testMatch: /first-run/, use: { baseURL: `http://127.0.0.1:${FIRST_RUN.web}` } },
  ],
  webServer: [
    ...servers(MAIN, 'node scripts/prepare-e2e-db.mjs && ', { GRIMOIRE_FAKE_EMBEDDINGS: '1', GRIMOIRE_FAKE_ADVISOR: '1' }),
    // Empty data directory + a local bulk file: exercises the first-run download/import flow without the network.
    ...servers(FIRST_RUN, 'node -e "require(\'fs\').rmSync(process.env.GRIMOIRE_DATA_DIR,{recursive:true,force:true})" && ', { GRIMOIRE_BULK_FILE: fixture, GRIMOIRE_RULINGS_FILE: rulings, GRIMOIRE_TAGS_FILE: tags, GRIMOIRE_PRICES_FILE: prices }),
  ],
});
