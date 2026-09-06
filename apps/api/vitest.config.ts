import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    globalSetup: './test/global-setup.ts',
    setupFiles: ['./test/setup.ts'],
    hookTimeout: 30000,
    testTimeout: 120000,
    pool: 'forks',
    poolOptions: {
      // Bounds parallel DB load: 6 workers × ~11 connections max each.
      forks: { maxForks: 6 },
    },
  },
});
