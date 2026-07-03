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
 * With contextIsolation=true the preload runs in an ISOLATED world — patching
 * globals here is invisible to page scripts. All patches are therefore injected
 * into the MAIN world via webFrame.executeJavaScript, which runs before any
 * page script because the preload completes before document parsing begins.
 *
 * The profile label is fetched synchronously over IPC at preload time
 * (ipcRenderer.sendSync is available in sandboxed preloads), fixing the old
 * race where the label was injected at dom-ready — after this file had
 * already read it.
 */

const { ipcRenderer, webFrame } = require('electron');

let profileLabel = '';
try {
  profileLabel = ipcRenderer.sendSync('tabs:get-profile-label') || '';
} catch {
  profileLabel = '';
}

const MAIN_WORLD_PATCHES = `(() => {
  'use strict';

  // Live profile label — main process updates this on profile switch via
  // executeJavaScript, and the Notification patch reads it at call time.
  window.__RAM_PROFILE_LABEL__ = ${JSON.stringify(profileLabel)};

  // ── Fingerprint hardening ─────────────────────────────────────────────────

  // 1. Canvas noise — imperceptible per-session noise on pixel reads so
  //    trackers can't use canvas fingerprinting.
  try {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
      const imageData = origGetImageData.apply(this, args);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
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
        ctx.fillStyle = 'rgba(' + Math.floor(Math.random()*2) + ',' + Math.floor(Math.random()*2) + ',' + Math.floor(Math.random()*2) + ',0.001)';
        ctx.fillRect(0, 0, 1, 1);
        ctx.restore();
      }
      return origToDataURL.apply(this, args);
    };
  } catch {}

  // 2. AudioContext fingerprint noise
  try {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(...args) {
      const data = origGetChannelData.apply(this, args);
      for (let i = 0; i < data.length; i += 100) {
        data[i] += (Math.random() - 0.5) * 0.0001;
      }
      return data;
    };
  } catch {}

  // 3. Hardware concurrency — report 4 regardless of real core count
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
  } catch {}

  // 4. Device memory — report 4GB regardless of actual RAM
  try {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 4 });
  } catch {}

  // 5. Font enumeration — block document.fonts.check() as a fingerprint vector
  try {
    if (document.fonts) {
      const origCheck = document.fonts.check.bind(document.fonts);
      const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
      document.fonts.check = function(font, text) {
        try {
          const family = font.replace(/\\d+px\\s+/, '').trim().toLowerCase().replace(/['"]/g, '');
          if (!GENERIC.has(family)) return false;
        } catch {}
        return origCheck(font, text);
      };
    }
  } catch {}

  // ── Notification patch ────────────────────────────────────────────────────
  // Always strip \`tag\` (cross-tab fingerprinting vector); prefix the title
  // with the profile label when one is set.
  try {
    const OriginalNotification = window.Notification;
    if (OriginalNotification) {
      function PatchedNotification(title, options = {}) {
        const label = window.__RAM_PROFILE_LABEL__ || '';
        const prefixedTitle = label ? '[' + label + '] ' + title : title;
        const { tag: _tag, ...safeOptions } = options;
        return new OriginalNotification(prefixedTitle, safeOptions);
      }

      PatchedNotification.prototype = OriginalNotification.prototype;
      Object.defineProperties(PatchedNotification, {
        permission:        { get: () => OriginalNotification.permission },
        requestPermission: { value: (...args) => OriginalNotification.requestPermission(...args) },
        maxActions:        { get: () => OriginalNotification.maxActions }
      });

      Object.defineProperty(window, 'Notification', {
        configurable: true,
        writable: true,
        value: PatchedNotification
      });
    }
  } catch {}
})();`;

webFrame.executeJavaScript(MAIN_WORLD_PATCHES).catch(() => {});
