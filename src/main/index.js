'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, net, session, shell, globalShortcut, clipboard, protocol, Notification, Menu, dialog } = require('electron');
const path = require('node:path');

// ── shared ────────────────────────────────────────────────────────────────────
const { sanitiseUrl, isLocalAddress } = require('../shared/link-sanitiser');

// ── profiles ──────────────────────────────────────────────────────────────────
const profileManager = require('./profiles/manager');
const { verifyPin, setPin, setDecoyPin } = require('./profiles/pin');
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
let vaultMode = 'session';
let vaultTimedExpiry = null;   // epoch ms for timed mode expiry
let vaultTimedTimer = null;    // NodeJS.Timeout for timed auto-revoke
let activeProfileUuid = null;
let activeProfileIsDecoy = false;
let activeProfileIsHidden = false;
let activeProfileName = '';
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
  return [...PARTITIONS.values()].map((partition) => session.fromPartition(partition));
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

function isFinanceSession(targetSession) {
  // Detect the finance partition by checking the session partition name
  try {
    return targetSession.storagePath?.includes('ram-finance') ||
           String(targetSession.getStoragePath?.() || '').includes('ram-finance');
  } catch {
    return false;
  }
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
    const baseDomain = (h) => h.split('.').slice(-2).join('.');
    return baseDomain(reqHost) !== baseDomain(refHost);
  } catch {
    return false;
  }
}

async function configureSession(targetSession) {
  if (targetSession.__ramConfigured) return;
  targetSession.__ramConfigured = true;

  const isFinance = String(targetSession.storagePath || '').toLowerCase().includes('ram-finance');

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
        // Record the grant for per-origin tracking
        try {
          const origin = details?.requestingUrl || _wc.getURL();
          const tabId = [...tabViews.entries()].find(([, v]) => v.webContents === _wc)?.[0];
          if (tabId) recordVaultGrant(tabId, origin);
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

  // Note: setPermissionCheckHandler is intentionally omitted.
  // setPermissionRequestHandler above handles all explicit permission requests.
  // Overly restrictive permission checks in Electron 41 can interfere with
  // normal webview navigation and resource loading.

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

      // HTTPS-only: upgrade plain http:// → https:// for network requests
      if (httpsOnlyEnabled && details.url.startsWith('http://') && isNetworkRequest(details.url)) {
        const upgraded = details.url.replace(/^http:\/\//, 'https://');
        callback({ redirectURL: upgraded });
        return;
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
    dialog.showSaveDialog(mainWindow, { defaultPath, title: 'Save file' }).then(({ canceled, filePath }) => {
      if (canceled || !filePath) { item.cancel(); return; }
      item.setSavePath(filePath);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download:start', { filename, total: item.getTotalBytes() });
      }
      item.on('updated', (_ev, state) => {
        if (state === 'progressing' && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download:progress', {
            filename, received: item.getReceivedBytes(), total: item.getTotalBytes()
          });
        }
      });
      item.once('done', (_ev, state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download:done', { filename, state });
        }
      });
    });
  });
}

async function configureManagedSessions() {
  await Promise.all(managedSessions().map(configureSession));
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
  activeProfileName = profile.name || 'Anonymous';
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

  // Wipe engine: schedule for this profile's containers
  const partitions = CONTAINERS.map((c) => `ram-${c}`);
  wipeEngine.schedule(profile.uuid, partitions);

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('profile:active', {
      uuid: profile.uuid,
      name: profile.name,
      color: profile.color
    });
  }

  // Flush queued notifications on profile switch (if not locked)
  if (!isScreenLocked && notificationQueue.length) {
    flushNotificationQueue();
  }
}

function flushNotificationQueue() {
  if (!Notification.isSupported()) { notificationQueue.length = 0; return; }
  while (notificationQueue.length) {
    const { title, body } = notificationQueue.shift();
    try { new Notification({ title, body }).show(); } catch {}
  }
}

function sendNotification(title, body) {
  if (isScreenLocked || activeProfileIsDecoy) {
    notificationQueue.push({ title, body });
  } else if (Notification.isSupported()) {
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

function hardenGuestWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (mainWindow && /^https?:\/\//i.test(url)) {
      mainWindow.webContents.send('browser:new-tab-request', sanitiseUrl(url));
    }
    return { action: 'deny' };
  });

  // URL sanitisation (tracking param removal, redirect unwrapping) is handled
  // at the network level by onBeforeRequest, so no will-navigate redirect is needed.
}

// ─────────────────────────────────────────────────────────────────────────────
// Window creation
// ─────────────────────────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 620,
    frame: false,
    backgroundColor: '#0f0f11',
    title: 'Ram Browser',
    // Start hidden when VPN is required; show once WARP reports Connected.
    // In dev mode (no requireWarp), show immediately.
    show: !requireWarp,
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

  // If VPN is required, show window only once WARP supervisor reports Connected.
  // Fallback: show after 10 seconds regardless (prevents indefinite blank screen).
  if (requireWarp) {
    const showTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show();
      }
    }, 10_000);

    const onWarpStatus = (status) => {
      if (status?.connected && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        clearTimeout(showTimer);
        mainWindow.show();
        warpSupervisor.removeListener('status', onWarpStatus);
      }
    };
    warpSupervisor.on('status', onWarpStatus);
    // Also check immediately if already connected (dev mode with proxy configured)
    if (proxyUrl) {
      clearTimeout(showTimer);
      mainWindow.show();
    }
  }

  // Screenshot protection
  screenshotSecurity.attach(mainWindow, {
    contentProtection: true,
    lockOnSleep: true,
    onLock: () => {
      isScreenLocked = true;
      // Suspend vault permissions on lock
      setVaultMode('locked');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('security:lock', { reason: 'sleep' });
      }
    }
  });

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const partition = params.partition || PARTITIONS.get('default');
    if (![...PARTITIONS.values()].includes(partition)) {
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Right-click context menu for the UI chrome (URL bar, settings inputs, etc.)
  mainWindow.webContents.on('context-menu', (_e, params) => {
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
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

  mainWindow.loadFile(path.join(__dirname, '../../phantom-browser-ui.html'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab views (WebContentsView) — one native view per browser tab
// ─────────────────────────────────────────────────────────────────────────────

const tabViews = new Map(); // tabId → WebContentsView

function getOrCreateTabView(tabId, partition) {
  if (tabViews.has(tabId)) return tabViews.get(tabId);

  const view = new WebContentsView({
    webPreferences: {
      partition: partition || 'ram-default',
      preload: path.join(__dirname, 'tab-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    }
  });

  // Inject active profile label for notification prefixing (before page load)
  view.webContents.on('dom-ready', () => {
    const label = activeProfileName || '';
    if (label) {
      view.webContents.executeJavaScript(
        `window.__RAM_PROFILE_LABEL__ = ${JSON.stringify(label)};`
      ).catch(() => {});
    }
  });

  // Forward navigation events to the UI renderer
  view.webContents.on('page-title-updated', (_e, title) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tabview:title-updated', { tabId, title });
    }
  });

  view.webContents.on('did-navigate', (_e, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tabview:navigated', {
        tabId, url,
        canGoBack: view.webContents.canGoBack(),
        canGoForward: view.webContents.canGoForward()
      });
    }
  });

  view.webContents.on('did-navigate-in-page', (_e, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tabview:navigated', {
        tabId, url,
        canGoBack: view.webContents.canGoBack(),
        canGoForward: view.webContents.canGoForward()
      });
    }
  });

  view.webContents.on('did-start-loading', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tabview:load-change', { tabId, loading: true });
    }
  });

  view.webContents.on('did-stop-loading', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tabview:load-change', {
        tabId,
        loading: false,
        url: view.webContents.getURL(),
        title: view.webContents.getTitle(),
        canGoBack: view.webContents.canGoBack(),
        canGoForward: view.webContents.canGoForward()
      });
    }
  });

  view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // aborted (user navigated away)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tabview:fail-load', { tabId, errorCode, errorDescription, url: validatedURL });
    }
  });

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser:new-tab-request', sanitiseUrl(url));
    }
    return { action: 'deny' };
  });

  view.webContents.on('found-in-page', (_e, result) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tabview:find-result', {
        tabId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches
      });
    }
  });

  // Right-click context menu for web page content
  view.webContents.on('context-menu', (_e, params) => {
    const { selectionText, isEditable, linkURL, srcURL, mediaType, editFlags, pageURL } = params;
    const items = [];

    // Link
    if (linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => mainWindow?.webContents?.send('browser:new-tab-request', linkURL) },
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

    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

  hardenGuestWebContents(view.webContents);
  tabViews.set(tabId, view);
  return view;
}

ipcMain.handle('tabview:navigate', (_e, { tabId, url, partition }) => {
  const view = getOrCreateTabView(tabId, partition);
  view.webContents.loadURL(url).catch(() => {});
});

ipcMain.handle('tabview:show', (_e, { tabId, bounds }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const view = tabViews.get(tabId);
  if (!view) return;
  const b = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  };
  if (!mainWindow.contentView.children.includes(view)) {
    mainWindow.contentView.addChildView(view);
  }
  view.setBounds(b);
});

ipcMain.handle('tabview:hide', (_e, tabId) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const view = tabViews.get(tabId);
  if (view && mainWindow.contentView.children.includes(view)) {
    mainWindow.contentView.removeChildView(view);
  }
});

ipcMain.handle('tabview:close', (_e, tabId) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const view = tabViews.get(tabId);
  if (!view) return;
  // Remove from window FIRST, then remove all listeners, then close
  try { if (mainWindow.contentView?.children?.includes(view)) mainWindow.contentView.removeChildView(view); } catch {}
  view.webContents.removeAllListeners();
  try { view.webContents.close(); } catch {}
  tabViews.delete(tabId);
  revokeVaultGrant(tabId);
});

ipcMain.handle('tabview:go-back', (_e, tabId) => {
  tabViews.get(tabId)?.webContents.goBack();
});

ipcMain.handle('tabview:go-forward', (_e, tabId) => {
  tabViews.get(tabId)?.webContents.goForward();
});

ipcMain.handle('tabview:reload', (_e, tabId) => {
  tabViews.get(tabId)?.webContents.reload();
});

ipcMain.on('tabview:zoom-in',    (_e, tabId) => { const v = tabViews.get(tabId); if (v) v.webContents.setZoomLevel(v.webContents.getZoomLevel() + 0.5); });
ipcMain.on('tabview:zoom-out',   (_e, tabId) => { const v = tabViews.get(tabId); if (v) v.webContents.setZoomLevel(v.webContents.getZoomLevel() - 0.5); });
ipcMain.on('tabview:zoom-reset', (_e, tabId) => { tabViews.get(tabId)?.webContents.setZoomLevel(0); });

ipcMain.on('tabview:find', (_e, { tabId, text, forward }) => {
  const v = tabViews.get(tabId);
  if (!v) return;
  if (!text) { v.webContents.stopFindInPage('clearSelection'); return; }
  v.webContents.findInPage(text, { forward: forward !== false, findNext: true });
});

ipcMain.on('tabview:find-stop', (_e, tabId) => {
  tabViews.get(tabId)?.webContents.stopFindInPage('clearSelection');
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
function buildAppMenu() {
  const send = (ch) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch); };
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
        { label: 'Toggle Full Screen', role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Privacy',
      submenu: [
        { label: 'Panic — Wipe Everything', accelerator: 'CommandOrControl+Shift+X', click: () => send('menu:panic') },
        { label: 'Lock Now', accelerator: 'CommandOrControl+Shift+L', click: () => send('menu:lock') },
        { label: 'Privacy Controls', accelerator: 'CommandOrControl+Shift+P', click: () => send('menu:privacy') },
        { label: 'Screenshot Tool', accelerator: 'Ctrl+Shift+S', click: () => send('menu:screenshot') }
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

app.whenReady().then(async () => {
  // 0a. Set custom minimal menu bar
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

  // 3. Activate default profile
  const activeProfile = await profileManager.getActiveProfile();
  if (activeProfile) {
    // Resolve key for PIN-less profiles
    const key = activeProfile.keyBase64
      ? Buffer.from(activeProfile.keyBase64, 'base64')
      : null;
    await activateProfile(activeProfile, key);
  }

  // 4. Create window
  createMainWindow();

  // Register global keyboard shortcut for panic (Cmd+Shift+X on macOS, Ctrl+Shift+X on Win/Linux)
  globalShortcut.register('CommandOrControl+Shift+X', async () => {
    try {
      clipboard.clear();
      setVaultMode('locked');
      isScreenLocked = false;
      notificationQueue.length = 0;
      await clearManagedStorage();
      await Promise.allSettled(managedSessions().map((s) => s.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })));
      tabSnapshotManager?.clear().catch(() => {});
      // Destroy all active WebContentsViews
      for (const [, view] of tabViews) {
        try { view.webContents.stop(); } catch {}
        try { mainWindow?.contentView?.removeChildView(view); } catch {}
      }
      tabViews.clear();
    } catch {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('privacy:panic-triggered');
    }
  });

  // 5. Start wipe countdown ticker — attach listeners BEFORE startTick() to avoid missing first event
  wipeEngine.on('tick', (countdowns) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const uuid = activeProfileUuid;
      const seconds = uuid ? countdowns[uuid] : null;
      mainWindow.webContents.send('wipe:countdown', {
        seconds,
        formatted: seconds != null ? formatCountdown(seconds) : '--:--:--'
      });
    }
  });

  wipeEngine.startTick();

  wipeEngine.on('wiped', async ({ profileUuid }) => {
    // Clear tab snapshot after wipe
    tabSnapshotManager?.clear().catch(() => {});
    notificationQueue.length = 0;
    resetPrivacyReport();

    // Revoke push subscriptions — clear service workers in all sessions
    await Promise.allSettled(managedSessions().map((s) =>
      s.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
    ));

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('wipe:done', { profileUuid });
    }
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('warp:status', { ...warpStatus(), supervisor: status });
    }
  });
  warpSupervisor.on('kill-switch', (active) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('warp:kill-switch', { active });
      // Lock the screen when kill switch fires — VPN is dead, block access
      if (active && !isScreenLocked) {
        isScreenLocked = true;
        mainWindow.webContents.send('security:lock', { reason: 'kill-switch' });
      }
    }
  });

  // Periodic WARP status push (fallback when supervisor is silent) — 30s is enough
  warpStatusIntervalId = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('warp:status', { ...warpStatus(), supervisor: warpSupervisor.getStatus() });
    }
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

// Window controls
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});

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
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vault:mode-changed', { mode: 'locked', timedExpired: true });
      }
    }, durationMs);
    if (vaultTimedTimer.unref) vaultTimedTimer.unref();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vault:mode-changed', {
      mode: vaultMode,
      expiresAt: vaultTimedExpiry
    });
  }
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
  mainWindow?.webContents?.send('warp:status', warpStatus());
  return { ok: true };
});

ipcMain.handle('tor:disable', async () => {
  const direct = { proxyRules: 'direct://' };
  await Promise.all([
    session.defaultSession.setProxy(direct),
    ...managedSessions().map((s) => s.setProxy(direct))
  ]).catch(() => {});
  proxyUrl = process.env.RAM_PROXY_URL || process.env.PHANTOM_PROXY_URL || '';
  mainWindow?.webContents?.send('warp:status', warpStatus());
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
  mainWindow?.webContents?.send('warp:status', warpStatus());
  return { ok: true };
});

ipcMain.handle('vpn:disconnect', async () => {
  const direct = { proxyRules: 'direct://' };
  await Promise.all([
    session.defaultSession.setProxy(direct),
    ...managedSessions().map((s) => s.setProxy(direct))
  ]).catch(() => {});
  proxyUrl = '';
  mainWindow?.webContents?.send('warp:status', warpStatus());
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

ipcMain.handle('privacy:panic', async () => {
  clipboard.clear();
  setVaultMode('locked');   // force vault to locked on panic
  isScreenLocked = false;   // panic resets lock state (UI wiped)
  notificationQueue.length = 0; // drop queued notifications
  await clearManagedStorage();
  // Revoke push subscriptions — clear service workers in all sessions
  await Promise.allSettled(managedSessions().map((s) => s.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })));
  tabSnapshotManager?.clear().catch(() => {});
  // Destroy all active WebContentsViews
  for (const [, view] of tabViews) {
    try { view.webContents.stop(); } catch {}
    try { mainWindow?.contentView?.removeChildView(view); } catch {}
  }
  tabViews.clear();
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
  tabSnapshotManager?.clear().catch(() => {});
  return { ok: true };
});

// Per-container wipe
ipcMain.handle('wipe:container', async (_e, { container }) => {
  if (!CONTAINERS.includes(container)) return { ok: false, reason: 'unknown_container' };
  const partition = `ram-${container}`;
  try {
    const s = session.fromPartition(partition);
    const storageTypes = ['cookies','filesystem','indexdb','localstorage','shadercache','websql','serviceworkers','cachestorage'];
    await s.clearStorageData({ storages: storageTypes });
    await s.clearCache();
    await s.clearAuthCache();
    await s.clearHostResolverCache();
    // Revoke vault grants for all tabs running in this container
    for (const [tid, view] of tabViews) {
      try {
        const url = view.webContents.getURL();
        if (url && session.fromPartition(partition) === view.webContents.session) revokeVaultGrant(tid);
      } catch {}
    }
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

ipcMain.handle('wipe:set-interval', (_e, { hours }) => {
  const clampedH = Math.min(7 * 24, Math.max(1, Number(hours) || 24));
  wipeIntervalMs = clampedH * 60 * 60 * 1000;
  // Reschedule the active profile timer with new interval
  if (activeProfileUuid) {
    const partitions = CONTAINERS.map((c) => `ram-${c}`);
    wipeEngine.schedule(activeProfileUuid, partitions, wipeIntervalMs);
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
      await clearManagedStorage();
      tabSnapshotManager?.clear().catch(() => {});
      clipboard.clear();
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

ipcMain.handle('profiles:active', async () => {
  const profile = await profileManager.getActiveProfile();
  if (!profile) return null;
  return { uuid: profile.uuid, name: profile.name, color: profile.color };
});

ipcMain.handle('profiles:update', async (_e, { uuid, updates }) => {
  await profileManager.updateProfile(uuid, updates);
  return { ok: true };
});

ipcMain.handle('profiles:get-prefs', async (_e, { uuid }) => {
  const profile = await profileManager.getProfile(uuid);
  if (!profile) return null;
  // Key may be in index (PIN-less profiles)
  const key = profile.keyBase64 ? Buffer.from(profile.keyBase64, 'base64') : null;
  if (!key) return null;
  return profileManager.readPrefs(uuid, key);
});

ipcMain.handle('profiles:set-homepage', async (_e, { uuid, url }) => {
  const profile = await profileManager.getProfile(uuid);
  if (!profile) return { ok: false };
  const key = profile.keyBase64 ? Buffer.from(profile.keyBase64, 'base64') : null;
  if (!key) return { ok: false };
  const prefs = await profileManager.readPrefs(uuid, key);
  prefs.homepageUrl = url || null;
  await profileManager.writePrefs(uuid, prefs, key);
  return { ok: true };
});

ipcMain.handle('profiles:get-homepage', async (_e, { uuid }) => {
  const profile = await profileManager.getProfile(uuid);
  if (!profile) return { url: null };
  const key = profile.keyBase64 ? Buffer.from(profile.keyBase64, 'base64') : null;
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
  return { ok: true };
});

// PIN
ipcMain.handle('pin:verify', async (_e, { uuid, pin }) => {
  const dir = profileManager.profileDir(uuid);
  return verifyPin(dir, pin);
});

ipcMain.handle('pin:set', async (_e, { uuid, pin }) => {
  const dir = profileManager.profileDir(uuid);
  await setPin(dir, pin);
  await profileManager.updateProfile(uuid, { hasPin: true });
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

// Tab snapshot
ipcMain.on('tabs:snapshot', (_e, { tabs, activeIndex }) => {
  tabSnapshotManager?.write(tabs, activeIndex);
});

ipcMain.handle('tabs:restore', async () => {
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

