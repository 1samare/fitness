import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173';

export default defineConfig({
  timeout: 90_000,
  testDir: './tests',
  globalSetup: './tests/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ]
});
