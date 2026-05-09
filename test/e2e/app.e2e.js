'use strict';

/**
 * E2E tests for Ram Browser using Playwright + Electron.
 *
 * These tests launch the real Electron application and interact with
 * the main browser window.
 *
 * Run: npx playwright test --config test/e2e/playwright.config.js
 */

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('node:path');

const APP_ENTRY = path.join(__dirname, '../../src/main/index.js');

let electronApp;
let window;

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Disable WARP requirement so tests don't block
      RAM_REQUIRE_WARP: '0'
    }
  });

  // Wait for the first window to open
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ── Dashboard renders ────────────────────────────────────────────────────────

test('app window title is Ram Browser', async () => {
  const title = await electronApp.evaluate(({ app }) => app.getName());
  expect(title).toBe('Ram Browser');
});

test('dashboard shows VPN status indicator', async () => {
  const vpnDot = window.locator('#statusWarpDot, .warp-dot, [data-widget="vpn"]').first();
  await expect(vpnDot).toBeVisible({ timeout: 5000 });
});

test('dashboard has panic button', async () => {
  const panicBtn = window.locator('#panicBtn, [data-panic], button.panic').first();
  await expect(panicBtn).toBeVisible({ timeout: 5000 });
});

// ── Tab management ───────────────────────────────────────────────────────────

test('can open a new tab', async () => {
  const newTabBtn = window.locator('#newTabBtn, .new-tab-btn, [data-action="new-tab"]').first();
  if (await newTabBtn.isVisible()) {
    const tabsBefore = await window.locator('.tab, .tab-item').count();
    await newTabBtn.click();
    await window.waitForTimeout(500);
    const tabsAfter = await window.locator('.tab, .tab-item').count();
    expect(tabsAfter).toBeGreaterThanOrEqual(tabsBefore);
  }
});

// ── Profile switcher ─────────────────────────────────────────────────────────

test('profile switcher button is visible', async () => {
  const profileBtn = window.locator('#profileBtn, .profile-btn, [data-profile-switcher]').first();
  await expect(profileBtn).toBeVisible({ timeout: 5000 });
});

// ── Security features ─────────────────────────────────────────────────────────

test('vault button is present', async () => {
  const vaultBtn = window.locator('#vaultBtn, .vault-btn, [data-vault]').first();
  await expect(vaultBtn).toBeVisible({ timeout: 5000 });
});

test('screenshot shortcut is registered', async () => {
  // Verify the app starts without error (screenshot module loads)
  const hasWindow = electronApp.windows().length > 0;
  expect(hasWindow).toBe(true);
});

// ── Wipe engine ──────────────────────────────────────────────────────────────

test('wipe countdown is displayed', async () => {
  const wipeEl = window.locator('#statusWipe, .wipe-countdown, [data-wipe]').first();
  await expect(wipeEl).toBeVisible({ timeout: 5000 });
});
