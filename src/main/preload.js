'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('phantom', {

  // ── window state ─────────────────────────────────────────────────────────────
  window: {
    onFullScreen: (cb) => ipcRenderer.on('window:fullscreen', (_e, on) => cb(on))
  },

  // ── privacy / panic ─────────────────────────────────────────────────────────
  privacy: {
    panic:        () => ipcRenderer.invoke('privacy:panic'),
    clearAllData: () => ipcRenderer.invoke('privacy:clear-all-data'),
    getReport:    () => ipcRenderer.invoke('privacy:get-report'),
    resetReport:  () => ipcRenderer.invoke('privacy:reset-report'),
    onPanic: (cb) => {
      const listener = (_e) => cb();
      ipcRenderer.on('privacy:panic-triggered', listener);
      return () => ipcRenderer.removeListener('privacy:panic-triggered', listener);
    },
    onGhostMode: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('profile:ghost-mode', listener);
      return () => ipcRenderer.removeListener('profile:ghost-mode', listener);
    }
  },

  // ── vault (camera / mic) ────────────────────────────────────────────────────
  vault: {
    setMode: (mode, durationMs) => ipcRenderer.invoke('vault:set-mode', mode, durationMs),
    getMode: ()     => ipcRenderer.invoke('vault:get-mode'),
    onChange: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('vault:mode-changed', listener);
      return () => ipcRenderer.removeListener('vault:mode-changed', listener);
    }
  },

  // ── WARP / VPN ──────────────────────────────────────────────────────────────
  warp: {
    getStatus:  () => ipcRenderer.invoke('warp:get-status'),
    getProxy:   () => ipcRenderer.invoke('vpn:get-proxy'),
    setProxy:   (url) => ipcRenderer.invoke('vpn:set-proxy', url),
    disconnect: () => ipcRenderer.invoke('vpn:disconnect'),
    test:       () => ipcRenderer.invoke('vpn:test'),
    enableTor:  () => ipcRenderer.invoke('tor:enable'),
    disableTor: () => ipcRenderer.invoke('tor:disable'),
    onStatus:  (cb) => {
      const listener = (_e, status) => cb(status);
      ipcRenderer.on('warp:status', listener);
      return () => ipcRenderer.removeListener('warp:status', listener);
    },
    onDnsProbe: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('dns:probe-result', listener);
      return () => ipcRenderer.removeListener('dns:probe-result', listener);
    },
    onKillSwitch: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('warp:kill-switch', listener);
      return () => ipcRenderer.removeListener('warp:kill-switch', listener);
    }
  },

  // ── wipe engine ─────────────────────────────────────────────────────────────
  wipe: {
    getCountdown:  () => ipcRenderer.invoke('wipe:get-countdown'),
    triggerNow:    () => ipcRenderer.invoke('wipe:trigger-now'),
    getInterval:   () => ipcRenderer.invoke('wipe:get-interval'),
    setInterval:   (h) => ipcRenderer.invoke('wipe:set-interval', { hours: h }),
    container:     (c) => ipcRenderer.invoke('wipe:container', { container: c }),
    onCountdown:  (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('wipe:countdown', listener);
      return () => ipcRenderer.removeListener('wipe:countdown', listener);
    },
    onWipeDone: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('wipe:done', listener);
      return () => ipcRenderer.removeListener('wipe:done', listener);
    }
  },

  // ── profiles ─────────────────────────────────────────────────────────────────
  profiles: {
    list:             ()              => ipcRenderer.invoke('profiles:list'),
    create:           (opts)         => ipcRenderer.invoke('profiles:create', opts),
    switch:           (uuid, pin)    => ipcRenderer.invoke('profiles:switch', { uuid, pin }),
    active:           ()             => ipcRenderer.invoke('profiles:active'),
    delete:           (uuid)         => ipcRenderer.invoke('profiles:delete', uuid),
    update:           (uuid, updates) => ipcRenderer.invoke('profiles:update', { uuid, updates }),
    getPrefs:         (uuid)         => ipcRenderer.invoke('profiles:get-prefs', { uuid }),
    setHomepage:      (uuid, url)    => ipcRenderer.invoke('profiles:set-homepage', { uuid, url }),
    getHomepage:      (uuid)         => ipcRenderer.invoke('profiles:get-homepage', { uuid }),
    setUnlockPhrase:  (uuid, phrase) => ipcRenderer.invoke('profiles:set-unlock-phrase', { uuid, phrase }),
    unlockHidden:     (phrase)       => ipcRenderer.invoke('profiles:unlock-hidden', { phrase }),
    onSwitch: (cb) => {
      const listener = (_e, profile) => cb(profile);
      ipcRenderer.on('profile:active', listener);
      return () => ipcRenderer.removeListener('profile:active', listener);
    }
  },

  // ── PIN ──────────────────────────────────────────────────────────────────────
  pin: {
    verify:   (uuid, pin) => ipcRenderer.invoke('pin:verify',     { uuid, pin }),
    set:      (uuid, pin) => ipcRenderer.invoke('pin:set',        { uuid, pin }),
    setDecoy: (uuid, pin) => ipcRenderer.invoke('pin:set-decoy',  { uuid, pin })
  },

  // ── Settings → main process flags ────────────────────────────────────────────
  settings: {
    setWipeOnQuit:    (v) => ipcRenderer.send('settings:wipe-on-quit',   v),
    setRequireVpn:    (v) => ipcRenderer.send('settings:require-vpn',    v),
    setLinkSanitiser: (v) => ipcRenderer.send('settings:link-sanitiser', v),
    setRedirectBlock: (v) => ipcRenderer.send('settings:redirect-block', v),
    setHttpsOnly:     (v) => ipcRenderer.send('settings:https-only',     v),
    setTrackerBlock:  (v) => ipcRenderer.send('settings:tracker-block',  v),
    setAutoLock:      (v) => ipcRenderer.send('settings:auto-lock',      v),
    setReportReset:   (v) => ipcRenderer.send('settings:report-reset',   v)
  },

  // ── tab snapshots ────────────────────────────────────────────────────────────
  tabs: {
    snapshot: (tabs, activeIndex) => ipcRenderer.send('tabs:snapshot', { tabs, activeIndex }),
    restore:  ()                   => ipcRenderer.invoke('tabs:restore')
  },

  // ── browser events ───────────────────────────────────────────────────────────
  browser: {
    onNewTabRequest: (cb) => {
      const listener = (_e, url) => cb(url);
      ipcRenderer.on('browser:new-tab-request', listener);
      return () => ipcRenderer.removeListener('browser:new-tab-request', listener);
    }
  },

  // ── network ──────────────────────────────────────────────────────────────────
  network: {
    probe: (url) => ipcRenderer.invoke('network:probe', url)
  },

  // ── security ─────────────────────────────────────────────────────────────────
  security: {
    setContentProtection: (enabled) => ipcRenderer.invoke('security:set-content-protection', enabled),
    captureScreen:        ()         => ipcRenderer.invoke('screenshot:capture'),
    saveScreenshot:       (dataUrl, filePath) => ipcRenderer.invoke('screenshot:save', { dataUrl, filePath }),
    screenUnlocked:       ()         => ipcRenderer.send('security:screen-unlocked'),
    onLock: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('security:lock', listener);
      return () => ipcRenderer.removeListener('security:lock', listener);
    },
    onFocus: (cb) => {
      const listener = (_e, focused) => cb(focused);
      ipcRenderer.on('window:focus', listener);
      return () => ipcRenderer.removeListener('window:focus', listener);
    }
  },

  // ── tab views (WebContentsView) ──────────────────────────────────────────────
  tabViews: {
    navigate:   (tabId, url, partition) => ipcRenderer.invoke('tabview:navigate', { tabId, url, partition }),
    show:       (tabId, bounds)         => ipcRenderer.invoke('tabview:show', { tabId, bounds }),
    hide:       (tabId)                 => ipcRenderer.invoke('tabview:hide', tabId),
    close:      (tabId)                 => ipcRenderer.invoke('tabview:close', tabId),
    goBack:     (tabId)                 => ipcRenderer.invoke('tabview:go-back', tabId),
    goForward:  (tabId)                 => ipcRenderer.invoke('tabview:go-forward', tabId),
    reload:     (tabId)                 => ipcRenderer.invoke('tabview:reload', tabId),
    onNavigated: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('tabview:navigated', listener);
      return () => ipcRenderer.removeListener('tabview:navigated', listener);
    },
    onTitleUpdated: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('tabview:title-updated', listener);
      return () => ipcRenderer.removeListener('tabview:title-updated', listener);
    },
    onLoadChange: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('tabview:load-change', listener);
      return () => ipcRenderer.removeListener('tabview:load-change', listener);
    },
    onFailLoad: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('tabview:fail-load', listener);
      return () => ipcRenderer.removeListener('tabview:fail-load', listener);
    },
    onFindResult: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('tabview:find-result', listener);
      return () => ipcRenderer.removeListener('tabview:find-result', listener);
    },
    find:      (tabId, text, forward) => ipcRenderer.send('tabview:find', { tabId, text, forward }),
    stopFind:  (tabId)               => ipcRenderer.send('tabview:find-stop', tabId),
    zoomIn:    (tabId)               => ipcRenderer.send('tabview:zoom-in',    tabId),
    zoomOut:   (tabId)               => ipcRenderer.send('tabview:zoom-out',   tabId),
    zoomReset: (tabId)               => ipcRenderer.send('tabview:zoom-reset', tabId),
  },

  // ── downloads ────────────────────────────────────────────────────────────────
  downloads: {
    onStart: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('download:start', listener);
      return () => ipcRenderer.removeListener('download:start', listener);
    },
    onDone: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('download:done', listener);
      return () => ipcRenderer.removeListener('download:done', listener);
    }
  },

  // ── native notifications ─────────────────────────────────────────────────────
  notify: (title, body) => ipcRenderer.send('app:notify', { title, body }),

  menu: {
    onNewTab:     (cb) => ipcRenderer.on('menu:new-tab',    (_e) => cb()),
    onCloseTab:   (cb) => ipcRenderer.on('menu:close-tab',  (_e) => cb()),
    onReload:     (cb) => ipcRenderer.on('menu:reload',      (_e) => cb()),
    onBack:       (cb) => ipcRenderer.on('menu:back',        (_e) => cb()),
    onForward:    (cb) => ipcRenderer.on('menu:forward',     (_e) => cb()),
    onPanic:      (cb) => ipcRenderer.on('menu:panic',       (_e) => cb()),
    onLock:       (cb) => ipcRenderer.on('menu:lock',        (_e) => cb()),
    onPrivacy:    (cb) => ipcRenderer.on('menu:privacy',     (_e) => cb()),
    onScreenshot: (cb) => ipcRenderer.on('menu:screenshot',  (_e) => cb()),
    onSettings:   (cb) => ipcRenderer.on('menu:settings',    (_e) => cb()),
    onFocusUrl:   (cb) => ipcRenderer.on('menu:focus-url',   (_e) => cb()),
    onFind:       (cb) => ipcRenderer.on('menu:find',        (_e) => cb()),
    onZoomIn:     (cb) => ipcRenderer.on('menu:zoom-in',     (_e) => cb()),
    onZoomOut:    (cb) => ipcRenderer.on('menu:zoom-out',    (_e) => cb()),
    onZoomReset:  (cb) => ipcRenderer.on('menu:zoom-reset',  (_e) => cb()),
    onNextTab:    (cb) => ipcRenderer.on('menu:next-tab',    (_e) => cb()),
    onPrevTab:    (cb) => ipcRenderer.on('menu:prev-tab',    (_e) => cb()),
  }
});
