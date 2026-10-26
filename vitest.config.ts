import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // PGlite instances are heavy; keep database tests in one process.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
