'use strict';

/**
 * tab-preload.js — injected into every WebContentsView (browser tab).
 *
 * Responsibilities:
 *  1. Override window.Notification to prefix title with the active profile name.
 *  2. Strip the `tag` field from notifications to prevent cross-tab fingerprinting.
 *  3. Fingerprint hardening: canvas noise, audio noise, font enumeration block,
 *     hardware concurrency spoof, device memory spoof.
 *
 * This file runs in the renderer context of guest pages (contextIsolation=true).
 * No Node.js APIs, no ipcRenderer.
 */

// ── Fingerprint hardening ─────────────────────────────────────────────────────

// 1. Canvas noise — add imperceptible per-session noise to canvas pixel data
//    so trackers can't use canvas fingerprinting to identify the browser.
(function patchCanvas() {
  const sessionNoise = (Math.random() - 0.5) * 0.02; // small fixed offset per page load

  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function(...args) {
    const imageData = origGetImageData.apply(this, args);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      // Tweak R and B channels by ±1 at most — invisible to the eye
      data[i]     = Math.max(0, Math.min(255, data[i]     + (Math.random() < 0.03 ? 1 : 0)));
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + (Math.random() < 0.03 ? 1 : 0)));
    }
    return imageData;
  };

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    const ctx = this.getContext('2d');
    if (ctx) {
      ctx.save();
      ctx.globalAlpha = 0.001;
      ctx.fillStyle = `rgba(${Math.floor(Math.random()*2)},${Math.floor(Math.random()*2)},${Math.floor(Math.random()*2)},0.001)`;
      ctx.fillRect(0, 0, 1, 1);
      ctx.restore();
    }
    return origToDataURL.apply(this, args);
  };
})();

// 2. AudioContext fingerprint noise
(function patchAudio() {
  const origGetChannelData = AudioBuffer.prototype.getChannelData;
  AudioBuffer.prototype.getChannelData = function(...args) {
    const data = origGetChannelData.apply(this, args);
    for (let i = 0; i < data.length; i += 100) {
      data[i] += (Math.random() - 0.5) * 0.0001;
    }
    return data;
  };
})();

// 3. Hardware concurrency — report 4 regardless of real core count
try {
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
} catch {}

// 4. Device memory — report 4GB regardless of actual RAM
try {
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 4 });
} catch {}

// 5. Font enumeration — block document.fonts.check() from being used as fingerprint
(function patchFonts() {
  if (!document.fonts) return;
  const origCheck = document.fonts.check.bind(document.fonts);
  const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
  document.fonts.check = function(font, text) {
    // Only reveal whether generic families are available — block specific font probes
    try {
      const family = font.replace(/\d+px\s+/, '').trim().toLowerCase().replace(/['"]/g, '');
      if (!GENERIC.has(family)) return false;
    } catch {}
    return origCheck(font, text);
  };
})();

// Profile name injected by main via webContents.executeJavaScript before load,
// or via a data attribute. Fallback to empty string.
const _profileLabel = window.__RAM_PROFILE_LABEL__ || '';

const OriginalNotification = window.Notification;

if (OriginalNotification && _profileLabel) {
  function PatchedNotification(title, options = {}) {
    const prefixedTitle = _profileLabel ? `[${_profileLabel}] ${title}` : title;
    // Strip tag to prevent cross-tab tracking via notification tags
    const { tag: _tag, ...safeOptions } = options;
    return new OriginalNotification(prefixedTitle, safeOptions);
  }

  // Copy static properties and prototype
  PatchedNotification.prototype = OriginalNotification.prototype;
  Object.defineProperties(PatchedNotification, {
    permission:      { get: () => OriginalNotification.permission },
    requestPermission: { value: (...args) => OriginalNotification.requestPermission(...args) },
    maxActions:      { get: () => OriginalNotification.maxActions }
  });

  try {
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: PatchedNotification
    });
  } catch {
    // Some environments may not allow redefining Notification — fail silently
  }
}
