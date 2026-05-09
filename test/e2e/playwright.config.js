'use strict';

// Playwright E2E configuration for Ram Browser (Electron)
// Run with: npx playwright test --config test/e2e/playwright.config.js

/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: './',
  testMatch: '**/*.e2e.js',
  timeout: 30000,
  use: {
    headless: false  // Electron apps run with a window
  },
  // Run tests sequentially (Electron is single-process per test)
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/e2e' }]]
};
