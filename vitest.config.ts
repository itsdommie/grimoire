import { defineConfig } from 'vitest/config';

// Many tests build a real SQLite database and the Windows CI runners have slow disks, so the defaults (5 s / 10 s) flake.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
