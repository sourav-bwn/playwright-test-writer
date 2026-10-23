import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './generated-tests',
  timeout: 20000,
  retries: 0,
  workers: 1,
  expect: { timeout: 5000 },
  use: {
    headless: true,
    // Pace real actions so a person watching the live view can actually see
    // the browser navigate, type and click. Still the real run, real time -
    // just not at machine speed. 0 when unset (unit tests, CI).
    launchOptions: { slowMo: Number(process.env.LIVE_SLOWMO_MS) || 0 },
    actionTimeout: 7000,
    navigationTimeout: 10000,
  },
});
