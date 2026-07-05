'use strict';

/**
 * Screenshot and screen-capture protection for Ram Browser.
 *
 * Uses Electron's setContentProtection() which maps to:
 *   macOS  – NSWindowSharingNone  (window excluded from screenshots, screen share, recordings)
 *   Windows – SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
 *   Linux  – not supported by Electron (no-op)
 *
 * Also provides focus-loss overlay: when the window loses focus the renderer
 * can show a blur overlay so screen content is not readable at a glance.
 *
 * Safe screenshot tool:
 *   - Renderer requests capture via `screenshot:capture` IPC
 *   - Main temporarily disables content protection, captures frame, re-enables
 *   - Renderer applies redaction and returns final base64 PNG
 */

const { powerMonitor, desktopCapturer } = require('electron');

let _window = null;
let _contentProtectionEnabled = false;
let _lockOnSleep = false;
let _lockCallback = null;

/**
 * Attach screenshot protection to a BrowserWindow.
 * @param {import('electron').BrowserWindow} win
 * @param {object} [opts]
 * @param {boolean} [opts.contentProtection]  Enable OS-level capture blocking (default true)
 * @param {boolean} [opts.lockOnSleep]        Lock profile when system sleeps (default true)
 * @param {Function} [opts.onLock]            Called when a lock event fires
 */
function attach(win, opts = {}) {
  _window = win;
  _lockOnSleep = opts.lockOnSleep !== false;
  _lockCallback = opts.onLock || null;

  const enableProtection = opts.contentProtection !== false;

  applyContentProtection(enableProtection);

  // Notify renderer when window focus changes so it can show/hide blur overlay
  win.on('focus', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:focus', true);
    }
  });

  win.on('blur', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:focus', false);
    }
  });

  // Lock on sleep
  if (_lockOnSleep) {
    powerMonitor.on('suspend', () => {
      triggerLock('sleep');
    });
    powerMonitor.on('lock-screen', () => {
      triggerLock('lock-screen');
    });
  }
}

/**
 * Enable or disable OS-level content protection.
 * @param {boolean} enabled
 */
function applyContentProtection(enabled) {
  if (!_window || _window.isDestroyed()) return;
  try {
    _window.setContentProtection(enabled);
    _contentProtectionEnabled = enabled;
  } catch {
    // setContentProtection may not be available on all platforms/versions
  }
}

/**
 * Trigger a lock event (notify renderer to show PIN screen).
 * @param {'sleep'|'lock-screen'|'manual'} reason
 */
function triggerLock(reason) {
  // When a lock callback is attached it owns the lock policy (PIN-less
  // profile guard, auto-lock setting, multi-window broadcast). Sending
  // 'security:lock' directly here as well would bypass those guards.
  if (_lockCallback) {
    _lockCallback(reason);
    return;
  }

  if (_window && !_window.isDestroyed()) {
    _window.webContents.send('security:lock', { reason });
  }
}

/**
 * Returns whether content protection is currently active.
 * @returns {boolean}
 */
function isContentProtectionEnabled() {
  return _contentProtectionEnabled;
}

/**
 * Capture a window frame as a base64 PNG data URL.
 * Content protection is temporarily disabled during capture, then re-enabled.
 * Redaction (URL bar, tab titles, etc.) is applied in the renderer.
 * @param {import('electron').BrowserWindow} [targetWin]  Window to capture
 *        (defaults to the primary window this module is attached to)
 * @returns {Promise<string|null>}
 */
async function captureWindowFrame(targetWin) {
  const win = targetWin || _window;
  if (!win || win.isDestroyed()) return null;

  // Temporarily disable content protection on the target so we can capture
  const wasProtected = _contentProtectionEnabled;
  if (wasProtected) {
    try { win.setContentProtection(false); } catch {}
  }

  try {
    const [width, height] = win.getSize();
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width, height }
    });

    // Find our window by title
    const winTitle = win.getTitle();
    const source = sources.find((s) => s.name === winTitle || s.name.includes('Ram Browser'))
      || sources.find((s) => s.id.includes('window'));

    if (!source) return null;
    return source.thumbnail.toDataURL();
  } catch {
    return null;
  } finally {
    if (wasProtected) {
      try { win.setContentProtection(true); } catch {}
    }
  }
}

module.exports = {
  attach,
  applyContentProtection,
  triggerLock,
  isContentProtectionEnabled,
  captureWindowFrame
};
