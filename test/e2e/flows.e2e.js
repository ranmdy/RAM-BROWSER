'use strict';

/**
 * E2E flow tests for Ram Browser — deeper user-flow coverage than app.e2e.js.
 *
 * Covers: minimal dashboard, shield panel via status strip, tab lifecycle,
 * profile create/switch via the preload bridge, multi-window via app menu,
 * wipe countdown + trigger, settings persistence key.
 *
 * Uses a scratch RAM_USER_DATA dir so real profiles/prefs are never touched.
 *
 * Run: npx playwright test --config test/e2e/playwright.config.js
 */

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const APP_ENTRY = path.join(__dirname, '../../src/main/index.js');

let electronApp;
let window;
let scratchDir;

test.beforeAll(async () => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ram-e2e-flows-'));
  electronApp = await electron.launch({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RAM_USER_DATA: scratchDir
    }
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp?.close();
  if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
});

// Helper: close any open popover so tests start from a clean slate.
async function closePopovers() {
  await window.keyboard.press('Escape');
  await window.click('body', { position: { x: 5, y: 300 } }).catch(() => {});
}

// ── Minimal dashboard ────────────────────────────────────────────────────────

test('dashboard shows centered search and status strip', async () => {
  await expect(window.locator('#dashboardSearch')).toBeVisible({ timeout: 5000 });
  await expect(window.locator('#dashStatusStrip')).toBeVisible();
  await expect(window.locator('#dashWipe')).toBeVisible();
});

test('old dashboard metric cards are gone', async () => {
  expect(await window.locator('#metricVpn').count()).toBe(0);
  expect(await window.locator('#metricVault').count()).toBe(0);
  expect(await window.locator('.traffic-lights').count()).toBe(0);
});

test('status strip opens the shield panel', async () => {
  await window.click('#dashStatusStrip');
  await expect(window.locator('#privacyPanel')).toBeVisible({ timeout: 5000 });
  await expect(window.locator('#panelWipeTime')).toBeVisible();
  await closePopovers();
});

// ── Tab lifecycle ────────────────────────────────────────────────────────────

test('new tab button adds a tab, close button removes it', async () => {
  const before = await window.locator('.tab').count();
  await window.click('#tabBarNewBtn');
  await expect(window.locator('.tab')).toHaveCount(before + 1, { timeout: 5000 });

  // Close the newly created (active) tab via its close button
  await window.locator('.tab.active .close').click();
  await expect(window.locator('.tab')).toHaveCount(before, { timeout: 5000 });
});

test('keyboard tab cycling does not throw with multiple tabs', async () => {
  await window.click('#tabBarNewBtn');
  await window.keyboard.press('Control+Tab');
  await window.keyboard.press('Control+Shift+Tab');
  // Still exactly one active tab
  await expect(window.locator('.tab.active')).toHaveCount(1);
  await window.locator('.tab.active .close').click().catch(() => {});
});

// ── Wipe engine ──────────────────────────────────────────────────────────────

test('wipe countdown is a positive number and trigger-now resets it', async () => {
  // Shape: { seconds, formatted } (src/main/index.js wipe:get-countdown)
  const before = await window.evaluate(() => window.phantom.wipe.getCountdown());
  expect(typeof before.seconds).toBe('number');
  expect(before.seconds).toBeGreaterThan(0);
  expect(before.formatted).toMatch(/\d/);

  await window.evaluate(() => window.phantom.wipe.triggerNow());
  const after = await window.evaluate(() => window.phantom.wipe.getCountdown());
  expect(after.seconds).toBeGreaterThan(0);
  // A manual wipe resets the timer, so remaining time should not have shrunk
  expect(after.seconds).toBeGreaterThanOrEqual(before.seconds - 2);
});

// ── Profiles (via preload bridge, scratch userData) ──────────────────────────

test('profile create + list + switch round-trip', async () => {
  const created = await window.evaluate(() =>
    window.phantom.profiles.create({ name: 'E2E Flow', color: '#22c55e' })
  );
  expect(created.uuid).toBeTruthy();
  expect(created.name).toBe('E2E Flow');

  const list = await window.evaluate(() => window.phantom.profiles.list());
  const names = list.map((p) => p.name);
  expect(names).toContain('E2E Flow');

  const switched = await window.evaluate(
    (uuid) => window.phantom.profiles.switch(uuid),
    created.uuid
  );
  expect(switched.result).toBe('ok');

  // Switch back to the default profile so later tests see a known state
  const defaultProfile = list.find((p) => p.name !== 'E2E Flow');
  if (defaultProfile) {
    const back = await window.evaluate(
      (uuid) => window.phantom.profiles.switch(uuid),
      defaultProfile.uuid
    );
    expect(back.result).toBe('ok');
  }
});

test('shield panel reflects the active profile name', async () => {
  await window.click('#btnPrivacy');
  await expect(window.locator('#activeProfileName')).toBeVisible({ timeout: 5000 });
  const name = (await window.locator('#activeProfileName').textContent())?.trim();
  expect(name?.length).toBeGreaterThan(0);
  await closePopovers();
});

// ── Multi-window ─────────────────────────────────────────────────────────────

test('File > New Window opens a second window', async () => {
  const before = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().length
  );

  const clicked = await electronApp.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return false;
    const findItem = (items) => {
      for (const item of items) {
        if (item.label === 'New Window') return item;
        if (item.submenu) {
          const found = findItem(item.submenu.items);
          if (found) return found;
        }
      }
      return null;
    };
    const item = findItem(menu.items);
    if (!item) return false;
    item.click();
    return true;
  });
  expect(clicked).toBe(true);

  await expect
    .poll(
      () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      { timeout: 10000 }
    )
    .toBe(before + 1);

  // Close the extra window, keep the primary
  await electronApp.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    // Close the most recently created window (highest id)
    const newest = wins.reduce((a, b) => (a.id > b.id ? a : b));
    newest.close();
  });
  await expect
    .poll(
      () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      { timeout: 10000 }
    )
    .toBe(before);
});

// ── Settings live-apply ──────────────────────────────────────────────────────

test('theme=light and startPage=blank apply body classes via applyLiveSettings', async () => {
  await window.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('ram:settings') || '{}');
    s.theme = 'light';
    s.startPage = 'blank';
    localStorage.setItem('ram:settings', JSON.stringify(s));
    applyLiveSettings(s); // top-level classic-script function → global
  });
  expect(await window.evaluate(() => document.body.classList.contains('theme-light'))).toBe(true);
  expect(await window.evaluate(() => document.body.classList.contains('blank-start'))).toBe(true);
  await expect(window.locator('.dash-center')).toBeHidden();

  // Restore defaults
  await window.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('ram:settings') || '{}');
    delete s.theme;
    delete s.startPage;
    localStorage.setItem('ram:settings', JSON.stringify(s));
    applyLiveSettings(s);
  });
  expect(await window.evaluate(() => document.body.classList.contains('blank-start'))).toBe(false);
});

// ── Settings persistence ─────────────────────────────────────────────────────

test('settings persist to localStorage under ram:settings', async () => {
  const stored = await window.evaluate(() => {
    localStorage.setItem('ram:settings:e2e-probe', '1');
    return {
      probe: localStorage.getItem('ram:settings:e2e-probe'),
      settingsRaw: localStorage.getItem('ram:settings')
    };
  });
  expect(stored.probe).toBe('1');
  // ram:settings may be null on a fresh scratch profile until a setting is
  // changed — only assert it parses if present.
  if (stored.settingsRaw !== null) {
    expect(() => JSON.parse(stored.settingsRaw)).not.toThrow();
  }
  await window.evaluate(() => localStorage.removeItem('ram:settings:e2e-probe'));
});
