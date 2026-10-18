import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './generated-tests',
  timeout: 20000,
  retries: 0,
  workers: 1,
  expect: { timeout: 5000 },
  use: {
    headless: true,
    actionTimeout: 7000,
    navigationTimeout: 10000,
  },
});
