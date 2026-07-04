'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, net, session, shell, globalShortcut, clipboard, protocol, Notification, Menu, dialog } = require('electron');
const path = require('node:path');

// ── shared ────────────────────────────────────────────────────────────────────
const { sanitiseUrl, isLocalAddress } = require('../shared/link-sanitiser');

// ── profiles ──────────────────────────────────────────────────────────────────
const profileManager = require('./profiles/manager');
const { verifyPin, setPin, setDecoyPin, deriveProfileKey } = require('./profiles/pin');
const { createSnapshotManager } = require('./privacy/tab-snapshot');

// ── privacy ───────────────────────────────────────────────────────────────────
const { wipeEngine, formatCountdown } = require('./privacy/wipe-engine');

// ── security ──────────────────────────────────────────────────────────────────
const screenshotSecurity = require('./security/screenshot');
const { stripDataUrlMetadata } = require('./security/exif-strip');
const { warpSupervisor } = require('./security/warp-supervisor');


// ── containers ────────────────────────────────────────────────────────────────
const CONTAINERS = ['default', 'work', 'social', 'finance', 'research'];
const PARTITIONS = new Map(CONTAINERS.map((c) => [c, `ram-${c}`]));

// ── env config ────────────────────────────────────────────────────────────────
let proxyUrl = process.env.RAM_PROXY_URL || process.env.PHANTOM_PROXY_URL || '';
let requireWarp = process.env.RAM_REQUIRE_VPN === '1';

// ── state ─────────────────────────────────────────────────────────────────────
let mainWindow = null;
// Multi-window registry — every BrowserWindow (primary, "New Window", and
// per-profile windows) gets an entry: { win, profile, partitions, tabViews }.
//  - profile: null for windows bound to the globally active profile;
//    a fixed {uuid,name,color} snapshot for isolated profile windows.
//  - partitions: Map(container → partition). Global windows share PARTITIONS;
//    profile windows get namespaced in-memory partitions (full isolation).
//  - tabViews: Map(tabId → WebContentsView), per window (tab ids are
//    renderer-generated and may collide across windows).
const windows = new Map();
// Namespaced partitions of currently-open profile windows — included in
// managedSessions() so panic/wipe/proxy changes cover them.
const extraPartitions = new Set();

function winStateFor(webContents) {
  const win = BrowserWindow.fromWebContents(webContents);
  return win ? windows.get(win.id) : null;
}

// Reverse lookup: which window owns the tab hosting this webContents?
function winStateForTabContents(webContents) {
  for (const ws of windows.values()) {
    for (const view of ws.tabViews.values()) {
      if (view.webContents === webContents) return ws;
    }
  }
  return null;
}

// Send to every window bound to the globally active profile (profile === null)
function sendGlobalProfileWindows(channel, payload) {
  for (const ws of windows.values()) {
    if (!ws.profile && !ws.win.isDestroyed()) ws.win.webContents.send(channel, payload);
  }
}

// Send to every open window (used for app-global state like vault mode)
function broadcast(channel, payload) {
  for (const ws of windows.values()) {
    if (!ws.win.isDestroyed()) ws.win.webContents.send(channel, payload);
  }
}

// Close all isolated profile windows (panic / ghost mode — no real-profile
// data may stay visible in a secondary window)
function closeProfileWindows() {
  for (const ws of [...windows.values()]) {
    if (ws.profile) { try { ws.win.close(); } catch {} }
  }
}
let vaultMode = 'session';
let vaultTimedExpiry = null;   // epoch ms for timed mode expiry
let vaultTimedTimer = null;    // NodeJS.Timeout for timed auto-revoke
let activeProfileUuid = null;
let activeProfileKey = null;  // key of the active profile (PIN-derived keys only exist post-unlock)
let activeProfileIsDecoy = false;
let activeProfileIsHidden = false;
let activeProfileHasPin = false; // PIN-less profiles must never be PIN-locked (unlockable = panic-wipe trap)
let activeProfileName = '';
let activeProfileColor = '';
let isScreenLocked = false; // true while PIN overlay is up
let tabSnapshotManager = null;
let wipeOnQuit = false;          // set by settings:wipe-on-quit IPC
let linkSanitiserEnabled = true; // set by settings:link-sanitiser IPC
let redirectBlockEnabled = true; // set by settings:redirect-block IPC
let httpsOnlyEnabled = true;     // set by settings:https-only IPC
let profileSwitchInProgress = false; // guard against concurrent profile switches
let warpStatusIntervalId = null; // reference for the periodic WARP status push

// Notification queue — stores {title, body} entries while screen is locked
const notificationQueue = [];

// Per-origin vault grant tracking — maps origin → Set<tabId>
// When a tab closes, its origin is removed. If no tabs remain for that origin,
// the grant is effectively revoked for subsequent permission requests.
const vaultGrantedOrigins = new Map(); // origin → Set<tabId>

function recordVaultGrant(tabId, origin) {
  if (!origin) return;
  try {
    const o = new URL(origin).origin;
    if (!vaultGrantedOrigins.has(o)) vaultGrantedOrigins.set(o, new Set());
    vaultGrantedOrigins.get(o).add(tabId);
  } catch {}
}

function revokeVaultGrant(tabId) {
  for (const [origin, tabSet] of vaultGrantedOrigins) {
    tabSet.delete(tabId);
    if (tabSet.size === 0) vaultGrantedOrigins.delete(origin);
  }
}

function hasVaultGrant(origin) {
  if (!origin) return vaultMode !== 'locked';
  try {
    const o = new URL(origin).origin;
    return vaultGrantedOrigins.has(o);
  } catch {
    return false;
  }
}

// ── privacy report counters ───────────────────────────────────────────────────
const MAX_SANITISED_SAMPLES = 100;

const privacyReport = {
  sanitised: 0,      // tracking params stripped from URLs
  blocked: 0,        // requests cancelled by kill switch or finance hardening
  mediaBlocked: 0,   // camera/mic permission requests denied
  requests: 0,       // total requests seen
  sanitisedSamples: [] // [{host, paramsRemoved}] capped at MAX_SANITISED_SAMPLES
};

function resetPrivacyReport() {
  privacyReport.sanitised = 0;
  privacyReport.blocked = 0;
  privacyReport.mediaBlocked = 0;
  privacyReport.requests = 0;
  privacyReport.sanitisedSamples = [];
}

function getPrivacyReport() {
  return { ...privacyReport };
}

// ── phantom:// custom protocol ─────────────────────────────────────────────────
// Must be called before app.whenReady()
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'phantom',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false
    }
  }
]);

// ── chromium flags ────────────────────────────────────────────────────────────
app.setName('Ram Browser');
app.commandLine.appendSwitch('enable-features', 'DnsOverHttps');
app.commandLine.appendSwitch('dns-over-https-server', 'https://1.1.1.1/dns-query');
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication');
// WebRTC leak protection: force all ICE candidates through the proxy, never expose real IP
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default_public_interface_only');
// Disable mDNS obfuscation so WebRTC doesn't generate .local candidates that bypass WARP
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Fingerprint hardening: disable Battery Status API (used as fingerprint vector)
app.commandLine.appendSwitch('disable-features', 'BatteryStatusManager');
// Disable sensor APIs that can be used for fingerprinting
app.commandLine.appendSwitch('disable-features', 'WebXR,GenericSensor');

// ─────────────────────────────────────────────────────────────────────────────
// WARP / proxy helpers
// ─────────────────────────────────────────────────────────────────────────────

function warpStatus() {
  return {
    connected: Boolean(proxyUrl),
    enforced: requireWarp,
    proxyUrl,
    label: proxyUrl
      ? `Proxy active: ${proxyUrl}`
      : requireWarp
        ? 'VPN required: network blocked until RAM_PROXY_URL is set'
        : 'Development mode: WARP proxy not configured'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session management
// ─────────────────────────────────────────────────────────────────────────────

function managedSessions() {
  return [...PARTITIONS.values(), ...extraPartitions].map((partition) => session.fromPartition(partition));
}

// ── Tracker/ad block list ─────────────────────────────────────────────────────
// Domains that are blocked at the network request level.
// This is a curated baseline list of major trackers and ad networks.
// Subdomains are matched: e.g. 'doubleclick.net' blocks 'ad.doubleclick.net'.
const BLOCK_DOMAINS = new Set([
  // Google advertising
  'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
  'googletagmanager.com', 'googletagservices.com', 'google-analytics.com',
  'googleanalytics.com', 'adservice.google.com', 'pagead2.googlesyndication.com',
  // Meta / Facebook
  'facebook.com', 'connect.facebook.net', 'facebook.net',
  // Analytics
  'hotjar.com', 'fullstory.com', 'logrocket.com', 'clarity.ms',
  'mixpanel.com', 'segment.com', 'segment.io', 'amplitude.com',
  'heap.io', 'mouseflow.com', 'smartlook.com',
  // Ad networks
  'ads.twitter.com', 'static.ads-twitter.com',
  'snap.licdn.com', 'px.ads.linkedin.com',
  'criteo.com', 'criteo.net', 'outbrain.com', 'taboola.com',
  'adsrvr.org', 'moatads.com', 'rubiconproject.com', 'pubmatic.com',
  'openx.net', 'appnexus.com', 'adnxs.com', 'turn.com',
  'doubleverify.com', 'rlcdn.com', 'casalemedia.com',
  // Fingerprinting / tracking utilities
  'fingerprintjs.com', 'cdn.jsdelivr.net/npm/fingerprintjs',
  // Beacons / pixels
  'bat.bing.com', 'sc-static.net', 'scorecardresearch.com',
  'quantserve.com', 'chartbeat.com', 'parsely.com',
]);

let trackerBlockEnabled = true; // set by settings:tracker-block IPC

// ── HTTPS-only upgrade tracking ───────────────────────────────────────────────
// upgradedHosts: hosts whose http:// requests we rewrote to https://.
// httpsExemptHosts: hosts whose upgrade failed at the TLS/connection layer —
// they load over plain http from then on (session-scoped, not persisted).
// Fallback only ever applies to hosts WE upgraded; explicit https:// URLs are
// never downgraded.
const upgradedHosts = new Set();
const httpsExemptHosts = new Set();

function isHttpsFallbackError(code) {
  // TLS handshake / certificate errors (-107, -113, -200..-218) and
  // connection-level failures that plain http may still serve.
  return code === -107 || code === -113 ||
         (code <= -200 && code >= -218) ||
         [-100, -101, -102, -118].includes(code);
}

function isBlockedDomain(rawUrl) {
  if (!trackerBlockEnabled) return false;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    // Check exact match and all parent domains
    const parts = hostname.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      if (BLOCK_DOMAINS.has(parts.slice(i).join('.'))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isNetworkRequest(rawUrl) {
  try {
    const { protocol } = new URL(rawUrl);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(protocol);
  } catch {
    return false;
  }
}

// Multi-label public suffixes where the registrable domain is three labels
// (e.g. bank.co.uk). Not exhaustive — covers the common cases; unknown hosts
// fall back to the two-label rule.
const SECOND_LEVEL_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.br', 'com.mx', 'com.ar', 'com.co',
  'co.in', 'co.za', 'co.kr', 'co.id', 'co.th',
  'com.sg', 'com.hk', 'com.tw', 'com.my', 'com.ph',
  'com.tr', 'com.cn', 'com.vn', 'com.eg', 'com.sa'
]);

function baseDomain(host) {
  const parts = host.toLowerCase().split('.');
  if (parts.length >= 3 && SECOND_LEVEL_TLDS.has(parts.slice(-2).join('.'))) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function isThirdPartyScript(details) {
  // Block third-party scripts in the finance container
  try {
    if (!/\.js(\?|$)/i.test(details.url)) return false;
    const reqHost = new URL(details.url).hostname;
    const ref = details.referrer || details.url;
    const refHost = new URL(ref).hostname;
    // Same host or subdomain relationship = first-party
    if (reqHost === refHost) return false;
    return baseDomain(reqHost) !== baseDomain(refHost);
  } catch {
    return false;
  }
}

async function configureSession(targetSession, partition = '') {
  if (targetSession.__ramConfigured) return;
  targetSession.__ramConfigured = true;

  // In-memory partitions (no `persist:` prefix) have no storagePath, so the
  // partition name must be passed in explicitly — never derived from paths.
  // Suffix match covers both global ('ram-finance') and profile-window
  // namespaced ('ram-p<uuid8>-finance') partitions.
  const isFinance = partition.endsWith('-finance');

  // Resolve the window that owns this partition (for dialogs/IPC). Prefers the
  // focused window when it holds the partition (global partitions are shared
  // by the primary and any "New Window" siblings).
  const ownerWindow = () => {
    const focused = BrowserWindow.getFocusedWindow();
    const focusedState = focused ? windows.get(focused.id) : null;
    if (focusedState && [...focusedState.partitions.values()].includes(partition)) return focused;
    for (const ws of windows.values()) {
      if (!ws.win.isDestroyed() && [...ws.partitions.values()].includes(partition)) return ws.win;
    }
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  };

  // Strip Electron from the user-agent so sites don't detect/block Electron
  const rawUA = targetSession.getUserAgent();
  const cleanUA = rawUA.replace(/\s*Electron\/[\d.]+/, '');
  targetSession.setUserAgent(cleanUA);

  targetSession.setSpellCheckerEnabled(false);

  // WebRTC IP leak protection — ensure ICE candidates only use the proxy/default interface
  // This must be set per-session in addition to the command-line flag for full coverage.
  if (targetSession.setWebRTCIPHandlingPolicy) {
    try { targetSession.setWebRTCIPHandlingPolicy('default_public_interface_only'); } catch {}
  }

  if (proxyUrl) {
    await targetSession.setProxy({
      proxyRules: proxyUrl,
      proxyBypassRules: '<local>'
    });
  }

  targetSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    // Finance container: deny everything including media
    if (isFinance) {
      if (permission === 'media') privacyReport.mediaBlocked++;
      callback(false);
      return;
    }
    if (permission === 'media') {
      const allowed = vaultMode !== 'locked';
      if (!allowed) {
        privacyReport.mediaBlocked++;
      } else {
        // Record the grant for per-origin tracking (grant keys are
        // window-scoped: `${winId}:${tabId}` — tab ids collide across windows)
        try {
          const origin = details?.requestingUrl || _wc.getURL();
          const ws = winStateForTabContents(_wc);
          const tabId = ws ? [...ws.tabViews.entries()].find(([, v]) => v.webContents === _wc)?.[0] : null;
          if (ws && tabId != null) recordVaultGrant(`${ws.win.id}:${tabId}`, origin);
        } catch {}
      }
      callback(allowed);
      return;
    }
    // ── Notification Guard ────────────────────────────────────────────────────
    if (permission === 'notifications') {
      // Decoy profile: hard-block
      if (activeProfileIsDecoy) { callback(false); return; }
      // Locked screen: deny so notifications don't surface until unlocked
      if (isScreenLocked) { callback(false); return; }
      // Standard + hidden (while active): allow
      callback(true);
      return;
    }
    callback(false);
  });

  // Permission CHECKS gate origins whose grant predates a state change
  // (lock, ghost mode, vault lock) — without this, an origin granted
  // notifications before the screen locked could keep firing them while
  // locked. Only user-visible permissions are gated: blanket denial here
  // breaks normal navigation and resource loading in Electron 41.
  targetSession.setPermissionCheckHandler((_wc, permission) => {
    switch (permission) {
      case 'notifications':
        return !isFinance && !activeProfileIsDecoy && !isScreenLocked;
      case 'media':
        return !isFinance && vaultMode !== 'locked';
      case 'geolocation':
        return false; // request handler never grants it
      default:
        return true;
    }
  });

  targetSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      privacyReport.requests++;

      if (requireWarp && !proxyUrl && isNetworkRequest(details.url) && !isLocalAddress(details.url)) {
        privacyReport.blocked++;
        callback({ cancel: true });
        return;
      }

      // Tracker/ad block list
      if (isBlockedDomain(details.url)) {
        privacyReport.blocked++;
        callback({ cancel: true });
        return;
      }

      // Finance container: block third-party scripts
      if (isFinance && isThirdPartyScript(details)) {
        privacyReport.blocked++;
        callback({ cancel: true });
        return;
      }

      // HTTPS-only: upgrade plain http:// → https:// for network requests.
      // Exemptions: local addresses (localhost, 127.x, RFC1918) and hosts
      // already confirmed HTTP-only after a failed upgrade.
      if (httpsOnlyEnabled && details.url.startsWith('http://') && isNetworkRequest(details.url) && !isLocalAddress(details.url)) {
        let host = null;
        try { host = new URL(details.url).hostname; } catch {}
        if (host && !httpsExemptHosts.has(host)) {
          upgradedHosts.add(host);
          callback({ redirectURL: details.url.replace(/^http:\/\//, 'https://') });
          return;
        }
      }

      if (linkSanitiserEnabled || redirectBlockEnabled) {
        const cleanedUrl = sanitiseUrl(details.url);
        // Compare against the *normalized* form of the original URL so that
        // cosmetic differences (e.g. URL parser adding a trailing slash to a
        // bare domain) don't trigger an unnecessary redirect that would cause
        // the webview to receive a spurious ERR_ABORTED for every navigation.
        let normalizedOriginal;
        try { normalizedOriginal = new URL(details.url).href; } catch { normalizedOriginal = details.url; }
        if (cleanedUrl !== normalizedOriginal) {
          privacyReport.sanitised++;
          // Record a sample (host + list of removed params)
          try {
            const origUrl = new URL(details.url);
            const cleanUrl = new URL(cleanedUrl);
            const origParams = [...origUrl.searchParams.keys()];
            const cleanParams = new Set(cleanUrl.searchParams.keys());
            const removed = origParams.filter((k) => !cleanParams.has(k));
            if (removed.length && privacyReport.sanitisedSamples.length < MAX_SANITISED_SAMPLES) {
              privacyReport.sanitisedSamples.push({ host: origUrl.hostname, paramsRemoved: removed });
            }
          } catch {}
          callback({ redirectURL: cleanedUrl });
          return;
        }
      }

      callback({ cancel: false });
    } catch {
      // Ensure callback is always called — a dropped callback hangs the request indefinitely.
      callback({ cancel: false });
    }
  });

  // ── Downloads ────────────────────────────────────────────────────────────────
  targetSession.on('will-download', (_e, item) => {
    const filename = item.getFilename();
    const defaultPath = path.join(app.getPath('downloads'), filename);
    const owner = ownerWindow();
    if (!owner) { item.cancel(); return; }
    const sendOwner = (ch, payload) => { if (!owner.isDestroyed()) owner.webContents.send(ch, payload); };
    dialog.showSaveDialog(owner, { defaultPath, title: 'Save file' }).then(({ canceled, filePath }) => {
      if (canceled || !filePath) { item.cancel(); return; }
      item.setSavePath(filePath);
      sendOwner('download:start', { filename, total: item.getTotalBytes() });
      item.on('updated', (_ev, state) => {
        if (state === 'progressing') {
          sendOwner('download:progress', {
            filename, received: item.getReceivedBytes(), total: item.getTotalBytes()
          });
        }
      });
      item.once('done', (_ev, state) => {
        sendOwner('download:done', { filename, state });
      });
    });
  });
}

async function configureManagedSessions() {
  await Promise.all(
    [...PARTITIONS.values()].map((partition) =>
      configureSession(session.fromPartition(partition), partition)
    )
  );
}

async function clearManagedStorage() {
  await Promise.all(
    managedSessions().map(async (s) => {
      await s.clearStorageData();
      await s.clearCache();
      await s.clearAuthCache();
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Activate a profile: start its wipe timer, set up tab snapshot, notify renderer.
 */
async function activateProfile(profile, key) {
  activeProfileUuid = profile.uuid;
  activeProfileKey = key || null;
  activeProfileName = profile.name || 'Anonymous';
  activeProfileColor = profile.color || '';
  activeProfileHasPin = Boolean(profile.hasPin);
  activeProfileIsHidden = Boolean(profile.hidden);
  // Reset vault to locked on every profile switch (feature #56 — prevent bleed)
  setVaultMode('locked');
  // Reset privacy report counters so each profile starts clean
  resetPrivacyReport();

  // Tab snapshot
  if (key) {
    const dir = profileManager.profileDir(profile.uuid);
    tabSnapshotManager = createSnapshotManager(dir, key);
  }

  // Wipe engine: schedule with this profile's own interval (from encrypted
  // prefs) so custom intervals survive profile switches instead of resetting
  // to the 24h default
  if (key) {
    try {
      const prefs = await profileManager.readPrefs(profile.uuid, key);
      const ms = Number(prefs.wipeIntervalMs);
      if (ms >= MIN_WIPE_MS && ms <= MAX_WIPE_MS) wipeIntervalMs = ms;
    } catch {}
  }
  const partitions = CONTAINERS.map((c) => `ram-${c}`);
  wipeEngine.schedule(profile.uuid, partitions, wipeIntervalMs);

  // Notify every window bound to the global profile (isolated profile
  // windows keep their own fixed profile)
  sendGlobalProfileWindows('profile:active', {
    uuid: profile.uuid,
    name: profile.name,
    color: profile.color
  });

  // Update the profile label in all live tabs of global-profile windows
  // (patched Notification reads it at call time in the main world)
  for (const ws of windows.values()) {
    if (ws.profile) continue;
    for (const view of ws.tabViews.values()) {
      view.webContents.executeJavaScript(
        `window.__RAM_PROFILE_LABEL__ = ${JSON.stringify(activeProfileName)};`
      ).catch(() => {});
    }
  }

  // Flush queued notifications on profile switch (no-op if locked or decoy)
  if (notificationQueue.length) {
    flushNotificationQueue();
  }
}

function flushNotificationQueue() {
  // Never display anything while locked or in ghost (decoy) mode — spec 6.14.
  // Queued items are retained until a legitimate unlock flushes them.
  if (isScreenLocked || activeProfileIsDecoy) return;
  if (!Notification.isSupported()) { notificationQueue.length = 0; return; }
  while (notificationQueue.length) {
    const { title, body } = notificationQueue.shift();
    try { new Notification({ title, body }).show(); } catch {}
  }
}

function sendNotification(title, body) {
  // Ghost (decoy) mode: hard-drop — never queue, never display (spec 6.14).
  if (activeProfileIsDecoy) return;
  if (isScreenLocked) {
    notificationQueue.push({ title, body });
    return;
  }
  if (Notification.isSupported()) {
    try { new Notification({ title, body }).show(); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Network probe
// ─────────────────────────────────────────────────────────────────────────────

function probeNetwork(url = 'https://www.google.com/generate_204') {
  return new Promise((resolve) => {
    let settled = false;
    const request = net.request({ method: 'GET', url });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.abort();
      resolve({ ok: false, url, error: 'Network probe timed out' });
    }, 8000);

    request.on('response', (response) => {
      response.on('data', () => {});
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 400,
          url,
          statusCode: response.statusCode
        });
      });
    });

    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, url, error: error.message });
    });

    request.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Webview hardening
// ─────────────────────────────────────────────────────────────────────────────

function hardenGuestWebContents(contents, ownerWin = null) {
  contents.setWindowOpenHandler(({ url }) => {
    const target = ownerWin && !ownerWin.isDestroyed() ? ownerWin : mainWindow;
    if (target && !target.isDestroyed() && /^https?:\/\//i.test(url)) {
      target.webContents.send('browser:new-tab-request', sanitiseUrl(url));
    }
    return { action: 'deny' };
  });

  // URL sanitisation (tracking param removal, redirect unwrapping) is handled
  // at the network level by onBeforeRequest, so no will-navigate redirect is needed.
}

// ─────────────────────────────────────────────────────────────────────────────
// Window creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a browser window.
 *
 * @param {object|null} profile — null: the window is bound to the globally
 *   active profile and shares the global `ram-*` partitions (Chrome "New
 *   Window" semantics: same profile ⇒ same session). Non-null: an ISOLATED
 *   profile window — it gets its own namespaced in-memory partitions
 *   (`ram-p<uuid8>-<container>`), fully separate storage from every other
 *   window. Only PIN-less, non-hidden profiles may be opened this way
 *   (opening via menu must never bypass PIN verification).
 */
async function createBrowserWindow(profile = null) {
  const isPrimary = !profile && !mainWindow;

  // Partition set for this window. Profile windows get namespaced partitions,
  // configured through the exact same hardening path as the global ones.
  let winPartitions;
  if (profile) {
    const ns = `ram-p${profile.uuid.slice(0, 8)}`;
    winPartitions = new Map(CONTAINERS.map((c) => [c, `${ns}-${c}`]));
    for (const partition of winPartitions.values()) extraPartitions.add(partition);
    await Promise.all(
      [...winPartitions.values()].map((partition) =>
        configureSession(session.fromPartition(partition), partition)
      )
    );
  } else {
    winPartitions = PARTITIONS;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    // Small enough that macOS Fill & Arrange can tile four windows into
    // screen quadrants on a laptop display (900x620 forced overlap).
    minWidth: 500,
    minHeight: 400,
    // Native macOS traffic lights (with the system Move & Resize / tiling
    // menu) inset into the custom toolbar; no title bar chrome.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: '#0f0f11',
    title: profile ? `Ram Browser — ${profile.name}` : 'Ram Browser',
    // Start hidden when VPN is required (primary only); show once WARP
    // reports Connected. Secondary windows open from an already-running app.
    show: !(isPrimary && requireWarp),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox omitted — sandbox:true on BrowserWindow prevents JS execution
      // inside child webviews in Electron 41 on macOS (blank white page).
      // Webviews themselves are sandboxed via will-attach-webview handler.
      webSecurity: true
    }
  });

  const winState = {
    win,
    profile: profile ? { uuid: profile.uuid, name: profile.name, color: profile.color } : null,
    partitions: winPartitions,
    tabViews: new Map()
  };
  windows.set(win.id, winState);
  if (isPrimary) mainWindow = win;

  // If VPN is required, show the primary window only once WARP reports
  // Connected. Fallback: show after 10 seconds (prevents indefinite blank screen).
  if (isPrimary && requireWarp) {
    const showTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 10_000);

    const onWarpStatus = (status) => {
      if (status?.connected && !win.isDestroyed() && !win.isVisible()) {
        clearTimeout(showTimer);
        win.show();
        warpSupervisor.removeListener('status', onWarpStatus);
      }
    };
    warpSupervisor.on('status', onWarpStatus);
    // Also check immediately if already connected (dev mode with proxy configured)
    if (proxyUrl) {
      clearTimeout(showTimer);
      win.show();
    }
  }

  // Screenshot protection. screenshotSecurity is a single-window module
  // (module-level _window) — attach only the primary; secondary windows get
  // the same content-protection guarantee directly.
  if (isPrimary) {
    screenshotSecurity.attach(win, {
      contentProtection: true,
      lockOnSleep: true,
      onLock: () => {
        // Suspend vault permissions on lock regardless of profile type
        setVaultMode('locked');
        // Only PIN-protected profiles get the PIN lock screen: a PIN-less
        // profile has no credential to unlock with — locking it soft-locks
        // the app and 5 failed PIN attempts trigger a panic wipe.
        if (!activeProfileHasPin) return;
        isScreenLocked = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('security:lock', { reason: 'sleep' });
        }
      }
    });
  } else {
    try { win.setContentProtection(true); } catch {}
  }

  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const partition = params.partition || winState.partitions.get('default');
    if (![...winState.partitions.values()].includes(partition)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    // sandbox: true is intentionally omitted — without macOS App Sandbox entitlements
    // (required for signed/packaged builds) the OS kills sandboxed renderer processes,
    // resulting in a blank white webview. contextIsolation + nodeIntegration=false
    // still prevent web content from accessing Node.js / Electron APIs.
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Right-click context menu for the UI chrome (URL bar, settings inputs, etc.)
  win.webContents.on('context-menu', (_e, params) => {
    const { isEditable, selectionText, editFlags } = params;
    if (!isEditable && !selectionText) return;
    const items = [];
    if (isEditable) {
      if (editFlags.canCut)       items.push({ label: 'Cut',        role: 'cut',       accelerator: 'CmdOrCtrl+X' });
      if (editFlags.canCopy || selectionText) items.push({ label: 'Copy', role: 'copy', accelerator: 'CmdOrCtrl+C' });
      if (editFlags.canPaste)     items.push({ label: 'Paste',      role: 'paste',     accelerator: 'CmdOrCtrl+V' });
      items.push({ type: 'separator' });
      if (editFlags.canSelectAll) items.push({ label: 'Select All', role: 'selectAll', accelerator: 'CmdOrCtrl+A' });
    } else if (selectionText) {
      items.push({ label: 'Copy', role: 'copy', accelerator: 'CmdOrCtrl+C' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Replay profile:active once the renderer is ready. For global windows the
  // startup activation may predate the window; for profile windows this is
  // how the renderer learns which (fixed) profile it hosts.
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    if (winState.profile) {
      win.webContents.send('profile:active', { ...winState.profile });
    } else if (activeProfileUuid) {
      win.webContents.send('profile:active', {
        uuid: activeProfileUuid,
        name: activeProfileName,
        color: activeProfileColor
      });
    }
  });

  // Let the renderer collapse the traffic-light gutter in native fullscreen
  // (the system buttons auto-hide there).
  win.on('enter-full-screen', () => { if (!win.isDestroyed()) win.webContents.send('window:fullscreen', true); });
  win.on('leave-full-screen', () => { if (!win.isDestroyed()) win.webContents.send('window:fullscreen', false); });

  // Cleanup on close: destroy this window's tab views, revoke their vault
  // grants, and (for profile windows) clear the namespaced session storage.
  win.on('closed', () => {
    for (const [tabId, view] of winState.tabViews) {
      try { view.webContents.removeAllListeners(); } catch {}
      try { view.webContents.close(); } catch {}
      revokeVaultGrant(`${win.id}:${tabId}`);
    }
    winState.tabViews.clear();
    windows.delete(win.id);
    if (winState.profile) {
      const parts = [...winState.partitions.values()];
      Promise.allSettled(parts.map(async (partition) => {
        const s = session.fromPartition(partition);
        await s.clearStorageData();
        await s.clearCache();
        await s.clearAuthCache();
      })).finally(() => {
        for (const partition of parts) extraPartitions.delete(partition);
      });
    }
    if (win === mainWindow) mainWindow = null;
  });

  win.loadFile(path.join(__dirname, '../../phantom-browser-ui.html'));
  return win;
}

function createMainWindow() {
  return createBrowserWindow(null);
}

// Open an isolated window for a profile. Guard: PIN-protected and hidden
// profiles are excluded — a menu click must never bypass PIN/phrase unlock.
async function openProfileWindow(uuid) {
  const profile = await profileManager.getProfile(uuid);
  if (!profile || profile.hasPin || profile.hidden) return null;
  return createBrowserWindow(profile);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab views (WebContentsView) — one native view per browser tab
// ─────────────────────────────────────────────────────────────────────────────

// Map a renderer-supplied partition (always a global name like 'ram-work')
// to the owning window's partition set. Clamps unknown values to the window's
// default — an arbitrary partition string would create an unconfigured
// session (no tracker blocking, no permission handlers).
function resolvePartitionFor(ws, partition) {
  if ([...ws.partitions.values()].includes(partition)) return partition;
  const container = typeof partition === 'string' && partition.startsWith('ram-')
    ? partition.slice(4)
    : partition;
  return ws.partitions.get(container) || ws.partitions.get('default');
}

function getOrCreateTabView(ws, tabId, partition) {
  if (ws.tabViews.has(tabId)) return ws.tabViews.get(tabId);

  const resolvedPartition = resolvePartitionFor(ws, partition);
  const sendWin = (ch, payload) => { if (!ws.win.isDestroyed()) ws.win.webContents.send(ch, payload); };
  const view = new WebContentsView({
    webPreferences: {
      partition: resolvedPartition,
      preload: path.join(__dirname, 'tab-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    }
  });

  // Profile label for notification prefixing is fetched synchronously by
  // tab-preload.js (tabs:get-profile-label) — no dom-ready race.

  // Forward navigation events to the owning window's UI renderer
  view.webContents.on('page-title-updated', (_e, title) => {
    sendWin('tabview:title-updated', { tabId, title });
  });

  view.webContents.on('did-navigate', (_e, url) => {
    sendWin('tabview:navigated', {
      tabId, url,
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward()
    });
  });

  view.webContents.on('did-navigate-in-page', (_e, url) => {
    sendWin('tabview:navigated', {
      tabId, url,
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward()
    });
  });

  view.webContents.on('did-start-loading', () => {
    sendWin('tabview:load-change', { tabId, loading: true });
  });

  view.webContents.on('did-stop-loading', () => {
    sendWin('tabview:load-change', {
      tabId,
      loading: false,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward()
    });
  });

  view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3) return; // aborted (user navigated away)

    // HTTPS-only fallback: if OUR http→https upgrade failed at the TLS or
    // connection layer, mark the host HTTP-only and retry over plain http.
    // Never triggers for URLs the user/page explicitly requested as https.
    if (isMainFrame && httpsOnlyEnabled && validatedURL?.startsWith('https://') && isHttpsFallbackError(errorCode)) {
      try {
        const { hostname } = new URL(validatedURL);
        if (upgradedHosts.has(hostname) && !httpsExemptHosts.has(hostname)) {
          httpsExemptHosts.add(hostname);
          view.webContents.loadURL(validatedURL.replace(/^https:\/\//, 'http://')).catch(() => {});
          return;
        }
      } catch {}
    }

    sendWin('tabview:fail-load', { tabId, errorCode, errorDescription, url: validatedURL });
  });

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      sendWin('browser:new-tab-request', sanitiseUrl(url));
    }
    return { action: 'deny' };
  });

  view.webContents.on('found-in-page', (_e, result) => {
    sendWin('tabview:find-result', {
      tabId,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches
    });
  });

  // Right-click context menu for web page content
  view.webContents.on('context-menu', (_e, params) => {
    const { selectionText, isEditable, linkURL, srcURL, mediaType, editFlags, pageURL } = params;
    const items = [];

    // Link
    if (linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => sendWin('browser:new-tab-request', linkURL) },
        { label: 'Copy Link Address',    click: () => clipboard.writeText(linkURL) },
        { type: 'separator' }
      );
    }

    // Image
    if (mediaType === 'image' && srcURL) {
      items.push(
        { label: 'Copy Image Address', click: () => clipboard.writeText(srcURL) },
        { type: 'separator' }
      );
    }

    // Editable field
    if (isEditable) {
      if (editFlags.canCut)   items.push({ label: 'Cut',        role: 'cut',       accelerator: 'CmdOrCtrl+X' });
      if (editFlags.canCopy || selectionText) items.push({ label: 'Copy', role: 'copy', accelerator: 'CmdOrCtrl+C' });
      if (editFlags.canPaste) items.push({ label: 'Paste',      role: 'paste',     accelerator: 'CmdOrCtrl+V' });
      if (editFlags.canSelectAll) items.push({ label: 'Select All', role: 'selectAll', accelerator: 'CmdOrCtrl+A' });
      items.push({ type: 'separator' });
    } else if (selectionText) {
      items.push(
        { label: 'Copy', role: 'copy', accelerator: 'CmdOrCtrl+C' },
        { label: 'Copy as Plain Text', click: () => clipboard.writeText(selectionText) },
        { type: 'separator' }
      );
    }

    // Navigation
    items.push(
      { label: 'Back',    enabled: view.webContents.navigationHistory?.canGoBack()    ?? view.webContents.canGoBack(),    click: () => view.webContents.goBack() },
      { label: 'Forward', enabled: view.webContents.navigationHistory?.canGoForward() ?? view.webContents.canGoForward(), click: () => view.webContents.goForward() },
      { label: 'Reload',  click: () => view.webContents.reload() },
      { type: 'separator' },
      { label: 'Copy Page URL', click: () => clipboard.writeText(pageURL || view.webContents.getURL()) }
    );

    Menu.buildFromTemplate(items).popup({ window: ws.win });
  });

  hardenGuestWebContents(view.webContents, ws.win);
  view.__ramPartition = resolvedPartition; // for container-move detection in tabview:navigate
  ws.tabViews.set(tabId, view);
  return view;
}

// Detach + destroy a tab view owned by a window, revoking its vault grants
function destroyTabView(ws, tabId) {
  const view = ws.tabViews.get(tabId);
  if (!view) return;
  try {
    if (!ws.win.isDestroyed() && ws.win.contentView?.children?.includes(view)) {
      ws.win.contentView.removeChildView(view);
    }
  } catch {}
  view.webContents.removeAllListeners();
  try { view.webContents.close(); } catch {}
  ws.tabViews.delete(tabId);
  revokeVaultGrant(`${ws.win.id}:${tabId}`);
}

// Synchronous label fetch for tab-preload.js (runs before any page script).
// Resolved per window: isolated profile windows report their own profile.
ipcMain.on('tabs:get-profile-label', (e) => {
  const ws = winStateForTabContents(e.sender);
  e.returnValue = ws?.profile?.name ?? (activeProfileName || '');
});

ipcMain.handle('tabview:navigate', (e, { tabId, url, partition }) => {
  const ws = winStateFor(e.sender);
  if (!ws) return;
  // Moving a tab between containers (spec 6.5): a WebContentsView's session
  // partition is fixed at creation, so recreate the view in the new one.
  const existing = ws.tabViews.get(tabId);
  if (existing && partition && existing.__ramPartition !== resolvePartitionFor(ws, partition)) {
    destroyTabView(ws, tabId);
  }
  const view = getOrCreateTabView(ws, tabId, partition);
  view.webContents.loadURL(url).catch(() => {});
});

ipcMain.handle('tabview:show', (e, { tabId, bounds }) => {
  const ws = winStateFor(e.sender);
  if (!ws || ws.win.isDestroyed()) return;
  const view = ws.tabViews.get(tabId);
  if (!view) return;
  const b = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  };
  if (!ws.win.contentView.children.includes(view)) {
    ws.win.contentView.addChildView(view);
  }
  view.setBounds(b);
});

ipcMain.handle('tabview:hide', (e, tabId) => {
  const ws = winStateFor(e.sender);
  if (!ws || ws.win.isDestroyed()) return;
  const view = ws.tabViews.get(tabId);
  if (view && ws.win.contentView.children.includes(view)) {
    ws.win.contentView.removeChildView(view);
  }
});

ipcMain.handle('tabview:close', (e, tabId) => {
  const ws = winStateFor(e.sender);
  if (!ws) return;
  destroyTabView(ws, tabId);
});

ipcMain.handle('tabview:go-back', (e, tabId) => {
  winStateFor(e.sender)?.tabViews.get(tabId)?.webContents.goBack();
});

ipcMain.handle('tabview:go-forward', (e, tabId) => {
  winStateFor(e.sender)?.tabViews.get(tabId)?.webContents.goForward();
});

ipcMain.handle('tabview:reload', (e, tabId) => {
  winStateFor(e.sender)?.tabViews.get(tabId)?.webContents.reload();
});

ipcMain.on('tabview:zoom-in',    (e, tabId) => { const v = winStateFor(e.sender)?.tabViews.get(tabId); if (v) v.webContents.setZoomLevel(v.webContents.getZoomLevel() + 0.5); });
ipcMain.on('tabview:zoom-out',   (e, tabId) => { const v = winStateFor(e.sender)?.tabViews.get(tabId); if (v) v.webContents.setZoomLevel(v.webContents.getZoomLevel() - 0.5); });
ipcMain.on('tabview:zoom-reset', (e, tabId) => { winStateFor(e.sender)?.tabViews.get(tabId)?.webContents.setZoomLevel(0); });

ipcMain.on('tabview:find', (e, { tabId, text, forward }) => {
  const v = winStateFor(e.sender)?.tabViews.get(tabId);
  if (!v) return;
  if (!text) { v.webContents.stopFindInPage('clearSelection'); return; }
  v.webContents.findInPage(text, { forward: forward !== false, findNext: true });
});

ipcMain.on('tabview:find-stop', (e, tabId) => {
  winStateFor(e.sender)?.tabViews.get(tabId)?.webContents.stopFindInPage('clearSelection');
});

// ─────────────────────────────────────────────────────────────────────────────
// App lifecycle
// ─────────────────────────────────────────────────────────────────────────────

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'webview') {
    hardenGuestWebContents(contents);
  }
});


// ── Custom minimal menu bar ───────────────────────────────────────────────────
function buildAppMenu(profiles = []) {
  // Menu actions target the focused window so New Tab / Reload / etc. work in
  // whichever window the user is using; fall back to the primary window.
  const send = (ch) => {
    const w = BrowserWindow.getFocusedWindow() || mainWindow;
    if (w && !w.isDestroyed()) w.webContents.send(ch);
  };
  // Only PIN-less, non-hidden profiles can open from the menu — a menu click
  // must never bypass PIN or unlock-phrase verification.
  const profileWindowItems = profiles
    .filter((p) => !p.hasPin && !p.hidden)
    .map((p) => ({
      label: p.name,
      click: () => { openProfileWindow(p.uuid).catch(() => {}); }
    }));
  const template = [
    {
      label: 'Ram Browser',
      submenu: [
        { label: 'About Ram Browser', role: 'about' },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CommandOrControl+,', click: () => send('menu:settings') },
        { type: 'separator' },
        { label: 'Quit Ram Browser', role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CommandOrControl+T', click: () => send('menu:new-tab') },
        { label: 'New Window', accelerator: 'CommandOrControl+N', click: () => { createBrowserWindow(null).catch(() => {}); } },
        {
          label: 'New Profile Window',
          submenu: profileWindowItems.length
            ? profileWindowItems
            : [{ label: 'No PIN-less profiles', enabled: false }]
        },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CommandOrControl+W', click: () => send('menu:close-tab') }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload',   accelerator: 'CommandOrControl+R',   click: () => send('menu:reload') },
        { label: 'Back',     accelerator: 'CommandOrControl+[',   click: () => send('menu:back') },
        { label: 'Forward',  accelerator: 'CommandOrControl+]',   click: () => send('menu:forward') },
        { type: 'separator' },
        { label: 'Focus URL Bar',  accelerator: 'CommandOrControl+L', click: () => send('menu:focus-url') },
        { label: 'Find in Page',   accelerator: 'CommandOrControl+F', click: () => send('menu:find') },
        { type: 'separator' },
        { label: 'Zoom In',    accelerator: 'CommandOrControl+=', click: () => send('menu:zoom-in') },
        { label: 'Zoom Out',   accelerator: 'CommandOrControl+-', click: () => send('menu:zoom-out') },
        { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: () => send('menu:zoom-reset') },
        { type: 'separator' },
        { label: 'Next Tab',     accelerator: 'Control+Tab',       click: () => send('menu:next-tab') },
        { label: 'Previous Tab', accelerator: 'Control+Shift+Tab', click: () => send('menu:prev-tab') },
        { type: 'separator' },
        { label: 'Toggle Full Screen', role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Privacy',
      submenu: [
        { label: 'Panic — Wipe Everything', accelerator: 'CommandOrControl+Shift+X', click: () => send('menu:panic') },
        { label: 'Lock Now', accelerator: 'CommandOrControl+Shift+L', click: () => send('menu:lock') },
        { label: 'Privacy Controls', accelerator: 'CommandOrControl+Shift+P', click: () => send('menu:privacy') },
        { label: 'Screenshot Tool', accelerator: 'CommandOrControl+Shift+S', click: () => send('menu:screenshot') }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Rebuild the menu with the current profile list (call after any profile
// create/update/delete so the New Profile Window submenu stays current)
async function refreshAppMenu() {
  try {
    buildAppMenu(await profileManager.listProfiles());
  } catch {
    buildAppMenu();
  }
}

app.whenReady().then(async () => {
  // 0a. Set custom minimal menu bar (rebuilt with profiles after init below)
  buildAppMenu();

  // 0. Register phantom:// protocol handler
  //    phantom://dashboard → built-in privacy dashboard (same as new tab page)
  protocol.handle('phantom', (request) => {
    const url = new URL(request.url);
    // phantom://dashboard → serve the UI HTML
    if (url.hostname === 'dashboard' || url.hostname === 'newtab') {
      const uiPath = path.join(__dirname, '../../phantom-browser-ui.html');
      return net.fetch(`file://${uiPath}`);
    }
    // phantom://blank → empty page
    if (url.hostname === 'blank') {
      return new Response('<html><body style="background:#000;"></body></html>', {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    return new Response('Not found', { status: 404 });
  });

  // 1. Configure managed sessions
  await configureManagedSessions();

  // 2. Init profile manager (creates default profile if needed)
  await profileManager.init(app.getPath('userData'));

  // Rebuild the menu now that profiles exist (New Profile Window submenu)
  await refreshAppMenu();

  // 3. Activate default profile
  const activeProfile = await profileManager.getActiveProfile();
  if (activeProfile) {
    // Resolve key for PIN-less profiles (OS keychain first, base64 fallback)
    const key = await profileManager.resolveKey(activeProfile);
    await activateProfile(activeProfile, key);
  }

  // 4. Create window
  createMainWindow();

  // Register global keyboard shortcut for panic (Cmd+Shift+X on macOS, Ctrl+Shift+X on Win/Linux).
  // Single panic path: performPanic() wipes in main (works even if the
  // renderer is hung), then the renderer is told to reset its UI. The menu
  // item's accelerator shows the same keys; when the app is focused this
  // global shortcut intercepts them — both converge on performPanic().
  globalShortcut.register('CommandOrControl+Shift+X', async () => {
    try { await performPanic(); } catch {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('privacy:panic-triggered');
    }
  });

  // 5. Start wipe countdown ticker — attach listeners BEFORE startTick() to avoid missing first event
  wipeEngine.on('tick', (countdowns) => {
    const uuid = activeProfileUuid;
    const seconds = uuid ? countdowns[uuid] : null;
    sendGlobalProfileWindows('wipe:countdown', {
      seconds,
      formatted: seconds != null ? formatCountdown(seconds) : '--:--:--'
    });
  });

  wipeEngine.startTick();

  wipeEngine.on('wiped', async ({ profileUuid }) => {
    // Spec 6.2: the tab snapshot survives the wipe cycle so tabs restore
    // afterwards. Only panic / clear-all-data / ghost mode destroy it.
    notificationQueue.length = 0;
    resetPrivacyReport();

    // Revoke push subscriptions — clear service workers in all sessions
    await Promise.allSettled(managedSessions().map((s) =>
      s.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
    ));

    sendGlobalProfileWindows('wipe:done', { profileUuid });
  });

  // 6. DNS leak verification — probe a well-known canary endpoint
  //     If RAM_REQUIRE_VPN=1 we only proceed if WARP is connected.
  //     The probe result is sent to the renderer for display.
  probeNetwork('https://1.1.1.1/cdn-cgi/trace').then((result) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dns:probe-result', {
        ok: result.ok,
        // If probe succeeds with requireWarp=true and no proxy, that means
        // traffic escaped the VPN — report as a potential leak.
        possibleLeak: result.ok && requireWarp && !proxyUrl
      });
    }
  }).catch(() => {});

  // 7. WARP supervisor (graceful if warp-cli not installed)
  warpSupervisor.start().catch(() => {});
  warpSupervisor.on('status', (status) => {
    broadcast('warp:status', { ...warpStatus(), supervisor: status });
  });
  warpSupervisor.on('kill-switch', (active) => {
    broadcast('warp:kill-switch', { active });
    // Lock the screen when kill switch fires — VPN is dead, block access.
    // PIN-less profiles are exempt (no credential to unlock with — the
    // lock would be permanent and failed attempts trigger panic wipe);
    // network is still blocked by requireWarp in onBeforeRequest.
    // Lock UI only exists in the primary window (profile windows host
    // PIN-less profiles by construction).
    if (active && !isScreenLocked && activeProfileHasPin && mainWindow && !mainWindow.isDestroyed()) {
      isScreenLocked = true;
      mainWindow.webContents.send('security:lock', { reason: 'kill-switch' });
    }
  });

  // Periodic WARP status push (fallback when supervisor is silent) — 30s is enough
  warpStatusIntervalId = setInterval(() => {
    broadcast('warp:status', { ...warpStatus(), supervisor: warpSupervisor.getStatus() });
  }, 30_000);
  if (warpStatusIntervalId.unref) warpStatusIntervalId.unref();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch((err) => {
  console.error('[startup]', err);
});

app.on('window-all-closed', () => {
  if (warpStatusIntervalId) { clearInterval(warpStatusIntervalId); warpStatusIntervalId = null; }
  wipeEngine.stopTick();
  warpSupervisor.stop();
  if (process.platform !== 'darwin') app.quit();
});

// Wipe on quit (feature #34)
app.on('before-quit', async (e) => {
  if (!wipeOnQuit || !activeProfileUuid) return;
  e.preventDefault();
  try {
    const partitions = CONTAINERS.map((c) => `ram-${c}`);
    await wipeEngine.wipeNow(activeProfileUuid, partitions);
    await clearManagedStorage();
    tabSnapshotManager?.clear().catch(() => {});
  } catch {}
  app.exit(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// IPC handlers
// ─────────────────────────────────────────────────────────────────────────────

// Vault
const VAULT_TIMED_MS = 5 * 60 * 1000; // 5-minute timed grant

function setVaultMode(mode, durationMs = VAULT_TIMED_MS) {
  if (!['locked', 'session', 'timed'].includes(mode)) throw new Error(`Bad vault mode: ${mode}`);
  // Clear any existing timed timer
  if (vaultTimedTimer) { clearTimeout(vaultTimedTimer); vaultTimedTimer = null; }
  vaultMode = mode;
  vaultTimedExpiry = null;
  // Revoke all per-origin session grants when vault is locked
  if (mode === 'locked') vaultGrantedOrigins.clear();

  if (mode === 'timed') {
    vaultTimedExpiry = Date.now() + durationMs;
    vaultTimedTimer = setTimeout(() => {
      vaultMode = 'locked';
      vaultTimedExpiry = null;
      vaultTimedTimer = null;
      broadcast('vault:mode-changed', { mode: 'locked', timedExpired: true });
    }, durationMs);
    if (vaultTimedTimer.unref) vaultTimedTimer.unref();
  }

  broadcast('vault:mode-changed', {
    mode: vaultMode,
    expiresAt: vaultTimedExpiry
  });
  return { mode: vaultMode, expiresAt: vaultTimedExpiry };
}

ipcMain.handle('vault:set-mode', (_e, mode, durationMs) => setVaultMode(mode, durationMs));
ipcMain.handle('vault:get-mode', () => ({
  mode: vaultMode,
  expiresAt: vaultTimedExpiry,
  secondsLeft: vaultTimedExpiry ? Math.max(0, Math.ceil((vaultTimedExpiry - Date.now()) / 1000)) : null
}));

// WARP / network
ipcMain.handle('warp:get-status', () => warpStatus());
ipcMain.handle('network:probe', (_e, url) => probeNetwork(url));

ipcMain.handle('vpn:get-proxy', () => ({ url: proxyUrl }));

// Tor routing: routes all sessions through Tor's default SOCKS5 port (9050)
// or the Tor Browser's SOCKS port (9150). User must have Tor running locally.
const TOR_PROXY = 'socks5://127.0.0.1:9050';
const TOR_BROWSER_PROXY = 'socks5://127.0.0.1:9150';

ipcMain.handle('tor:enable', async () => {
  // Try Tor Browser port first (9150), fall back to system Tor (9050)
  const torUrl = TOR_BROWSER_PROXY;
  const proxyConfig = { proxyRules: torUrl, proxyBypassRules: '<local>' };
  await Promise.all([
    session.defaultSession.setProxy(proxyConfig),
    ...managedSessions().map((s) => s.setProxy(proxyConfig))
  ]).catch(() => {});
  proxyUrl = torUrl;
  broadcast('warp:status', warpStatus());
  return { ok: true };
});

ipcMain.handle('tor:disable', async () => {
  const direct = { proxyRules: 'direct://' };
  await Promise.all([
    session.defaultSession.setProxy(direct),
    ...managedSessions().map((s) => s.setProxy(direct))
  ]).catch(() => {});
  proxyUrl = process.env.RAM_PROXY_URL || process.env.PHANTOM_PROXY_URL || '';
  broadcast('warp:status', warpStatus());
  return { ok: true };
});

ipcMain.handle('vpn:set-proxy', async (_e, url) => {
  if (!url) return { ok: false, error: 'URL is empty' };
  try {
    const parsed = new URL(url);
    const allowed = ['socks5:', 'socks4:', 'http:', 'https:'];
    if (!allowed.includes(parsed.protocol)) {
      return { ok: false, error: `Protocol must be one of: socks5, socks4, http, https` };
    }
  } catch {
    return { ok: false, error: 'Invalid proxy URL' };
  }
  const proxyConfig = { proxyRules: url, proxyBypassRules: '<local>' };
  await Promise.all([
    session.defaultSession.setProxy(proxyConfig),
    ...managedSessions().map((s) => s.setProxy(proxyConfig))
  ]).catch(() => {});
  proxyUrl = url;
  broadcast('warp:status', warpStatus());
  return { ok: true };
});

ipcMain.handle('vpn:disconnect', async () => {
  const direct = { proxyRules: 'direct://' };
  await Promise.all([
    session.defaultSession.setProxy(direct),
    ...managedSessions().map((s) => s.setProxy(direct))
  ]).catch(() => {});
  proxyUrl = '';
  broadcast('warp:status', warpStatus());
  return { ok: true };
});

ipcMain.handle('vpn:test', () => {
  if (!proxyUrl) return { ok: false, error: 'No proxy configured' };
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timer = setTimeout(() => done({ ok: false, error: 'Timed out', latencyMs: Date.now() - start }), 8000);
    const req = net.request({ method: 'GET', url: 'https://1.1.1.1/cdn-cgi/trace' });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        const text = Buffer.concat(chunks).toString();
        const get = (key) => text.match(new RegExp(`${key}=([^\\n]+)`))?.[1]?.trim() || null;
        done({ ok: res.statusCode < 400, latencyMs, ip: get('ip'), loc: get('loc'), colo: get('colo') });
      });
    });
    req.on('error', (err) => { clearTimeout(timer); done({ ok: false, error: err.message, latencyMs: Date.now() - start }); });
    req.end();
  });
});

// Privacy / panic
ipcMain.handle('privacy:clear-all-data', async () => {
  clipboard.clear();
  await clearManagedStorage();
  tabSnapshotManager?.clear().catch(() => {});
  return { ok: true };
});

// Shared panic implementation — the ONLY wipe-everything path
// (global shortcut, menu, and privacy:panic IPC all converge here).
async function performPanic() {
  clipboard.clear();
  setVaultMode('locked');   // force vault to locked on panic
  isScreenLocked = false;   // panic resets lock state (UI wiped)
  notificationQueue.length = 0; // drop queued notifications
  await clearManagedStorage();
  // Revoke push subscriptions — clear service workers in all sessions
  await Promise.allSettled(managedSessions().map((s) => s.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })));
  tabSnapshotManager?.clear().catch(() => {});
  // Destroy all active WebContentsViews in every window
  for (const ws of windows.values()) {
    for (const view of ws.tabViews.values()) {
      try { view.webContents.stop(); } catch {}
      try { if (!ws.win.isDestroyed()) ws.win.contentView?.removeChildView(view); } catch {}
    }
    ws.tabViews.clear();
  }
  // Close isolated profile windows — panic leaves nothing on screen
  closeProfileWindows();
}

ipcMain.handle('privacy:panic', async () => {
  await performPanic();
  return { ok: true };
});

// Wipe
ipcMain.handle('wipe:get-countdown', () => {
  const seconds = activeProfileUuid ? wipeEngine.secondsRemaining(activeProfileUuid) : null;
  return { seconds, formatted: seconds != null ? formatCountdown(seconds) : '--:--:--' };
});

ipcMain.handle('wipe:trigger-now', async () => {
  if (!activeProfileUuid) return { ok: false };
  const partitions = CONTAINERS.map((c) => `ram-${c}`);
  await wipeEngine.wipeNow(activeProfileUuid, partitions);
  // Snapshot intentionally preserved — same wipe cycle as the scheduled
  // wipe (spec 6.2: tabs restore after wipe)
  return { ok: true };
});

// Per-container wipe — wipes the SENDER window's container partition
// (an isolated profile window wipes its own namespaced session)
ipcMain.handle('wipe:container', async (e, { container }) => {
  if (!CONTAINERS.includes(container)) return { ok: false, reason: 'unknown_container' };
  const ws = winStateFor(e.sender);
  const partition = ws?.partitions.get(container) || `ram-${container}`;
  try {
    const s = session.fromPartition(partition);
    const storageTypes = ['cookies','filesystem','indexdb','localstorage','shadercache','websql','serviceworkers','cachestorage'];
    await s.clearStorageData({ storages: storageTypes });
    await s.clearCache();
    await s.clearAuthCache();
    await s.clearHostResolverCache();
    vaultGrantedOrigins.clear(); // clear all grants — safest after a container wipe
    return { ok: true, container };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// Configurable wipe interval (1h–7d)
const MIN_WIPE_MS = 60 * 60 * 1000;        // 1 hour
const MAX_WIPE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
let wipeIntervalMs = 24 * 60 * 60 * 1000;  // default 24h

ipcMain.handle('wipe:get-interval', () => ({
  ms: wipeIntervalMs,
  hours: wipeIntervalMs / (60 * 60 * 1000)
}));

ipcMain.handle('wipe:set-interval', async (_e, { hours }) => {
  const clampedH = Math.min(7 * 24, Math.max(1, Number(hours) || 24));
  wipeIntervalMs = clampedH * 60 * 60 * 1000;
  // Reschedule the active profile timer with new interval
  if (activeProfileUuid) {
    const partitions = CONTAINERS.map((c) => `ram-${c}`);
    wipeEngine.schedule(activeProfileUuid, partitions, wipeIntervalMs);
    // Persist per-profile so the interval survives switches and restarts
    if (activeProfileKey) {
      try {
        const prefs = await profileManager.readPrefs(activeProfileUuid, activeProfileKey);
        prefs.wipeIntervalMs = wipeIntervalMs;
        await profileManager.writePrefs(activeProfileUuid, prefs, activeProfileKey);
      } catch {}
    }
  }
  return { ok: true, hours: clampedH };
});

ipcMain.on('app:notify', (_e, { title, body }) => {
  sendNotification(title, body);
});

// Profiles
ipcMain.handle('profiles:list', async () => {
  const profiles = await profileManager.listProfiles();
  return profiles.map(({ uuid, name, color, hidden, hasPin, hasDecoy, createdAt }) => ({
    uuid, name, color, hidden, hasPin, hasDecoy, createdAt
  }));
});

ipcMain.handle('profiles:create', async (_e, opts) => {
  const profile = await profileManager.createProfile(opts);
  refreshAppMenu().catch(() => {});
  return { uuid: profile.uuid, name: profile.name, color: profile.color };
});

ipcMain.handle('profiles:switch', async (_e, { uuid, pin }) => {
  if (profileSwitchInProgress) return { result: 'busy', error: 'Profile switch already in progress' };
  profileSwitchInProgress = true;
  try {
  const result = await profileManager.switchProfile(uuid, pin);
  if (result.result === 'ok') {
    activeProfileIsDecoy = false;
    await activateProfile(result.profile, result.key);
  } else if (result.result === 'decoy') {
    // Ghost mode cascade: wipe real sessions
    activeProfileIsDecoy = true;
    try {
      setVaultMode('locked');
      // Duress: no real-profile data may remain visible in another window
      closeProfileWindows();
      await clearManagedStorage();
      tabSnapshotManager?.clear().catch(() => {});
      clipboard.clear();
      // Drop queued real-profile notifications — nothing may replay in or
      // after ghost mode (spec 6.14)
      notificationQueue.length = 0;
    } catch {}
    await activateProfile(result.profile, result.key);
    // Notify renderer to activate ghost mode UI
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('profile:ghost-mode', { active: true });
    }
  }
  return {
    result: result.result,
    profile: result.profile ? {
      uuid: result.profile.uuid,
      name: result.profile.name,
      color: result.profile.color
    } : null
  };
  } finally {
    profileSwitchInProgress = false;
  }
});

ipcMain.handle('profiles:active', async (e) => {
  // Isolated profile windows report their own fixed profile, not the global one
  const ws = winStateFor(e.sender);
  if (ws?.profile) return { ...ws.profile };
  const profile = await profileManager.getActiveProfile();
  if (!profile) return null;
  return { uuid: profile.uuid, name: profile.name, color: profile.color };
});

ipcMain.handle('profiles:update', async (_e, { uuid, updates }) => {
  await profileManager.updateProfile(uuid, updates);
  refreshAppMenu().catch(() => {});
  return { ok: true };
});

// Resolve a profile's prefs key. PIN-derived keys can't be re-derived without
// the PIN, so for the active (unlocked) profile use the cached session key.
async function keyForProfile(profile) {
  if (profile.uuid === activeProfileUuid && activeProfileKey) return activeProfileKey;
  return profileManager.resolveKey(profile);
}

ipcMain.handle('profiles:get-prefs', async (_e, { uuid }) => {
  const profile = await profileManager.getProfile(uuid);
  if (!profile) return null;
  const key = await keyForProfile(profile);
  if (!key) return null;
  return profileManager.readPrefs(uuid, key);
});

ipcMain.handle('profiles:set-homepage', async (_e, { uuid, url }) => {
  const profile = await profileManager.getProfile(uuid);
  if (!profile) return { ok: false };
  const key = await keyForProfile(profile);
  if (!key) return { ok: false };
  const prefs = await profileManager.readPrefs(uuid, key);
  prefs.homepageUrl = url || null;
  await profileManager.writePrefs(uuid, prefs, key);
  return { ok: true };
});

ipcMain.handle('profiles:get-homepage', async (_e, { uuid }) => {
  const profile = await profileManager.getProfile(uuid);
  if (!profile) return { url: null };
  const key = await keyForProfile(profile);
  if (!key) return { url: null };
  const prefs = await profileManager.readPrefs(uuid, key);
  return { url: prefs.homepageUrl || null };
});

ipcMain.handle('profiles:set-unlock-phrase', async (_e, { uuid, phrase }) => {
  await profileManager.setUnlockPhrase(uuid, phrase);
  return { ok: true };
});

ipcMain.handle('profiles:unlock-hidden', async (_e, { phrase }) => {
  const result = await profileManager.unlockHiddenProfile(phrase);
  if (!result) return { found: false };
  activeProfileIsDecoy = false;
  await activateProfile(result.profile, result.key);
  return {
    found: true,
    profile: {
      uuid: result.profile.uuid,
      name: result.profile.name,
      color: result.profile.color
    }
  };
});

ipcMain.handle('profiles:delete', async (_e, uuid) => {
  await profileManager.deleteProfile(uuid);
  refreshAppMenu().catch(() => {});
  // Close any open isolated window for the deleted profile
  for (const ws of [...windows.values()]) {
    if (ws.profile?.uuid === uuid) { try { ws.win.close(); } catch {} }
  }
  return { ok: true };
});

// PIN
ipcMain.handle('pin:verify', async (_e, { uuid, pin }) => {
  const dir = profileManager.profileDir(uuid);
  return verifyPin(dir, pin);
});

ipcMain.handle('pin:set', async (_e, { uuid, pin }) => {
  const dir = profileManager.profileDir(uuid);
  const profile = await profileManager.getProfile(uuid);
  if (!profile) return { ok: false, error: 'Profile not found' };

  // Read prefs under the CURRENT key before it is destroyed — otherwise the
  // next unlock derives a PIN key that can't decrypt them and healPrefs
  // silently resets homepage/wipe-interval to defaults.
  let prefs = null;
  const oldKey = (uuid === activeProfileUuid && activeProfileKey)
    ? activeProfileKey
    : await profileManager.resolveKey(profile);
  if (oldKey) {
    try { prefs = await profileManager.readPrefs(uuid, oldKey); } catch {}
  }

  await setPin(dir, pin);

  // Re-encrypt prefs under the PIN-derived key and destroy the stored key
  // material — leaving keySafe/keyBase64 in the index would let anyone
  // recover the profile key without the PIN (defeats PIN-at-rest protection).
  const newKey = await deriveProfileKey(dir, pin);
  if (prefs && Object.keys(prefs).length) {
    await profileManager.writePrefs(uuid, prefs, newKey);
  }
  await profileManager.updateProfile(uuid, { hasPin: true, keySafe: null, keyBase64: null });

  // Keep the live session working with the new key
  if (uuid === activeProfileUuid) {
    activeProfileKey = newKey;
    activeProfileHasPin = true;
    tabSnapshotManager = createSnapshotManager(dir, newKey);
  }

  // Profile gained a PIN — it must leave the New Profile Window submenu,
  // and any open isolated window for it must close (PIN-less-only invariant).
  refreshAppMenu().catch(() => {});
  for (const ws of [...windows.values()]) {
    if (ws.profile?.uuid === uuid) { try { ws.win.close(); } catch {} }
  }
  return { ok: true };
});

ipcMain.handle('pin:set-decoy', async (_e, { uuid, pin }) => {
  const dir = profileManager.profileDir(uuid);
  await setDecoyPin(dir, pin);
  await profileManager.updateProfile(uuid, { hasDecoy: true });
  return { ok: true };
});

// Settings → main-process flags
ipcMain.on('settings:wipe-on-quit',    (_e, enabled) => { wipeOnQuit = Boolean(enabled); });
ipcMain.on('settings:require-vpn',     (_e, enabled) => { requireWarp = Boolean(enabled); });
ipcMain.on('settings:link-sanitiser',  (_e, enabled) => { linkSanitiserEnabled = Boolean(enabled); });
ipcMain.on('settings:redirect-block',  (_e, enabled) => { redirectBlockEnabled = Boolean(enabled); });
ipcMain.on('settings:https-only',      (_e, enabled) => { httpsOnlyEnabled = Boolean(enabled); });
ipcMain.on('settings:tracker-block',   (_e, enabled) => { trackerBlockEnabled = Boolean(enabled); });

// Screen unlock — called by renderer after successful PIN entry on lock screen
ipcMain.on('security:screen-unlocked', () => {
  isScreenLocked = false;
  // Flush any notifications that were queued while locked
  flushNotificationQueue();
});

// Tab snapshot — primary window only. Secondary windows (same-profile "New
// Window" or isolated profile windows) must neither clobber nor restore the
// primary window's snapshot.
ipcMain.on('tabs:snapshot', (e, { tabs, activeIndex }) => {
  if (BrowserWindow.fromWebContents(e.sender) !== mainWindow) return;
  tabSnapshotManager?.write(tabs, activeIndex);
});

ipcMain.handle('tabs:restore', async (e) => {
  if (BrowserWindow.fromWebContents(e.sender) !== mainWindow) return null;
  if (!tabSnapshotManager) return null;
  return tabSnapshotManager.read();
});


// Screenshot protection toggle
ipcMain.handle('security:set-content-protection', (_e, enabled) => {
  screenshotSecurity.applyContentProtection(enabled);
  return { ok: true, enabled };
});

// Safe screenshot capture
ipcMain.handle('screenshot:capture', async () => {
  const dataUrl = await screenshotSecurity.captureWindowFrame();
  return { dataUrl };
});

ipcMain.handle('screenshot:save', async (_e, { dataUrl, filePath }) => {
  try {
    // Strip EXIF and metadata before saving
    const cleanDataUrl = stripDataUrlMetadata(dataUrl);
    const base64 = cleanDataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    const { dialog } = require('electron');
    const target = filePath || (await dialog.showSaveDialog({
      defaultPath: `ram-screenshot-${Date.now()}.png`,
      filters: [{ name: 'PNG Image', extensions: ['png'] }]
    })).filePath;
    if (!target) return { ok: false, reason: 'cancelled' };
    await require('node:fs/promises').writeFile(target, buf);
    return { ok: true, filePath: target };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// Privacy report
ipcMain.handle('privacy:get-report', () => getPrivacyReport());
ipcMain.handle('privacy:reset-report', () => { resetPrivacyReport(); return { ok: true }; });

