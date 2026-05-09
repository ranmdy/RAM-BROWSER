'use strict';

/**
 * screenshot-protection.test.js
 *
 * Tests the screenshot protection module (src/main/security/screenshot.js)
 * without requiring a full Electron context.
 *
 * Invariants:
 *  1. Content protection is toggled on/off correctly via applyContentProtection
 *  2. captureWindowFrame returns null when no window is attached
 *  3. triggerLock fires the callback and tracks reason
 *  4. Module exports all expected public symbols
 *  5. Protection state is tracked via isContentProtectionEnabled()
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Mock Electron modules (screenshot.js uses desktopCapturer + powerMonitor) ─

// We need to mock electron before requiring the module
const Module = require('node:module');
const originalLoad = Module._load;

// Create minimal mocks
const mockWindow = {
  _destroyed: false,
  _protected: false,
  _focusCbs: [],
  _blurCbs: [],
  isDestroyed() { return this._destroyed; },
  setContentProtection(val) { this._protected = val; },
  getSize() { return [1280, 800]; },
  getTitle() { return 'Ram Browser'; },
  webContents: {
    _sent: [],
    send(channel, data) { this._sent.push({ channel, data }); }
  },
  on(event, cb) {
    if (event === 'focus') this._focusCbs.push(cb);
    if (event === 'blur') this._blurCbs.push(cb);
  }
};

const mockPowerMonitor = {
  _handlers: {},
  on(event, cb) {
    this._handlers[event] = cb;
  }
};

const mockDesktopCapturer = {
  _shouldFail: false,
  _sources: [
    {
      name: 'Ram Browser',
      id: 'window:1:0',
      thumbnail: {
        toDataURL() { return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='; }
      }
    }
  ],
  async getSources({ types, thumbnailSize }) {
    if (this._shouldFail) throw new Error('capture failed');
    return this._sources;
  }
};

// Intercept electron require
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return {
      powerMonitor: mockPowerMonitor,
      desktopCapturer: mockDesktopCapturer
    };
  }
  return originalLoad.apply(this, arguments);
};

let screenshotModule;
try {
  screenshotModule = require('../src/main/security/screenshot');
} finally {
  Module._load = originalLoad;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Screenshot protection module', () => {
  it('exports expected public API', () => {
    assert.ok(typeof screenshotModule.attach === 'function', 'exports attach()');
    assert.ok(typeof screenshotModule.applyContentProtection === 'function', 'exports applyContentProtection()');
    assert.ok(typeof screenshotModule.triggerLock === 'function', 'exports triggerLock()');
    assert.ok(typeof screenshotModule.isContentProtectionEnabled === 'function', 'exports isContentProtectionEnabled()');
    assert.ok(typeof screenshotModule.captureWindowFrame === 'function', 'exports captureWindowFrame()');
  });

  it('isContentProtectionEnabled returns false before attach', () => {
    // Module-level state — false by default
    assert.equal(screenshotModule.isContentProtectionEnabled(), false);
  });

  it('applyContentProtection is a no-op when no window is attached', () => {
    // Should not throw
    assert.doesNotThrow(() => screenshotModule.applyContentProtection(true));
    assert.doesNotThrow(() => screenshotModule.applyContentProtection(false));
  });

  it('captureWindowFrame returns null when no window is attached', async () => {
    const result = await screenshotModule.captureWindowFrame();
    assert.equal(result, null);
  });

  it('triggerLock calls the lock callback with the reason', () => {
    let cbReason = null;
    // Re-attach with a fresh mock to get callback
    const win = {
      ...mockWindow,
      _protected: false,
      _focusCbs: [],
      _blurCbs: [],
      webContents: { _sent: [], send(c, d) { this._sent.push({ channel: c, data: d }); } },
      on(event, cb) {}
    };
    screenshotModule.attach(win, {
      lockOnSleep: false,
      onLock: (reason) => { cbReason = reason; }
    });
    screenshotModule.triggerLock('manual');
    assert.equal(cbReason, 'manual');
  });

  it('triggerLock sends security:lock IPC to webContents', () => {
    const sentMessages = [];
    const win = {
      _destroyed: false,
      isDestroyed() { return this._destroyed; },
      setContentProtection() {},
      getSize() { return [1280, 800]; },
      getTitle() { return 'Ram Browser'; },
      webContents: { send(c, d) { sentMessages.push({ channel: c, data: d }); } },
      on() {}
    };
    screenshotModule.attach(win, { lockOnSleep: false });
    screenshotModule.triggerLock('sleep');

    const lockMsg = sentMessages.find((m) => m.channel === 'security:lock');
    assert.ok(lockMsg, 'security:lock IPC was sent');
    assert.equal(lockMsg.data?.reason, 'sleep');
  });

  it('attach enables content protection on the window', () => {
    let protectionSet = null;
    const win = {
      _destroyed: false,
      isDestroyed() { return false; },
      setContentProtection(val) { protectionSet = val; },
      getSize() { return [1280, 800]; },
      getTitle() { return 'Ram Browser'; },
      webContents: { send() {} },
      on() {}
    };
    screenshotModule.attach(win, { contentProtection: true, lockOnSleep: false });
    assert.equal(protectionSet, true, 'setContentProtection(true) was called');
    assert.equal(screenshotModule.isContentProtectionEnabled(), true);
  });

  it('attach disables content protection when contentProtection=false', () => {
    let protectionSet = null;
    const win = {
      _destroyed: false,
      isDestroyed() { return false; },
      setContentProtection(val) { protectionSet = val; },
      getSize() { return [1280, 800]; },
      getTitle() { return 'Ram Browser'; },
      webContents: { send() {} },
      on() {}
    };
    screenshotModule.attach(win, { contentProtection: false, lockOnSleep: false });
    assert.equal(protectionSet, false);
    assert.equal(screenshotModule.isContentProtectionEnabled(), false);
  });
});
