import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 90000,
    hookTimeout: 90000,
    pool: 'forks',
    fileParallelism: false,
  },
});
