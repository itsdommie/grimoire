import { defineConfig } from '@playwright/test';

// Needs a display. Builds nothing itself: run `npm run build -w @grimoire/desktop` first
// (the `e2e:desktop` script does).
export default defineConfig({
  testDir: 'e2e-desktop',
  workers: 1,
  timeout: 60_000,
});
