import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'data/**/*.test.ts',
      'cloudfunctions/**/*.test.ts',
      'miniprogram/**/*.test.ts',
      'tests/e2e/**/*.test.ts'
    ],
    exclude: ['**/node_modules/**', 'tests/smoke/**'],
    passWithNoTests: false,
  },
});
