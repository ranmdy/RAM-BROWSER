'use strict';

/**
 * E2E: panic multi-window propagation.
 *
 * Verifies that panic triggered from ANY window (including a non-primary one)
 * wipes and resets EVERY open window — main-process broadcast fan-out via
 * 'privacy:panic-triggered' at the end of performPanic().
 *
 * Uses its own Electron instance + scratch RAM_USER_DATA dir.
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
let scratchDir;

test.beforeAll(async () => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ram-e2e-panic-'));
  electronApp = await electron.launch({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RAM_USER_DATA: scratchDir
    }
  });
  const first = await electronApp.firstWindow();
  await first.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp?.close();
  if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
});

async function windowCount() {
  return electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

// Click the real "New Window" app-menu item in the main process.
async function openNewWindowViaMenu() {
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
}

// Wait until Playwright sees `n` UI pages, all DOM-ready.
async function readyPages(n) {
  await expect.poll(() => electronApp.windows().length, { timeout: 15000 }).toBe(n);
  const pages = electronApp.windows();
  for (const p of pages) await p.waitForLoadState('domcontentloaded');
  return pages;
}

test('panic from a non-primary window resets ALL windows', async () => {
  const before = await windowCount();
  expect(before).toBe(1);

  // Open 3 additional windows via the real app menu (4 total)
  for (let i = 0; i < 3; i++) {
    await openNewWindowViaMenu();
    await expect.poll(() => windowCount(), { timeout: 10000 }).toBe(before + i + 1);
  }
  const pages = await readyPages(4);

  // Create extra tabs in windows 0, 1 and 2 so there is state to wipe
  for (const idx of [0, 1, 2]) {
    await pages[idx].click('#tabBarNewBtn');
    await pages[idx].click('#tabBarNewBtn');
    await expect(pages[idx].locator('.tab')).toHaveCount(3, { timeout: 5000 });
  }
  // Window 3 keeps its single dashboard tab
  await expect(pages[3].locator('.tab')).toHaveCount(1);

  // Trigger panic from window #2 — NOT the primary window
  await pages[2].evaluate(() => triggerPanic()); // top-level classic-script fn → global

  // Every window must reset to a single dashboard tab with an empty URL bar
  for (const [i, p] of pages.entries()) {
    await expect(p.locator('.tab'), `window ${i} tab count`).toHaveCount(1, { timeout: 10000 });
    await expect(p.locator('.tab.active'), `window ${i} active tab`).toHaveCount(1);
    expect(await p.locator('#urlInput').inputValue(), `window ${i} url bar`).toBe('');
  }

  // No windows were closed (all 4 are global-profile shells)
  expect(await windowCount()).toBe(4);
});

test('main-process panic path (menu accelerator equivalent) resets all windows again', async () => {
  const pages = electronApp.windows();
  expect(pages.length).toBe(4);

  // Re-create tabs in two windows
  for (const idx of [1, 3]) {
    await pages[idx].click('#tabBarNewBtn');
    await expect(pages[idx].locator('.tab')).toHaveCount(2, { timeout: 5000 });
  }

  // Click the real "Panic — Wipe Everything" menu item in the main process.
  // It sends 'menu:panic' to the focused window → triggerPanic() → main wipe
  // → broadcast. Focus a secondary window first so the trigger is non-primary.
  await electronApp.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    const newest = wins.reduce((a, b) => (a.id > b.id ? a : b));
    newest.focus();
  });
  const clicked = await electronApp.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return false;
    const findItem = (items) => {
      for (const item of items) {
        if (item.label && item.label.startsWith('Panic')) return item;
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

  for (const [i, p] of pages.entries()) {
    await expect(p.locator('.tab'), `window ${i} tab count`).toHaveCount(1, { timeout: 10000 });
    expect(await p.locator('#urlInput').inputValue(), `window ${i} url bar`).toBe('');
  }
});
