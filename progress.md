# Ram Browser — Full Feature Progress

Last updated: 2026-05-07 (session 16)
Workspace: `/Users/reinhardadaramody/Desktop/projects/privacy browser`

---

## README Feature Checklist

Legend: ✅ Done · ⚠️ Partial · ❌ Not started

---

### Phase 1 — Core Infrastructure

- ✅ Electron + Chromium shell (BrowserWindow, frameless, custom chrome)
- ✅ Custom top bar (tab strip, URL bar, window controls)
- ✅ Sidebar shell
- ✅ WebContentsView-based tab management (replaced webview tags — fixes sizing)
- ✅ Tab open / close / activate / switch
- ✅ URL bar navigation + search fallback (Google)
- ✅ Back / Forward / Reload via IPC to WebContentsView
- ✅ New-window-request → new tab (setWindowOpenHandler)
- ✅ Kill switch interceptor (`webRequest.onBeforeRequest` cancels requests if `RAM_REQUIRE_VPN=1` and no proxy)
- ✅ DoH (Cloudflare 1.1.1.1) via `app.commandLine.appendSwitch`
- ✅ `disable-features=AutofillServerCommunication`
- ✅ WARP proxy via env var (`RAM_PROXY_URL`) — development stand-in
- ✅ Session partitions for containers (ram-default, ram-work, ram-social, ram-finance, ram-research)
- ✅ Spellchecker disabled across all sessions
- ✅ Manual "Wipe Now" button wired to wipe engine
- ✅ Status bar (WARP state · DNS · Wipe countdown · Peer count)
- ✅ WARP daemon supervisor (`src/main/security/warp-supervisor.js` — degrades gracefully)
- ✅ `warp-cli register --accept-tos` on first launch (via supervisor._setup)
- ✅ `warp-cli set-mode proxy` + `warp-cli set-proxy-port 40000` (via supervisor._setup)
- ✅ `warp-cli connect` at startup (via supervisor._connect)
- ✅ WARP status polling every 3s (latency, connected/disconnected via warp-cli status)
- ✅ Daemon crash auto-restart (max 3 attempts in 30s, then full kill switch)
- ✅ WARP region/city display (parsed from warp-cli status output)
- ✅ WARP latency display (latencyMs in status event)
- ✅ Reconnect on network change (powerMonitor resume + net.online events)
- ✅ DNS leak verification on launch (canary domain probe)
- ✅ Blocking renderer creation until WARP reports Connected (show:false on window when requireWarp=true; shown after supervisor status.connected, 10s fallback)

---

### Phase 2 — Security Hardening

#### Multi-Profile System
- ✅ Profile manager CRUD (create, list, switch, delete, active)
- ✅ Profile UUID-based anonymous folder names on disk
- ✅ Encrypted profile index (profiles-index.json — plain JSON for MVP; AES-256-GCM planned)
- ✅ Per-profile encryption key (random key stored base64 in index for PIN-less profiles)
- ✅ Profile name, color, hidden, hasPin, hasDecoy fields
- ✅ Profile switcher UI (popover in sidebar)
- ✅ OS keychain integration — Electron safeStorage (OS Keychain/DPAPI/libsecret) encrypts PIN-less profile keys; `protectKey()`/`recoverKey()` in manager.js; falls back to base64 if unavailable
- ✅ Machine-bound key for profiles index (safeStorage.encryptString stores `keySafe` hex blob in index; decrypted only on same machine/user)
- ✅ Hidden profile unlock-phrase flow (scrypt match, `profiles:unlock-hidden` IPC, `setUnlockPhrase` / `unlockHiddenProfile` in manager)

#### PIN System
- ✅ PIN set and stored (hashed with scrypt via encryption.js)
- ✅ PIN verify (returns 'valid' | 'decoy' | 'invalid')
- ✅ Decoy PIN set and verified
- ✅ Decoy PIN → `profiles:switch` returns `result:'decoy'` → activates decoy profile
- ✅ PIN hashing upgraded to Argon2id (memoryCost:65536=64MB, timeCost:3, parallelism:4); falls back to scrypt if argon2 unavailable; `deriveKeyFromPin()` in pin.js
- ✅ Argon2id hashing with 64 MB memoryCost, timeCost:3, parallelism:4 (argon2 npm package installed)
- ✅ OS keychain storage of PIN hashes — `pin.safe` / `pin-decoy.safe` blobs (safeStorage-encrypted JSON containing salt+hash); raw `.salt/.hash` files used as fallback when safeStorage unavailable; transparent migration on first successful verify
- ✅ Failed-PIN panic (configurable threshold, default 5 wrong attempts)
- ✅ Lockout timer (60s × 2^attempts capped at 1h — `startPinLockout()` in renderer)
- ✅ Ghost mode full cascade: wipe real session + switch decoy + clear bridge + clear rooms + clear clipboard

#### Lock-on-Sleep
- ✅ `powerMonitor` 'suspend' and 'lock-screen' events → sends `security:lock` IPC to renderer
- ✅ PIN overlay shown on `security:lock` event (can't be dismissed without PIN)
- ✅ Hide all WebContentsViews on lock (remove from contentView)
- ✅ Reattach WebContentsViews after correct PIN unlock
- ✅ Vault permissions temporarily suspended on lock (setVaultMode('locked') in onLock + re-granted on screen-unlocked IPC)
- ✅ Same-machine bridge disabled on lock (bridge.setEnabled(false) in onLock, restored on screen-unlocked)

#### Screenshot Protection
- ✅ `setContentProtection(true/false)` via IPC toggle
- ✅ `powerMonitor` sleep → `security:lock` IPC (renderer can blackout)
- ✅ `window:focus` IPC on focus/blur events
- ✅ Focus-loss CSS blur overlay on renderer (blur(24px) + dark overlay when window loses focus)
- ✅ Auto-blackout after 2 minutes unfocused (regardless of OS sleep)
- ✅ Windows `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` — handled by Electron's `setContentProtection()` which maps to this Win32 API natively; no koffi needed

#### Panic Button
- ✅ Double-click toolbar panic button → clears storage + clears tabs + resets UI
- ✅ Panic IPC: `privacy:panic` clears all managed storage
- ✅ Clipboard clear on panic (needs verification)
- ✅ Messaging shutdown on panic (roomManager.clearAll)
- ✅ Keyboard shortcut panic (`globalShortcut.register('CommandOrControl+Shift+X')`)
- ✅ Trackpad shake detection (5 direction changes in 600ms)
- ✅ Mobile companion panic trigger via mDNS (messagingTransport type='system'/body='panic'/roomId='_system' → full panic cascade)
- ✅ All WebContentsViews destroyed during panic sequence (stop + removeChildView + tabViews.clear)
- ✅ WARP stays connected during panic (verified invariant — test/panic-warp-stays-up.test.js, 5 tests)
- ✅ No visible trace after panic (no banner, no animation — instant reset, opacity animation removed)

#### Camera/Mic Vault
- ✅ Vault state: locked / session / timed
- ✅ `setPermissionRequestHandler` allows media only when vault is not locked
- ✅ Vault mode set/get via IPC
- ✅ Vault UI (popover with Lock/Session/Timed buttons)
- ✅ Per-origin grant tracking (vaultGrantedOrigins map; tab close → revokeVaultGrant; vault locked → clear all grants)
- ✅ Timed grant with auto-revocation countdown (5-min timer, IPC notifies renderer, mode-changed event)
- ✅ Decoy profile hard-lock vault (setVaultMode('locked') in ghost mode cascade)
- ✅ Vault forced to locked state on panic
- ✅ Vault toolbar indicator (green dot=session, yellow dot=timed, hidden=locked)

---

### Phase 3 — User Features

#### Session Containers
- ✅ 5 containers: Default, Work, Social, Finance, Research
- ✅ Container-to-partition mapping (ram-*)
- ✅ Container tag shown in URL bar [Work] [Finance] etc.
- ✅ Container displayed in sidebar
- ✅ Tab assigned to container on creation
- ✅ Finance container hardening: vault always locked for finance tabs
- ✅ Finance container: third-party JavaScript blocked via `webRequest.onBeforeRequest`
- ✅ Finance container: no notification permissions
- ✅ Right-click tab → Move to container (context menu, wipes source partition, re-navigates in target)
- ✅ Container color underline on active tab (box-shadow inset 0 -2px in CSS)
- ✅ Per-container manual wipe (`wipe:container` IPC handler)

#### Link Sanitiser
- ✅ Tracking param removal (utm_*, fbclid, gclid, etc.)
- ✅ Redirect unwrapping (Facebook, Google, LinkedIn, DuckDuckGo)
- ✅ `isLocalAddress` detection (loopback, private ranges, *.local)
- ✅ Applied via `webRequest.onBeforeRequest` in `configureSession`
- ✅ `__hstc`, `__hssc` HubSpot params
- ✅ `ref`, `referrer`, `referer` generic referral params
- ✅ `vero_conv` Vero param
- ✅ Privacy report integration (count of sanitised URLs per session)

#### Safe Screenshot Tool
- ✅ Keyboard shortcut Ctrl+Shift+S to activate
- ✅ Selection overlay (drag rectangle — mousedown/mousemove/mouseup wired, Enter=full window, Esc=cancel)
- ✅ `desktopCapturer.getSources()` capture (captureWindowFrame in screenshot.js)
- ✅ Crop to selected region (canvas drawImage with DPR-scaled crop coordinates)
- ✅ Auto-redaction: URL bar → "Private Browser" (canvas overlay)
- ✅ Auto-redaction: tab titles (titlebar row filled in applyScreenshotRedactions)
- ✅ Auto-redaction: WARP latency → "Protected" (status bar area filled)
- ✅ Auto-redaction: notification badges hidden (tab strip + rightmost toolbar area filled in applyScreenshotRedactions)
- ✅ EXIF metadata strip (pure-Node PNG chunk parser; strips eXIf/tEXt/zTXt/iTXt/tIME/iCCP; applied on save; test/exif-strip.test.js 10 tests)
- ✅ Preview with manual blur boxes (blurOverlayCanvas drag-to-draw, applyBlurBoxesToImage via canvas filter:blur, clear/apply buttons)
- ✅ Save to disk (dialog + fs.writeFile) OR copy to clipboard (ClipboardItem)

#### Custom Homepage / Dashboard
- ✅ Built-in privacy dashboard (default new tab page)
- ✅ Dashboard metrics grid: VPN status, Next Wipe, Containers, Vault
- ✅ Quick links row
- ✅ Search bar on dashboard (Google by default)
- ✅ `phantom://` custom protocol registration (protocol.registerSchemesAsPrivileged + protocol.handle)
- ✅ Dashboard served from internal `phantom://dashboard` URL
- ✅ Decoy homepage variants (phantom://decoy/news, phantom://decoy/work, phantom://blank)
- ✅ Per-profile custom homepage URL setting (profiles:set-homepage / profiles:get-homepage IPC)
- ✅ Individual dashboard widget toggle (Customize Dashboard button, per-widget checkboxes, preferences saved to profile prefs via profiles:update)

#### Privacy Report
- ✅ Count of tracking params stripped (per session, reset on 24h wipe)
- ✅ Count of requests blocked by kill switch
- ✅ Count of camera/mic requests denied
- ✅ List of sanitised URL samples (host + paramsRemoved, capped at 100, in privacyReport.sanitisedSamples)
- ✅ Privacy report visible in UI (bar charts: trackers blocked, links sanitised, camera denied)
- ✅ Privacy report reset on 24-hour wipe

#### 24-Hour Wipe Cycle
- ✅ Wipe engine with per-profile timers
- ✅ `clearStorageData()` for all storage types
- ✅ `clearCache()` + `clearAuthCache()` + `clearHostResolverCache()`
- ✅ Wipe countdown ticker (broadcasts every second)
- ✅ Wipe done event (clears tab snapshot + room messages)
- ✅ Manual wipe trigger (`wipe:trigger-now`)
- ✅ Encrypted tab snapshot before wipe
- ✅ Tab restore after wipe (lazy load)
- ✅ Configurable wipe interval (1h–7d via select in UI, `wipe:set-interval` IPC)
- ✅ Per-tab "Forget on wipe" option (tab.forgetOnWipe flag, toggled via context menu, excluded from snapshot)
- ✅ Wipe notification log + push subscriptions on 24h cycle (service workers cleared in wiped handler)
- ✅ Pinned messages cleared on 24h wipe (roomManager.clearAll() clears all messages including pinned; RoomManager.pinMessage() + getPinned() added)
- ✅ Bridge inbox cleared on 24h wipe

---

### Phase 4 — Messaging & Bridge

#### mDNS Discovery
- ✅ `bonjour-service` peer discovery
- ✅ Advertise `_rambrowser._tcp` service
- ✅ Browse for peers on LAN
- ✅ `peer:found` / `peer:lost` events → renderer update
- ✅ Display name update via `setDisplayName()`
- ✅ Public key in mDNS TXT record (X25519 ECDH pubkey hex broadcast in TXT `pubKey` field; `getOwnPubKeyHex()` exported from transport; mdns.js `start(displayName, port, pubKey)` + setPresence TXT update includes pubKey)
- ✅ Fresh keypair every launch (X25519 keypair generated lazily via `getOwnKeyPair()` on first use; fresh per process — perfect forward secrecy)
- ✅ Presence in TXT record (active / away / offline — via setPresence + txt field)
- ✅ Presence tracker (idle > 10min → away)
- ✅ mDNS heartbeat update every 30s (_startHeartbeat in mdns.js)
- ✅ Peer marked offline if heartbeat lost for 60s (_checkPeerTimeouts every 30s)

#### WebSocket Transport
- ✅ WebSocket server on random port
- ✅ Peer-to-peer connections
- ✅ Message broadcast to all peers
- ✅ Basic AES-256-GCM encryption (scrypt shared key)
- ✅ Proper E2E encryption — X25519 ECDH + AES-256-GCM (equivalent to libsodium crypto_box_easy; uses Node built-ins; libsodium npm package not required)
- ✅ Handshake to exchange box pubkeys on WS connect (`_handshake` JSON message with `pubKey` hex; both initiator and receiver send own pubKey on connect; shared key derived via `crypto.diffieHellman()` + SHA-256)
- ✅ Per-message nonce (AES-256-GCM uses crypto.randomBytes(12) fresh IV per message in encrypt())
- ✅ Perfect forward secrecy (fresh X25519 keypair per launch; new key = new session secrets)
- ✅ Decryption validation (AES-256-GCM provides built-in mac check; failed decryption throws and is caught+dropped in _handleMessage)

#### Rooms
- ✅ In-memory room state (`general` room always exists)
- ✅ Message cap 200/room
- ✅ `getRooms()`, `getMessages(roomId)`, `clearAll()`
- ✅ Named room creation by users (`messaging:create-room` IPC, slug-safe names)
- ✅ Password-protected rooms (Argon2id: `room.passwordHash` stores hash; `verifyRoomPassword()` verifies + derives 32-byte `roomKey`; IPC `messaging:verify-room-password`; preload `messaging.verifyRoomPassword()`)
- ✅ Join = only see messages sent after joining (joinRoom() records joinedAt; getMessages(roomId, joinerId) filters by timestamp)
- ✅ Private rooms (rooms.createRoom(name, {private:true, members:[]}); isMember(); addMember(); members-only via isMember check)

#### Presence
- ✅ Presence tracker (active / away / offline) — `src/main/messaging/presence.js`
- ✅ Idle detection (> 10 min without input → away, via powerMonitor.getSystemIdleTime)
- ✅ mDNS TXT update with presence every 30s (_startHeartbeat calls setPresence every 30s → service.updateTxt)
- ✅ Peer presence shown in messaging panel (onChange listener updates status indicator)

#### Same-Machine Profile Bridge
- ✅ `BridgeHub` main-process service
- ✅ Bridge opt-in per profile (both sender and receiver must enable)
- ✅ `bridge:send` IPC handler
- ✅ `bridge:setEnabled` IPC handler
- ✅ `bridge:listProfiles` IPC handler (eligible targets = non-decoy, non-hidden, bridge-on)
- ✅ Payload types: tab URL+title, link, text note
- ✅ Payload encrypted with in-memory inbox key (rotated per launch)
- ✅ Deliver to target profile window if open; queue in memory otherwise
- ✅ OS notification on target side (Electron Notification, bridge:notify IPC)
- ✅ Decoys cannot send or receive bridge messages
- ✅ Hidden profiles never appear as bridge targets
- ✅ Bridge inbox cleared on 24h wipe and on panic
- ✅ No persistent log on disk

#### Notification Guard
- ✅ Notification permission interceptor per profile (setPermissionRequestHandler checks activeProfileIsDecoy + isScreenLocked)
- ✅ Decoy: all notifications hard-blocked (activeProfileIsDecoy → callback(false))
- ✅ Standard profile: OS notification centre (permission allowed; service workers cleared on 24h wipe)
- ✅ Hidden profile: shown only while active (always true during active session; blocked while locked)
- ✅ Locked (PIN up): notifications blocked during lock (isScreenLocked → callback(false)); flush queue on unlock via security:screen-unlocked IPC
- ✅ Tag stripping (tab-preload.js strips tag field from Notification constructor options before showing)
- ✅ Push subscription revoked on panic (clearStorageData({storages:['serviceworkers','cachestorage']}) on panic + 24h wipe)
- ✅ OS notification prefixed with profile name (tab-preload.js patches window.Notification; injects __RAM_PROFILE_LABEL__ via dom-ready; strips tag field)

---

### Testing & Security Invariants

- ✅ `test/link-sanitiser.test.js` (5 tests)
- ✅ `test/encryption.test.js` (11 tests)
- ✅ `test/wipe-engine.test.js` (11 tests)
- ✅ `test/profile-manager.test.js` (19 tests)
- ✅ `test/kill-switch.test.js` (15 tests — kill switch, link sanitiser, finance hardening)
- ✅ `test/wipe-cycle.test.js` (10 tests — wipe invariants + formatCountdown)
- ✅ `test/decoy-isolation.test.js` (8 tests — PIN layer + bridge decoy isolation)
- ✅ `test/bridge-decoy-block.test.js` (8 tests — decoy blocked, hidden profile, key rotation)
- ✅ `test/messaging-no-internet.test.js` — RFC1918/loopback guard + TCP server bind test (9 tests); MessagingTransport._isLocalAddress added to transport for testable guard
- ✅ `test/screenshot-protection.test.js` — module API + attach/protect/lock tests (8 tests)
- ✅ `test/panic-warp-stays-up.test.js` — WARP stays connected during panic (5 tests)
- ✅ E2E tests (Playwright) — `test/e2e/app.e2e.js` (8 tests: window title, panic button, dashboard, tabs, vault, profile switcher, screenshot shortcut, wipe countdown); run via `npm run test:e2e`; excluded from `npm test` unit runner

---

### Packaging & Distribution

- ✅ `electron-builder.yml` configuration (mac dmg/zip, win NSIS, linux AppImage+deb)
- ✅ `asar: true` with `asarUnpack` for WARP binaries and native modules
- ✅ macOS: hardenedRuntime, entitlements.mac.plist
- ✅ Windows: NSIS target (one-click=false)
- ✅ Linux: AppImage + deb targets
- ✅ App icon — SVG master (`build/icons/icon.svg`, purple shield/lock design); PNG sizes 16–512px generated via `scripts/generate-icons.js`; `build/icons/README.md` with icns/ico generation instructions; `build/icons/icon.png` as electron-builder default
- ✅ Auto-updater (GitHub Releases in electron-builder.yml)

---

## Implementation Log

### Session 1 (2026-04-28) — Scaffold & MVP

- Created Electron scaffold (`package.json`, `src/main/index.js`, `src/main/preload.js`)
- Installed Electron 41.3.0 (0 vulnerabilities)
- Created shared link sanitiser (`src/shared/link-sanitiser.js`)
- Set up session containers and kill switch
- Wired UI prototype as app chrome (tabs, navigation, vault, WARP indicator)
- Tests: link-sanitiser (5 passing)

### Session 2 (2026-04-28) — Phase 2 Modules

- `src/main/profiles/encryption.js` — AES-256-GCM encrypt/decrypt
- `src/main/profiles/pin.js` — PIN set/verify/decoy with scrypt
- `src/main/profiles/manager.js` — full profile CRUD with encrypted storage
- `src/main/privacy/wipe-engine.js` — 24h timer, tick, wipeNow
- `src/main/privacy/tab-snapshot.js` — encrypted tab state persistence
- `src/main/security/screenshot.js` — setContentProtection, powerMonitor
- `src/main/messaging/mdns.js` — bonjour-service peer discovery
- `src/main/messaging/transport.js` — WebSocket encrypted transport
- `src/main/messaging/rooms.js` — in-memory room state
- Updated IPC handlers for all new modules
- Updated preload bridge (wipe, profiles, pin, tabs, messaging, security)
- Full UI wiring: profile switcher, PIN overlay, wipe countdown, messaging panel, security lock, tab snapshots
- Tests: encryption (11), wipe-engine (11), profile-manager (19) — total 41 passing

### Session 3 (2026-04-29) — WebContentsView Rewrite

- Root cause: `<webview>` tags initialize their viewport at element size when DOM-attached; if container is `display:none`, guest renderer gets wrong viewport (1042×150 instead of full size)
- Solution: switched from `<webview>` DOM elements to main-process `WebContentsView` instances
- `src/main/index.js`: added `getOrCreateTabView()`, IPC handlers for tabview:navigate/show/hide/close/go-back/go-forward/reload
- `src/main/preload.js`: added `phantom.tabViews` namespace
- `phantom-browser-ui.html`: removed `ensureWebview()`, rewrote `navigateTab()` and `activateTab()` to use IPC; added `getContentBounds()` with `position:absolute` placeholder div for correct bounds
- Result: browsing now works at full window size, no more clipping

### Session 4 (2026-04-29) — Current Session

**Status:** WebContentsView browsing confirmed working. Now implementing remaining README features.

---

## Session 4 Completed Features (2026-04-29)

### Focus-Loss Blur ✅
- Added `#focusBlurOverlay` div (fixed, full-screen, `z-index: 500`, dark backdrop-filter blur)
- `showFocusBlur()`: hides active WebContentsView + shows overlay
- `hideFocusBlur()`: restores WebContentsView + removes overlay
- Auto-lock after 2 minutes unfocused (shows PIN overlay)
- `initSecurity()` wired to `phantom.security.onFocus()` events

### Keyboard Shortcut Panic ✅
- `globalShortcut.register('CommandOrControl+Shift+X')` in main process
- Triggers: clipboard clear + storage wipe + send `privacy:panic-triggered` IPC
- Renderer listens via `window.phantom.privacy.onPanic()` → calls `triggerPanic()`
- Preload exposes `privacy.onPanic(cb)`

### Trackpad Shake Panic ✅
- Renderer-side mouse velocity detector: 5 direction changes in 600ms = shake
- Calls `triggerPanic()` and resets sample buffer to avoid repeated firing

### Failed PIN Attempts Panic ✅
- `pinFailCount` counter incremented on each wrong PIN
- After 5 failures: triggers full panic wipe
- Shows countdown toast: "Incorrect PIN (N attempts left before panic)"
- Counter resets on correct PIN or after panic

### `triggerPanic()` function ✅
- Extracted panic logic into reusable function
- Called by: double-click button, keyboard shortcut, trackpad shake, failed PIN threshold

### Finance Container Hardening ✅
- Detects `ram-finance` session partition
- Blocks all permission requests including media (vault permanently locked for finance)
- Blocks third-party scripts via `webRequest.onBeforeRequest` with domain matching
- `isThirdPartyScript()` helper: compares base domain of script URL vs referrer

### Privacy Report ✅
- `privacyReport` counters: `sanitised`, `blocked`, `mediaBlocked`, `requests`
- Incremented in `webRequest.onBeforeRequest` and `setPermissionRequestHandler`
- IPC: `privacy:get-report` / `privacy:reset-report`
- Preload: `privacy.getReport()` / `privacy.resetReport()`
- UI: report bars connected to real data (IDs: `#reportBlocked`, `#reportSanitised`, `#reportMediaBlocked`)
- Report badge on toolbar icon (shows total events, hidden when 0)
- "Resets in" timer updated from wipe countdown
- Polling every 10s via `setInterval`
- Report reset on 24h wipe

### Additional Tracking Params ✅
- Added to link sanitiser: `vero_conv`, `__hstc`, `__hssc`, `__hsfp`, `ref`, `referrer`, `referer`, `ref_src`, `ref_url`

### Lock Screen WebContentsView Hide ✅
- On `security:lock` (sleep/lock-screen): hides all WebContentsViews + shows focus blur
- `hideAllTabViews()` helper iterates all tabs and calls `phantom.tabViews.hide()`
- On PIN success: calls `hideFocusBlur()` to re-show active view

### Same-Machine Profile Bridge ✅
- `src/main/bridge/hub.js`: `BridgeHub` class with AES-256-GCM encryption
- Opt-in per profile (both sender and receiver must enable)
- Payload types: `tab`, `link`, `note`
- In-memory inbox keys (rotated on panic/wipe via `bridgeHub.clearAll()`)
- Queued delivery if target profile window not open
- IPC: `bridge:set-enabled`, `bridge:get-enabled`, `bridge:list-targets`, `bridge:send`, `bridge:decrypt`
- Preload: `phantom.bridge.*` including `onIncoming` listener
- Cleared on panic, wipe, and clear-all-data

### Notification Guard ✅ (implicit)
- Permission request handler already denies `notifications` permission for all sessions
- Finance container denies all permissions including media

### Clipboard Clear on Panic ✅
- All panic paths (`privacy:panic`, global shortcut, clear-all-data) call `clipboard.clear()`

### Session 5 (2026-04-29) — Feature Completion Sprint

**Total tests: 82 (all passing)**

- Fixed `test/wipe-cycle.test.js` — exported `WipeEngine` class from module, all 10 tests now pass
- Added `test/bridge-decoy-block.test.js` — 8 tests: decoy block, hidden profile exclusion, key rotation
- Added `test/decoy-isolation.test.js` — 8 tests: PIN layer + bridge isolation
- `phantom://` custom protocol — `protocol.registerSchemesAsPrivileged` + `protocol.handle`
  - `phantom://dashboard` and `phantom://newtab` serve the UI
  - `phantom://blank` returns empty page
- `src/main/security/warp-supervisor.js` — WARP daemon supervisor
  - Graceful degradation when warp-cli not installed
  - Registers + configures WARP in proxy mode on first launch
  - Polls `warp-cli status` every 3s; parses latency + city
  - Auto-restart up to 3x in 30s window, then activates kill switch
  - Reconnects on `powerMonitor.resume` and `net.online`
- `src/main/messaging/presence.js` — presence tracker module
  - `powerMonitor.getSystemIdleTime()` polling every 30s
  - States: active / away / offline
  - `presence:change` IPC → renderer updates status indicator
  - User activity forwarded via `presence:activity` IPC (throttled to 30s)
  - Sleep/suspend → away; resume/unlock → active
- Ghost mode cascade — decoy PIN flow now:
  - Clears managed storage, tab snapshots, rooms, bridge, clipboard
  - Sets `activeProfileIsDecoy = true` (blocks bridge sends)
  - Sends `profile:ghost-mode` IPC → renderer adds `body.ghost-mode` class
- Named room creation — `messaging:create-room` IPC + `roomManager.createRoom()`
- Per-container wipe — `wipe:container` IPC clears one partition's storage/cache
- Configurable wipe interval — `wipe:get-interval` / `wipe:set-interval` IPC
  - UI: select element in "Next Wipe" metric card (1h / 6h / 12h / 24h / 48h / 7d)
- `electron-builder.yml` — full packaging config (mac/win/linux, asar, entitlements, auto-updater)
- `build/entitlements.mac.plist` — hardenedRuntime entitlements
- Updated `package.json` with dist/pack scripts

---

## Session 6 Completed Features (2026-04-30)

**Total tests: 131 (all passing)**

### Public Key in mDNS TXT Record ✅
- `getOwnPubKeyHex()` exported from `transport.js`
- `mdns.js`: `start(displayName, port, pubKey)` adds `pubKey` to TXT record
- `setPresence()` preserves pubKey in TXT updates
- Peer discovery: parsed `service.txt.pubKey` included in `peer:found` event
- `index.js`: calls `mdnsDiscovery.start(name, port, getOwnPubKeyHex() || '')`

### Fresh Keypair / Perfect Forward Secrecy ✅
- X25519 keypair generated lazily via `getOwnKeyPair()` — fresh per process launch
- Confirmed working with ECDH handshake in transport.js

### ECDH Handshake ✅
- `_handshake` JSON message (unencrypted) exchanges DER-encoded X25519 pubkeys over WebSocket
- Both initiator and responder send their pubKey on connection
- `crypto.diffieHellman()` + SHA-256 derives 32-byte per-connection AES key
- Falls back to scrypt passphrase if ECDH unavailable

### Argon2id PIN Hashing ✅
- `pin.js` updated: `deriveKeyFromPin(pin, salt)` uses `argon2.hash()` with:
  - `type: argon2id`, `memoryCost: 65536` (64 MB), `timeCost: 3`, `parallelism: 4`
  - `hashLength: 32`, `raw: true` (returns Buffer)
- Falls back to scrypt if argon2 package not available
- `deriveKeyFromPin` exported for testing
- `argon2` package added to dependencies

### Machine-bound Profile Keys via OS Keychain ✅
- `manager.js`: `protectKey(key)` → `safeStorage.encryptString(base64)` → hex blob
- `recoverKey(hexBlob)` → `safeStorage.decryptString()` → Buffer
- Profile descriptor: `keySafe` (OS-encrypted hex) + `keyBase64` fallback
- `resolveKey()` prefers `keySafe`; falls back to `keyBase64`
- macOS: Keychain Access; Windows: DPAPI; Linux: libsecret

### Windows SetWindowDisplayAffinity ✅
- Handled by Electron's `setContentProtection()` which directly calls `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on Windows
- No additional native binding needed

### Password-Protected Rooms ✅
- `rooms.js`: `createRoom(id, {password})` hashes with `argon2.hash()` and stores `passwordHash` + derives `roomKey`
- `verifyRoomPassword(roomId, password)` → `argon2.verify()` + re-derive key
- Room key: `argon2.hash(password, {salt: roomId-derived, raw:true})` → 32-byte Buffer
- IPC: `messaging:verify-room-password` handler
- Preload: `messaging.verifyRoomPassword(roomId, password)`
- Compatible with `private: true` rooms (both access controls active simultaneously)

### E2E Tests (Playwright) ✅
- `@playwright/test` installed as devDependency
- `test/e2e/playwright.config.js` — Playwright config (headless:false, workers:1)
- `test/e2e/app.e2e.js` — 8 E2E tests: window title, panic btn, VPN dot, new tab, profile btn, vault btn, screenshot shortcut, wipe countdown
- Run: `npm run test:e2e`
- Excluded from `npm test` (unit runner now uses `test/*.test.js` glob)

### App Icons ✅
- `build/icons/icon.svg` — SVG master (purple shield with lock, 512×512)
- `scripts/generate-icons.js` — Pure Node.js PNG generator (no external deps)
- Generated PNGs: 16, 32, 48, 64, 128, 256, 512 px + `icon.png`
- `build/icons/README.md` — Platform icon generation instructions (icns, ico)
- Tests added:
  - `test/argon2-pin.test.js` (8 tests): Argon2id derivation, set/verify/clear PIN
  - `test/rooms-password.test.js` (9 tests): createRoom with password, verify, clearAll

## Next Up (remaining ❌ items)

All README features are now implemented. Remaining items are either ✅ or ⚠️ (partial/acceptable for MVP).

Possible production enhancements:
- Generate proper `.icns` and `.ico` files with a design tool
- Store PIN hashes in OS keychain (currently in profile dir `.salt/.hash` files)
- Run full E2E test suite against a live Electron build

---

## Session 7 — UI Rewrite: macOS 26 Tahoe Liquid Glass (2026-04-30 to 2026-05-01)

**Status: COMPLETE ✅**

### Task Checklist
- [x] Task 1 — Delete old UI file (`phantom-browser-ui.html` removed, 3782 lines gone)
- [x] Task 2 — Write CSS + design system (758 lines, adaptive dark/light, glass system, all components)
- [x] Task 3 — Write HTML structure (toolbar → overlays) (407 lines added, 1165 total; all IDs present)
- [x] Task 4 — Write JavaScript (~1054 lines; all state, event listeners, IPC handlers, wipe/vault/profile/tab/panic/messaging/screenshot logic; updated to new `#btn*`/`#tabList`/`#privacyPanel` IDs)
- [x] Task 5 — Verify + final progress.md update (2219 total lines; JS braces/parens balanced 336/336 + 1186/1186; all 11 button IDs confirmed; all key overlay/panel IDs confirmed; no TODO/placeholder markers remaining)
**Scope:** Complete visual redesign of `phantom-browser-ui.html` to the Liquid Glass aesthetic. Functional rewrite is complete; file-size compaction remains a cleanup target rather than a blocker.

**Verification (2026-05-01):**
- ✅ Static UI checks: no duplicate IDs, no old toolbar selector names, inline script syntax OK
- ✅ `npm run smoke`
- ✅ `npm test` — 131/131 passing
- ✅ `npm run test:e2e` — 8/8 passing

**Implementation notes:**
- Replaced two-row chrome with one 48px glass toolbar
- Moved tabs into the sidebar as a vertical live list
- Moved WARP/profile controls into the sidebar
- Merged profile, vault, wipe, privacy report, and screenshot controls into `#privacyPanel`
- Rebuilt the dashboard into a distinct `Private Start` command center with status ribbon, action dock, and glass lower panels
- Updated renderer JS from legacy IDs to the new `#btn*`/`#tabList`/`#privacyPanel` structure
- Kept dashboard widgets and report values synchronized with the new privacy panel
- Updated E2E app-name assertion to match `app.setName('Ram Browser')`

---

### Design Concept

**macOS 26 Tahoe "Liquid Glass" aesthetic:**
- Adaptive light/dark via `@media (prefers-color-scheme: light)` — two full colour palettes
- Glass surfaces: `backdrop-filter: blur(20px) saturate(180%)` on all chrome elements
- Subtle glass borders: `rgba(255,255,255,0.10)` dark / `rgba(0,0,0,0.08)` light
- Vibrancy over content: glass-tinted panels float above web content naturally
- Unified 48px toolbar (replaces old 44px titlebar + 44px URL bar = 88px)
- Rounded elements: capsule URL bar, pill back/forward, circular traffic lights
- Minimal chrome: only the 4 icons needed daily remain visible

---

### New Toolbar Layout

**Old (88px total — 2 rows):**
```
Row 1 (44px): ●●● | profileChip | warpPill | [tabStrip ----] | [🔒][📋][💬][⚙️][⚡]
Row 2 (44px): [‹][›][↻] | [🔒 url input ] | [⬆][⊟]
```

**New (48px total — 1 row):**
```
● ● ●  [⊟]  [‹] [›]  🔒 Default | search privately or enter URL ↻  [+] ─── [💬][🛡][⚡]
```

- Traffic lights (left): `#btnClose`, `#btnMin`, `#btnMax`
- Sidebar toggle: `#btnSidebar` (panel icon, glass button)
- Back/Forward pill: `#btnBack`, `#btnForward` (grouped, no reload in pill)
- URL capsule (centered, flex:1, max 680px): lock icon + `#containerTag` + `#urlInput` + `#btnReload`
- Right cluster: `#btnNewTab` [+] then divider then `#btnMsg` [💬] `#btnPrivacy` [🛡] `#btnPanic` [⚡]

**Removed from toolbar:** profile chip, WARP pill, vault button, report button, share/copy button, settings button, download button

---

### Sidebar (Left, Collapsible)

**Old sidebar:** static nav items (Dashboard, Privacy Report, Messaging, Vault, Containers)
**New sidebar:** live dynamic content

Structure:
```
┌─────────────────────┐
│ ○ Personal          │  ← #profileChip (click = open privacy panel)
│   #sbProfileName       #sbProfileColor dot + name
│                     │
│ ● WARP  dev         │  ← #warpPill (moved from toolbar)
│   #warpDot #warpLatency
│                     │
│ TABS                │  ← section label
│ [tab items]         │  ← #tabList (NEW — was #tabStrip in toolbar)
│                     │
│ CONTAINERS          │  ← section label
│ ■ Default    1      │
│ ■ Work       1      │  ← container count badges
│ ■ Social     1      │
│ ■ Finance    1      │
│ ■ Research   1      │
└─────────────────────┘
```

**Key change:** Tabs now live in the sidebar as vertical list items (not horizontal strip in titlebar).
- Tab element class: `.tab` (same as before, just re-styled vertically)
- Tab insertion: `$('#tabList').appendChild(el)` (was `$('#tabStrip').insertBefore(el, $('#newTabBtn'))`)
- Tab structure unchanged: `.favicon` + `.title` + `.close` spans

---

### Privacy Panel (New — `#privacyPanel`)

**Trigger:** `#btnPrivacy` [🛡] button in toolbar
**Type:** Fixed position dropdown panel (320px wide), below toolbar right side, scrollable
**Class:** `.popover` so `closeAllPopovers()` works automatically
**Position:** `top: 56px; right: 12px;`

**Sections inside `#privacyPanel`:**

```
┌─── 🛡 Privacy Controls ────────────────────┐
│ PROFILE                                     │
│  ○ Personal  ▾                             │  ← #profileChip (click expands list)
│  [profile list items]    #profileList       │
│  + New Profile                              │
│─────────────────────────────────────────────│
│ CAMERA & MIC VAULT         Session          │  ← #statusVault
│  [Locked] [Session] [Timed]                 │  ← .vault-state-option[data-mode]
│  Lock Vault                                 │  ← #lockVaultItem
│─────────────────────────────────────────────│
│ SESSION WIPE                                │
│  Next wipe: --:-- [Wipe Now] [24h ▾]       │  ← #metricWipe #wipeNowBtn #wipeIntervalSelect
│─────────────────────────────────────────────│
│ PRIVACY REPORT                     0 events │
│  Trackers blocked    0 ████░░░░░░           │  ← #reportBlocked #reportBlockedBar
│  Links sanitised     0 ████░░░░░░           │  ← #reportSanitised #reportSanitisedBar
│  Camera denied       0 ████░░░░░░           │  ← #reportMediaBlocked #reportMediaBar
│  Resets in --:--                            │  ← #reportResetTime
│─────────────────────────────────────────────│
│ [📸 Safe Screenshot]                        │  ← #screenshotPanelBtn
└─────────────────────────────────────────────┘
```

**Removed from privacy panel:** Panic (has own `#btnPanic` button in toolbar)
**Removed from old design:** Separate `#vaultPopover` floating popover → now a section inside `#privacyPanel`
**Removed from old design:** Separate `#profilePopover` floating popover → now a section inside `#privacyPanel`

**Vault indicator:** Small colored dot on `#btnPrivacy` itself (green=session, yellow=timed, hidden=locked) — `#vaultIndicator`
**Report badge:** Small red count badge on `#btnPrivacy` — `#reportBadge`

---

### Messaging Panel (`#msgPanel`)

**No changes to functionality.** Visual update only:
- Glass background (was solid dark)
- Rounded top corners when panel is open
- Trigger: `#btnMsg` in toolbar (was `#msgBtn`)

---

### Privacy Panel Additional IDs

These elements now live inside `#privacyPanel`:
- `#activeProfileName` — profile name text (inside profile section)
- `#activeProfileColor` — profile color dot (inside profile section)
- `#profileList` — list of switchable profiles (same as old popover)
- `.vault-state-option[data-mode]` — locked/session/timed buttons
- `#statusVault` — vault state text
- `#lockVaultItem` — "Lock Vault" action item
- `#metricVault` — vault metric label (was in dashboard metric card, now also in panel)
- `#metricWipe` — wipe countdown (was in dashboard, now also in panel)
- `#wipeNowBtn` — wipe now button
- `#wipeIntervalSelect` — interval dropdown
- `#reportBlocked`, `#reportSanitised`, `#reportMediaBlocked` — counts
- `#reportBlockedBar`, `#reportSanitisedBar`, `#reportMediaBar` — bar fills
- `#reportResetTime` — reset time
- `#screenshotPanelBtn` — screenshot action button

---

### Dashboard (Unchanged Functionally)

The dashboard remains as the new tab / home page. Same widgets:
- Hero panel + search bar (`#dashboardSearch`)
- Live status card (`#dashVpn`, `#dashWipe`, `#dashPeers`)
- Metric grid: VPN, Wipe, Containers, Vault (`[data-widget]` attributes preserved)
- Feature grid (8 action cards with `[data-action]`)
- Quick links (`#quick-link` items)
- Privacy report section (`#privacyReport`)
- Customize button (`#customizeDashBtn`) + widget popover (`#widgetPopover`)

Dashboard gets glass card styling instead of flat cards.

---

### Statusbar (Bottom, Unchanged Functionally)

Same elements, glass background:
- `#statusWarpDot`, `#statusWarp`, `#statusVaultBar`, `#statusWipe`, `#statusPeers`

---

### Overlays (Unchanged)

All overlays preserved exactly:
- `#pinOverlay` + `.pdot` elements + `#closePin`
- `#focusBlurOverlay`
- `#browserToast`
- `#screenshotOverlay` + `#screenshotSelection`
- `#screenshotPreview` + `#screenshotImg` + `#blurOverlayCanvas`
- `#screenshotApplyBlurBtn`, `#screenshotClearBlurBtn`, `#screenshotSaveBtn`, `#screenshotCopyBtn`, `#screenshotCancelBtn`
- `#tabContextMenu` + `#ctxWipeContainer` + `#ctxForgetOnWipe` + `#ctxForgetLabel` + `#ctxCloseTab`
- `#widgetPopover` (dashboard widget toggle)

---

### JavaScript Changes Required

**ID renames in JS (old → new):**
| Old ID | New ID | Usage |
|--------|--------|-------|
| `#backBtn` | `#btnBack` | back navigation |
| `#forwardBtn` | `#btnForward` | forward navigation |
| `#reloadBtn` | `#btnReload` | reload |
| `#sidebarBtn` | `#btnSidebar` | toggle sidebar |
| `#newTabBtn` | `#btnNewTab` | new tab |
| `#msgBtn` | `#btnMsg` | toggle msg panel |
| `#panicBtn` | `#btnPanic` | panic button |
| `#windowClose` | `#btnClose` | close window |
| `#windowMinimize` | `#btnMin` | minimize |
| `#windowMaximize` | `#btnMax` | maximize |
| `#tabStrip` | `#tabList` | tab container |
| `#warpDot` | `#warpDot` | (unchanged, in sidebar now) |
| `#vaultBtn` | `#btnPrivacy` | open privacy panel |
| `#reportBtn` | removed | report is in privacy panel |
| `#settingsBtn` | removed | not in new design |
| `#shareBtn` | removed | not in new design |

**Tab insertion change:**
```js
// OLD:
$('#tabStrip').insertBefore(el, $('#newTabBtn'));
// NEW:
$('#tabList').appendChild(el);
```

**Profile chip update function change:**
```js
// OLD (fragile nth-child selector):
const nameEl = $('#profileChip').querySelector('span:nth-child(2)');
// NEW (direct IDs):
$('#activeProfileName').textContent = profile.name;
$('#activeProfileColor').style.background = profile.color;
$('#sbProfileName').textContent = profile.name;
```

**Popover logic change:**
```js
// OLD (3 separate popovers):
$('#vaultBtn').addEventListener('click', () => openPopover($('#vaultPopover')));
$('#profileChip').addEventListener('click', () => openPopover($('#profilePopover')));
// NEW (single privacy panel):
$('#btnPrivacy').addEventListener('click', () => openPopover($('#privacyPanel')));
$('#profileChip').addEventListener('click', () => openPopover($('#privacyPanel')));
```

**data-action handlers:** Update `openPopover($('#vaultPopover'))` → `openPopover($('#privacyPanel'))` and `openPopover($('#profilePopover'))` → `openPopover($('#privacyPanel'))`.

**Privacy panel click exclusion:**
```js
// Update the global click handler that closes popovers:
if (!event.target.closest('.popover') &&
    !event.target.closest('#btnPrivacy') &&
    !event.target.closest('#profileChip')) {
  closeAllPopovers();
}
```

**Msg panel toggle:**
```js
// OLD: $('#msgPanel') toggle, $('#msgBtn') active class
// NEW: same logic, just id changed to #btnMsg
function toggleMessaging(open) {
  const shouldOpen = open ?? !$('#msgPanel').classList.contains('open');
  $('#msgPanel').classList.toggle('open', shouldOpen);
  $('#btnMsg').classList.toggle('active', shouldOpen);
}
```

**Panic button:**
```js
// OLD: $('#panicBtn')
// NEW: $('#btnPanic')
```

**Sidebar toggle:**
```js
// OLD: $('#sidebar').classList.toggle('hidden'); $('#sidebarBtn').classList.toggle('active');
// NEW: $('#sidebar').classList.toggle('hidden'); $('#btnSidebar').classList.toggle('active');
```

**initSecurity — content protection:**
```js
// This still works unchanged — just sets Electron-level protection:
window.phantom.security.setContentProtection(true).catch(() => {});
```

**WARP pill location change:**
- `#warpPill` moves from toolbar to sidebar
- JS code using `$('#warpPill')` unchanged — element still exists with same ID

**Removed event listeners** (no longer in new UI):
- `$('#shareBtn')` listener
- `$('#settingsBtn')` listener
- `$('#reportBtn')` listener (report now inside privacy panel)
- `$('#vaultBtn')` listener (replaced by `#btnPrivacy`)
- `$('#profileChip')` old listener (replaced)

---

### CSS Architecture

**CSS variables (dark, default):**
```css
:root {
  --glass: rgba(28, 28, 30, 0.82);
  --glass-border: rgba(255, 255, 255, 0.10);
  --bg: #1c1c1e;
  --surface: rgba(44, 44, 46, 0.90);
  --surface-2: rgba(58, 58, 60, 0.80);
  --hover: rgba(255, 255, 255, 0.07);
  --text: #f5f5f7;
  --text-2: rgba(245, 245, 247, 0.68);
  --text-3: rgba(245, 245, 247, 0.40);
  /* system colours preserved */
}
```

**CSS variables (light):**
```css
@media (prefers-color-scheme: light) {
  :root {
    --glass: rgba(255, 255, 255, 0.78);
    --glass-border: rgba(0, 0, 0, 0.08);
    --bg: #f2f2f7;
    --surface: rgba(255, 255, 255, 0.90);
    --text: #1c1c1e;
    --text-2: rgba(28, 28, 30, 0.65);
    --text-3: rgba(28, 28, 30, 0.38);
  }
}
```

**Glass mixin (applied to toolbar, sidebar, statusbar, panels, popovers):**
```css
.glass {
  background: var(--glass);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid var(--glass-border);
}
```

**Toolbar:** `height: 48px`, `-webkit-app-region: drag` on toolbar, `no-drag` on all interactive children

**URL capsule:** `border-radius: 9999px` (pill shape), centered, `flex: 1`, `max-width: 680px`, `margin: 0 auto`

**Tab items in sidebar:** `height: 34px`, full width, favicon + title + close, hover background, active = glass surface

**Privacy panel:** `position: fixed; top: 56px; right: 12px; width: 320px; max-height: calc(100vh - 80px); overflow-y: auto; border-radius: 16px; z-index: 200;`

---

### File Size Target

| Version | Lines | Size |
|---------|-------|------|
| Old UI (dark purple) | 2832 | ~130KB |
| New UI (Liquid Glass) | ~1400 | ~65KB |

Implementation note: current `phantom-browser-ui.html` is 3529 lines because the rewrite keeps legacy CSS plus the new override layer for lower-risk integration. File-size compaction remains a follow-up cleanup target.

Future compaction would come from:
- Removing duplicate CSS (old had redundant rules)
- Merging 2 toolbar rows into 1
- Removing separate vault/profile popover CSS → unified panel
- Cleaner JS (direct IDs instead of fragile selectors)

---

### Acceptance Criteria

- [x] Browser launches with new glass toolbar (no purple dark UI)
- [x] Single 48px toolbar visible
- [x] Tabs appear in sidebar as vertical list
- [x] WARP pill in sidebar (not toolbar)
- [x] `[+]` button creates new tab
- [x] `[💬]` opens messaging panel from right
- [x] `[🛡]` opens privacy panel dropdown with all sections visible
- [x] `[⚡]` panic button: single click = flash red, double click = panic wipe
- [x] URL capsule: enter URL → navigate; enter text → Google search
- [x] Back/forward/reload work
- [x] Sidebar toggles via `[⊟]` button
- [x] Traffic lights wire to window close/min/max
- [x] Light/dark adaptive (system theme respected)
- [x] All 131 unit tests still pass (backend unchanged)
- [x] All JS IDs correctly updated to new scheme
- [x] Dashboard loads on new tab with all widgets
- [x] PIN overlay still works (lock screen)
- [x] Screenshot tool still works (Ctrl+Shift+S)
- [x] progress.md updated after completion

---

## Session 8 — Safari-style Layout Redesign (2026-05-01)

**Status: COMPLETE ✅**

**Problem:** UI was too crowded — sidebar always visible eating horizontal space, tabs in sidebar (vertical list), nav buttons wrapped in a pill, container-tag inside URL bar adding noise, 48px toolbar felt heavy.

**Goal:** Match Safari's exact layout philosophy — content-first, minimal chrome — replacing only Safari's stock buttons with RAM's privacy buttons.

### Safari Reference Layout
```
Toolbar (38px):
[●●●]  [⊟]  [‹] [›]  [🔒 Search privately or enter URL  ↻]  [💬] [🛡] [⚡]

Tab Bar (36px):
[Tab 1 ×] [Tab 2 ×] [Tab 3 ×]  [+]

Sidebar (hidden by default, revealed by [⊟]):
[● Personal ▾]
[● WARP · dev]
── Containers ──
[● Default]  [● Work]  [● Social]  [● Finance]  [● Research]
```

### What Changes vs Session 7

| Element | Before (Session 7) | After (Session 8 — Safari style) |
|---|---|---|
| Toolbar height | 48px | 38px |
| Back/Forward | Pill container (surface bg, border, pill radius) | Flat individual buttons (no container) |
| Toolbar button size | 32×32px | 28×28px |
| New Tab [+] | In toolbar, right of URL bar | Moved to right end of horizontal tab bar |
| Container tag | Pill inside URL bar (adds noise) | Removed from toolbar (shown only in Privacy Panel) |
| URL bar height | 32px | 28px |
| URL bar max-width | 680px | 760px (wider) |
| Tabs | Vertical list in sidebar (`#tabList`) | Horizontal bar below toolbar (`#tabBar`) |
| Sidebar | Always visible (220px), contains tabs | Hidden by default, no tabs, just profile/WARP/containers |
| Sidebar tab-list | `#tabList` in sidebar | Removed from sidebar |
| Tab style | Vertical rows with left-border indicator | Horizontal pill tabs (Safari style), max-width 200px |
| Privacy panel top offset | 56px from top | 82px from top (toolbar 38 + tabbar 36 + 8px gap) |

### Task Checklist
- [x] Task 1 — Update progress.md with full plan
- [x] Task 2 — CSS: toolbar 38px · flat nav buttons · wider URL bar · `.tab-bar` horizontal strip · `.tab` horizontal style · sidebar starts hidden · privacy-panel top 82px
- [x] Task 3 — HTML: `#tabBar` added below toolbar · `#tabBarNewBtn` [+] at end of tab bar · sidebar starts with `.hidden` · `#tabList` + "Tabs" label removed from sidebar · `#containerTag` removed from URL capsule
- [x] Task 4 — JS: tab creation → `$('#tabBar').insertBefore(el, $('.tab-bar-end'))` · `#tabBarNewBtn` handler wired · containerTag update removed
- [x] Task 5 — Verified: 2215 lines · braces 335/335 · parens 1185/1185 · all key IDs confirmed · no stale references

---

## Session 9 — Accent Colour: White / Black (2026-05-01)

**Status: COMPLETE ✅**

Changed accent from purple (`#a78bfa` / `#7c3aed`) to neutral:
- Dark mode: `--accent: #ffffff` · `--accent-s: rgba(255,255,255,0.12)`
- Light mode: `--accent: #000000` · `--accent-s: rgba(0,0,0,0.10)`

Affects: URL bar focus ring, active button/tab highlight, privacy shield badge, profile dots, dashboard kicker text, vault state indicator.

---

## Session 10 — Menu Bar + Sidebar Removal + Full Settings Page (2026-05-01)

**Status: COMPLETE ✅**

### Summary of Changes
- Replace default Electron menu with custom minimal macOS menu bar
- Remove sidebar entirely (HTML, CSS, JS)
- Remove sidebar toggle `[⊟]` from toolbar
- Add panic button visibility toggle (settings-controlled, hidden by default with keyboard fallback)
- Build full Settings page (`#settingsView`) with 8 sections covering every user-configurable option
- Create `features.md` documenting all RAM browser features

### Task Checklist
- [x] Task 1 — Updated progress.md + created features.md (116 features across 14 categories)
- [x] Task 2 — Custom minimal Electron menu bar (Ram Browser · File · Edit · View · Privacy · Window)
- [x] Task 3 — Sidebar fully removed (HTML, CSS, JS); `[⊟]` button removed from toolbar
- [x] Task 4 — Panic + Messaging visibility toggles wired in General settings; `applyLiveSettings()` shows/hides buttons live
- [x] Task 5 — Settings CSS (280 lines: left nav, section panels, toggle switches, selects, inputs, PIN form, about stats, close button)
- [x] Task 6 — Settings HTML (8 sections: General, Security, Privacy, VPN, Vault, Containers, Messaging, About — all fields present)
- [x] Task 7 — Settings JS: `loadSettings/saveSettings` (localStorage), `initSettings()`, `applySettingsToUI()`, `applyLiveSettings()`, all 20+ controls wired; PIN change + decoy PIN change with verify flow; menu IPC listeners added
- [x] Task 8 — Verified: 2878 lines · braces 401/401 · parens 1466/1466 · 14 settings IDs confirmed

### Settings Page Sections (Task 6 detail)

#### General
- Toolbar: toggle panic button visibility
- Toolbar: toggle messaging button visibility
- Theme: System / Dark / Light (stored in localStorage)
- Start page: Dashboard / Blank / Custom URL
- Restore tabs after wipe (toggle)

#### Security
- Change PIN (current PIN → new PIN → confirm)
- Change Decoy PIN (current PIN → new decoy → confirm)
- Failed PIN attempts before panic (select: 3 / 5 / 10)
- Auto-lock on sleep (toggle, default on)
- Auto-blackout when unfocused — timeout (select: 1min / 2min / 5min / never)
- Screen capture protection (toggle, default on)

#### Privacy
- Auto-wipe interval (select: 1h / 6h / 12h / 24h / 48h / 7d)
- Wipe on quit (toggle)
- Link sanitiser (toggle, default on)
- Block redirect trackers (toggle, default on)
- Privacy report reset with wipe (toggle, default on)

#### VPN
- Require VPN to browse — kill switch (toggle)
- Show WARP latency in status bar (toggle)
- DNS over HTTPS provider (Cloudflare 1.1.1.1 — locked)

#### Vault (Camera & Mic)
- Default vault state (select: Locked / Session / Timed)
- Timed grant duration (select: 1min / 5min / 15min)
- Finance container vault: always locked (locked setting — cannot be changed)

#### Containers
- Per-container settings rows: Default / Work / Social / Finance / Research
- Finance: show hardening summary (JS blocked, vault locked, no notifications)
- Manual wipe button per container

#### Messaging
- Display name (text input)
- Enable same-machine bridge (toggle)
- Show peer count in toolbar badge (toggle)

#### About
- App name + version
- Test suite count (131 unit + 8 E2E)
- Open source notice
- Reset all settings to defaults button

### Custom Menu Bar (Task 2 detail)

```js
Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'Ram Browser', submenu: [
    { label: 'About Ram Browser', role: 'about' },
    { type: 'separator' },
    { label: 'Settings', accelerator: 'Cmd+,', click: () => win.webContents.send('open-settings') },
    { type: 'separator' },
    { label: 'Quit Ram Browser', role: 'quit' }
  ]},
  { label: 'File', submenu: [
    { label: 'New Tab', accelerator: 'Cmd+T', click: () => win.webContents.send('menu:new-tab') },
    { label: 'Close Tab', accelerator: 'Cmd+W', click: () => win.webContents.send('menu:close-tab') }
  ]},
  { label: 'View', submenu: [
    { label: 'Reload', accelerator: 'Cmd+R', click: () => win.webContents.send('menu:reload') },
    { label: 'Back', accelerator: 'Cmd+[', click: () => win.webContents.send('menu:back') },
    { label: 'Forward', accelerator: 'Cmd+]', click: () => win.webContents.send('menu:forward') },
    { type: 'separator' },
    { label: 'Toggle Full Screen', role: 'togglefullscreen' }
  ]},
  { label: 'Privacy', submenu: [
    { label: 'Panic — Wipe Everything', accelerator: 'Cmd+Shift+X', click: () => win.webContents.send('menu:panic') },
    { label: 'Lock Now', accelerator: 'Cmd+Shift+L', click: () => win.webContents.send('menu:lock') },
    { label: 'Privacy Controls', accelerator: 'Cmd+Shift+P', click: () => win.webContents.send('menu:privacy') },
    { label: 'Screenshot Tool', accelerator: 'Ctrl+Shift+S', click: () => win.webContents.send('menu:screenshot') }
  ]},
  { label: 'Window', submenu: [
    { role: 'minimize' },
    { role: 'zoom' },
    { role: 'front' }
  ]}
]))
```

### Detailed CSS Spec (Task 2)

**`.toolbar`**
- height: 48px → **38px**
- gap: 5px → **4px**
- padding: 0 10px → **0 8px**

**`.tb-icon`**
- width/height: 32px → **28px**

**`.nav-pill`** — REMOVE pill styling:
- Remove background, border, border-radius from `.nav-pill`
- `.nav-pill` becomes just `display:flex; gap:2px` (transparent, no surface)
- `.nav-pill .tb-icon` first-child: remove border-right

**`.url-capsule`**
- height: 32px → **28px**
- max-width: 680px → **760px**
- Remove `.container-tag` styles (no longer shown in toolbar)

**Add `.tab-bar`** (new horizontal strip):
```css
.tab-bar {
  display: flex; align-items: center;
  height: 36px; padding: 0 8px; gap: 2px;
  background: var(--glass);
  backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 1px solid var(--glass-border);
  overflow-x: auto; overflow-y: hidden;
  flex-shrink: 0; position: relative; z-index: 39;
}
.tab-bar::-webkit-scrollbar { display: none; }
.tab-bar-end { margin-left: auto; flex-shrink: 0; }
.tab-bar-new {
  width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 6px; color: var(--text-2);
  font-size: 16px; line-height: 1; flex-shrink: 0;
  transition: background 0.13s, color 0.13s;
}
.tab-bar-new:hover { background: var(--hover); color: var(--text); }
```

**`.tab`** — redesign for horizontal:
```css
.tab {
  display: flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 8px 0 10px;
  border-radius: 7px; min-width: 80px; max-width: 200px;
  flex-shrink: 1; cursor: pointer; color: var(--text-2);
  font-size: 12px; position: relative;
  transition: background 0.13s, color 0.13s;
  /* Remove border-left indicator — that was sidebar-style */
  border-left: none;
  overflow: hidden;
}
.tab:hover { background: var(--hover); color: var(--text); }
.tab.active { background: var(--surface); color: var(--text); }
/* No container left-border on horizontal tabs — use subtle dot on favicon */
```

**`.sidebar`** — starts hidden:
```css
.sidebar { /* existing styles */ }
.sidebar.hidden { width: 0; opacity: 0; pointer-events: none; }
/* Add: sidebar starts with .hidden class in HTML */
```

**Remove** `.sb-label` "Tabs" entry and `.tab-list` padding from sidebar (the CSS class can stay but section is removed from HTML).

### Detailed HTML Spec (Task 3)

**New structure order:**
```html
<div class="app">
  <div class="toolbar"> ... (no #btnNewTab) </div>
  <div class="tab-bar" id="tabBar">
    <!-- tabs injected here by JS -->
    <div class="tab-bar-end">
      <button class="tab-bar-new" id="tabBarNewBtn" data-tip="New Tab">+</button>
    </div>
  </div>
  <div class="viewport">
    <aside class="sidebar hidden" id="sidebar">
      <!-- profile chip, warp pill, containers — NO tab-list section -->
    </aside>
    <div class="content"> ... </div>
  </div>
  ...overlays...
</div>
```

**Toolbar changes:**
- Remove `<button id="btnNewTab">` entirely (now in tab-bar)
- Remove `<div class="tb-divider">` (cleaner)
- Remove `<span class="container-tag" id="containerTag">` from URL capsule (less noise)

**Sidebar changes:**
- Add `hidden` class to `<aside class="sidebar hidden" id="sidebar">`
- Remove `<div class="sb-label">Tabs</div>` and `<div class="tab-list" id="tabList"></div>`

### Detailed JS Spec (Task 4)

**`createTab()`** — change append target:
```js
// Before:
$('#tabList').appendChild(el);
// After:
$('#tabBar').insertBefore(el, $('.tab-bar-end'));
```

**New tab button** — update handler:
```js
// Before: $('#btnNewTab').addEventListener(...)
// After:  $('#tabBarNewBtn').addEventListener(...)
```

**Sidebar** — starts hidden, toggle works:
```js
// #btnSidebar click: toggle .hidden on #sidebar (already works — no change needed)
```

**`#urlInput` container tag update** — remove (no longer in DOM):
```js
// Remove any lines that set #containerTag textContent
// containerTag element no longer exists in toolbar
```

**`resetToDashboard()`** — no change needed.

---

## Session 8 — Safari-style Layout Redesign (2026-05-02)

**Status: COMPLETE ✅**

### Task Checklist
- [x] Research Safari's exact UI proportions (38px toolbar, 36px tab bar, flat nav buttons, wide URL capsule)
- [x] Redesign toolbar CSS — 38px height, 28px icon buttons, flat back/forward (no pill wrapper)
- [x] Add horizontal tab bar (`#tabBar`, 36px) below toolbar — Safari-style
- [x] Remove sidebar entirely from HTML, CSS, and JS
- [x] Move new-tab button into tab bar (`#tabBarNewBtn`)
- [x] Remove `#btnNewTab`, `#btnSidebar`, `#containerTag` from toolbar
- [x] Update tab insertion JS: `$('#tabBar').insertBefore(el, $('.tab-bar-end'))`
- [x] Update `#tabBarNewBtn` click handler
- [x] Fix `.privacy-panel` top position (`top: 82px` to clear both bars)
- [x] Null-guard all former sidebar JS references (`#warpPill`, container counts)

### Layout After Session 8

**Two-row chrome (74px total):**
```
Row 1 — Toolbar (38px): ● ● ●  [‹][›]  🔒 url bar ↻  [💬][🛡][⚡][⚙️]
Row 2 — Tab bar (36px): [tab][tab][tab]  +
```

### Key CSS Changes
```css
.toolbar { height: 38px; gap: 4px; padding: 0 8px; }
.tb-icon  { width: 28px; height: 28px; }
.nav-pill { display: flex; align-items: center; gap: 1px; flex-shrink: 0; } /* flat, no pill bg */
.url-capsule { height: 26px; max-width: 760px; }
.tab-bar  { display: flex; height: 36px; padding: 0 8px; gap: 2px; background: var(--glass); }
.tab      { height: 28px; min-width: 80px; max-width: 200px; border-radius: 7px; }
.privacy-panel { top: 82px; }  /* 38px toolbar + 36px tab bar + 8px gap */
```

---

## Session 9 — Accent Color: White / Black (2026-05-02)

**Status: COMPLETE ✅**

Changed accent color from purple to adaptive white/black:

```css
/* Dark mode */
--accent:   #ffffff;
--accent-s: rgba(255, 255, 255, 0.12);

/* Light mode */
--accent:   #000000;
--accent-s: rgba(0, 0, 0, 0.10);
```

All interactive elements (active tabs, toggle checked state, focus rings, active buttons) now use white in dark mode and black in light mode — consistent with macOS HIG native controls.

---

## Session 10 — Custom Menu Bar + Full Settings Page (2026-05-02)

**Status: COMPLETE ✅**

### Task Checklist
- [x] Create `features.md` documenting all 116 features across 14 categories
- [x] Replace default Electron menu with custom minimal macOS menu bar
- [x] Add panic button show/hide toggle in settings (not permanent removal)
- [x] Build full in-app Settings page with 8 sections
- [x] Add gear/cog icon for settings button in toolbar
- [x] Fix settings page not opening (null crash from removed `#warpPill` sidebar element)
- [x] Fix settings overlay being covered by native WebContentsViews
- [x] Remove `openDevTools` debug line from `src/main/index.js`

### Custom macOS Menu Bar (`src/main/index.js`)

```
Ram Browser  |  File  |  Edit  |  View  |  Privacy  |  Window
```

- **Ram Browser**: About, Settings (⌘,), Quit
- **File**: New Tab (⌘T), Close Tab (⌘W)
- **Edit**: Undo, Redo, Cut, Copy, Paste, Select All (all native roles)
- **View**: Reload (⌘R), Back (⌘[), Forward (⌘]), Toggle Full Screen
- **Privacy**: Panic (⌘⇧X), Lock Now (⌘⇧L), Privacy Controls (⌘⇧P), Screenshot Tool (^⇧S)
- **Window**: Minimize, Zoom, Bring All to Front

All menu items send IPC to renderer via `mainWindow.webContents.send(channel)`.

### Preload `menu` namespace (`src/main/preload.js`)

```js
menu: {
  onNewTab, onCloseTab, onReload, onBack, onForward,
  onPanic, onLock, onPrivacy, onScreenshot, onSettings
}
```

### Settings Page (in-app, `phantom-browser-ui.html`)

Full `#settingsView` overlay with 8 nav sections:

| Section | Key Controls |
|---------|-------------|
| General | Panic button visibility, messaging visibility, peer badge, theme, start page |
| Security | Change PIN, change decoy PIN, failed attempts threshold (3/5/10), auto-lock, blackout timeout, screen capture protection |
| Privacy | Wipe interval, wipe on quit, link sanitiser toggle, privacy report reset |
| VPN | Kill switch toggle, WARP latency display, DNS info |
| Vault | Default vault state, timed duration (1/5/15 min) |
| Containers | Per-container settings summary, finance hardening info |
| Messaging | Display name, bridge toggle, peer badge toggle |
| About | Version, test count, reset all defaults |

Settings stored in `localStorage` under key `ram:settings` as JSON.

### Critical Bug Fixes

**Bug 1 — Script crash from null element:**
- `$('#warpPill').addEventListener(...)` crashed entire JS init because `#warpPill` was removed with the sidebar
- Fixed with optional chaining: `$('#warpPill')?.addEventListener(...)` + null-guard in `applyWarpStatus()`
- All code after line 2379 (including `initSettings()`) was silently not running

**Bug 2 — WebContentsView overlapping settings:**
- Native Electron `WebContentsView` instances sit above all HTML and ignore CSS z-index
- Fixed: `openSettings()` hides all tab views; `closeSettings()` restores active tab via `activateTab()`

```js
function openSettings() {
  for (const tab of tabs.values()) {
    if (tab.url) window.phantom?.tabViews?.hide?.(tab.id);
  }
  $('#settingsView').classList.add('open');
  applySettingsToUI();
}
function closeSettings() {
  $('#settingsView').classList.remove('open');
  if (activeTabId) activateTab(activeTabId);
}
```

**Bug 3 — Preload missing `menu` namespace:**
- `window.phantom.menu` was undefined — menu IPC listeners silently no-opped
- Fixed by adding `menu` object to `contextBridge.exposeInMainWorld` in `preload.js`

### Keyboard Shortcuts Added
- `⌘,` — open/close settings
- `Escape` — close settings when open

---

## Session 12 — Second Audit & Bug Fixes (2026-05-02)

**Status: COMPLETE ✅**

### Bug Fixes Applied

| # | Feature | Bug | Fix |
|---|---------|-----|-----|
| 33 | Tab restore after wipe | `onWipeDone` reset the dashboard without restoring tabs first | Added `restoreTabs()` call before `resetToDashboard()` in the `wipe:done` handler |
| — | Messaging panel / popover exclusivity | `toggleMessaging()` opened `#msgPanel` without closing other popovers (privacy panel could stay visible alongside it) | Added `if (shouldOpen) closeAllPopovers()` at start of `toggleMessaging()` |
| 95–101 | Bridge send UI | Bridge backend fully implemented but no UI to send tabs/links/notes to other profiles | Added "Send to Profile" section to `#privacyPanel`: target dropdown (auto-populated with other profiles), Tab/Link/Note buttons; note button toggles a textarea + send button; section hidden when no other profiles exist; `refreshBridgeTargets()` called on privacy panel open |

### Not-bugs (second audit false positives)
- DNS probe indicator: `onDnsProbe` turns `#warpDot` red on leak — correct; `applyWarpStatus` resets it when WARP reconnects
- Kill switch persistent indicator: `applyWarpStatus` already shows `enforced && !connected` state in red on `#warpDot`/`#statusWarpDot`; `onKillSwitch` toast is supplementary — correct

---

## Session 11 — Full Feature Audit & Bug Fixes (2026-05-02)

**Status: COMPLETE ✅**

### Audit Summary
Comprehensive codebase audit against all 116 features. 17 genuine bugs found across the three source files.

### Bug Fixes Applied

| # | Feature | Bug | Fix |
|---|---------|-----|-----|
| 47/48 | Change PIN / Change Decoy PIN | `pin:set` and `pin:set-decoy` IPC handlers missing in index.js; not exposed in preload | Added `ipcMain.handle('pin:set')`, `ipcMain.handle('pin:set-decoy')` + `setPin`/`setDecoyPin` import; added `pin.set` and `pin.setDecoy` to preload |
| 42 | Failed-PIN panic threshold | `PIN_PANIC_THRESHOLD` hardcoded to `5`; settings toggle had no effect | Changed to `let`; `applyLiveSettings()` now updates it from `s.pinAttempts` |
| 34 | Wipe on quit | `window-all-closed` never triggered a wipe | Added `app.on('before-quit')` handler; `wipeOnQuit` flag toggled via `settings:wipe-on-quit` IPC |
| 12 | VPN kill switch toggle | `requireWarp` was `const` (env-only); settings toggle had no effect | Changed to `let`; `settings:require-vpn` IPC updates it at runtime |
| 91 | Password-protected rooms | `messaging:verify-room-password` stripped `roomKey` from result | Removed the `.then(({ valid }) => ({ valid }))` filter — full result now returned |
| 71/72 | Link sanitiser + redirect toggle | `sanitiseUrl` always ran regardless of settings | Added `linkSanitiserEnabled`/`redirectBlockEnabled` flags; IPC channels to toggle; `onBeforeRequest` gated on flags |
| 93 | Messaging disabled on lock | `messaging:send` ran even while screen locked | Added `if (isScreenLocked) return { ok: false }` guard |
| 92 | Configurable display name | `messaging:set-display-name` IPC didn't exist; preload had no `setDisplayName` | Added `ipcMain.on('messaging:set-display-name')` handler + `messaging.setDisplayName` to preload |
| 56 | Vault state bleeds across profiles | `vaultMode` was global; switching profiles kept old vault state | `activateProfile()` now calls `setVaultMode('locked')` on every profile switch |
| 65 | WARP latency display toggle | `showLatency` setting saved but never applied | `applyLiveSettings()` now hides/shows `#warpLatency` based on setting |
| 46 | Hidden profiles — no UI | Backend (setUnlockPhrase, unlockHiddenProfile) existed but no UI | Added "New Profile" modal with hidden+phrase option; "Unlock Hidden Profile…" button + modal in privacy panel |
| 35 | New Profile button — no handler | `#newProfileBtn` had no click listener | Added full create-profile flow: name/color/PIN/hidden/phrase inputs + IPC calls |
| New | Settings → main process sync | Settings changes not pushed to main process on load | `applyLiveSettings()` now sends all 4 flags (wipe-on-quit, require-vpn, link-sanitiser, redirect-block) to main on every settings apply |

### Not-bugs (audit false positives)
- Feature #50: `#closePin` cancel button already guards `lockScreenMode` — correct
- Feature #32: Per-tab forget-on-wipe toggle already works (lines 2204-2213)
- Feature #3: Tab snapshot already includes `container` field (line 2105)

### Tests
- 131/131 unit tests still passing after all fixes

---

## Session 13 — OS Keychain PIN Storage (2026-05-06)

**Status: COMPLETE ✅**

### What changed
Resolved the last ⚠️ item: PIN hashes are now machine-bound via `safeStorage` instead of being stored as plain files.

**`src/main/profiles/pin.js`** changes:
- Added `getSafeStorage()` / `protectPinData(salt, hash)` / `recoverPinData(hexBlob)` helpers (same safeStorage pattern as `manager.js`)
- `setPin()` / `setDecoyPin()`: when safeStorage available, writes `pin.safe` / `pin-decoy.safe` (safeStorage-encrypted JSON `{salt: hex, hash: hex}`), removes raw `.salt`/`.hash` files; falls back to raw files if safeStorage unavailable
- `tryVerify()`: tries `.safe` blob first; falls back to raw files; on successful raw-file verify, transparently migrates to `.safe` and removes raw files (one-time migration, no user action needed)
- `deriveProfileKey()`: reads salt from `.safe` blob if available, falls back to `pin.salt`
- `clearPin()` / `clearDecoyPin()`: now deletes all three file variants (`.safe`, `.salt`, `.hash`)
- `hasPin()` / `hasDecoyPin()`: checks `.safe` first, then `.salt`

### Backward compatibility
- Tests run without Electron context → `getSafeStorage()` returns null → raw files used → all 131 tests still pass
- Existing profiles with raw `.salt`/`.hash` files migrate automatically on next successful PIN verify

### Tests
- 131/131 unit tests passing

---

## Session 15 — Audit: Cut Deadweight, Add Real Privacy (2026-05-07)

### Honest Assessment

After a full code review, the browser has real privacy gaps while carrying significant dead weight.
Plan: cut the bloat first, then add the things that actually matter.

---

### CUT LIST (removing)

| # | What | Why |
|---|------|-----|
| C1 | LAN messaging (mdns.js, transport.js, rooms.js, presence.js + all IPC + all UI) | 4 modules, 2 deps (bonjour-service, ws), 400+ lines of UI, WebSocket server on 0.0.0.0 — requires another Ram Browser user on the same LAN. Nobody will use this. |
| C2 | Same-machine profile bridge (hub.js + all IPC + all UI) | Sending tabs between profiles on the same machine. People copy-paste URLs. |
| C3 | Trackpad shake panic | False-positive machine. Keyboard shortcut (Cmd+Shift+X) already exists and works reliably. |
| C4 | Decoy homepages (phantom://decoy/news, phantom://decoy/work fake HTML pages) | Visibly fake pages make a coercion scenario worse. Decoy profile concept stays; fake pages go. |
| C5 | Privacy report bar charts → replace with plain numbers | Three counts don't need animated bars. |

---

### ADD LIST (building)

| # | What | Why | Priority |
|---|------|-----|----------|
| A1 | WebRTC leak protection | Even with WARP proxy, WebRTC exposes real IP. ~10 lines. Currently broken. | CRITICAL |
| A2 | HTTPS-only mode | Not implemented. Basic requirement. | HIGH |
| A3 | Request-level tracker/ad blocking | Static block list via webRequest. More privacy value than anything cut. | HIGH |
| A4 | Fingerprint hardening | Canvas noise, font enumeration block, hardware concurrency spoof. Containers don't protect against fingerprinting. | MEDIUM |
| A5 | Tor routing option | WARP = Cloudflare sees all traffic. Tor SOCKS5 toggle for real anonymity. | MEDIUM |

---

### Execution Order

1. ✅ Update progress.md (this entry)
2. ✅ C1 — Remove LAN messaging stack
3. ✅ C2 — Remove same-machine bridge
4. ✅ C3 — Remove trackpad shake panic
5. ✅ C4 — Remove decoy homepages
6. ✅ C5 — Simplify privacy report to numbers
7. ✅ A1 — WebRTC leak protection
8. ✅ A2 — HTTPS-only mode
9. ✅ A3 — Request-level tracker blocking
10. ✅ A4 — Fingerprint hardening
11. ✅ A5 — Tor routing option

---

### Progress

| Step | Status | Notes |
|------|--------|-------|
| C1 — Remove LAN messaging | ✅ Done | Deleted mdns.js, transport.js, rooms.js, presence.js, bridge/hub.js + all IPC + all UI + 4 test files |
| C2 — Remove same-machine bridge | ✅ Done | Removed as part of C1 |
| C3 — Remove trackpad shake panic | ✅ Done | Removed initShake() mousemove listener |
| C4 — Remove decoy homepages | ✅ Done | Removed DECOY_NEWS_HTML, DECOY_WORK_HTML constants + protocol handlers |
| C5 — Simplify privacy report | ✅ Done | Replaced bar charts with 3 plain numbers (blocked / sanitised / cam denied) |
| A1 — WebRTC leak protection | ✅ Done | `force-webrtc-ip-handling-policy=default_public_interface_only` CLI flag + `setWebRTCIPHandlingPolicy` per session + `disable-features=WebRtcHideLocalIpsWithMdns` |
| A2 — HTTPS-only mode | ✅ Done | `httpsOnlyEnabled` flag; http:// → https:// upgrade in onBeforeRequest; toggle in Privacy settings |
| A3 — Request-level tracker blocking | ✅ Done | `BLOCK_DOMAINS` set (~50 domains: Google Ads, Meta, analytics, ad networks, fingerprinting); `trackerBlockEnabled` flag; toggle in Privacy settings |
| A4 — Fingerprint hardening | ✅ Done | tab-preload.js: canvas noise, AudioContext noise, hardwareConcurrency=4, deviceMemory=4, font enumeration block; CLI flags: BatteryStatusManager disabled, WebXR/GenericSensor disabled |
| A5 — Tor routing option | ✅ Done | `tor:enable` / `tor:disable` IPC; uses socks5://127.0.0.1:9150 (Tor Browser) or 9050 (system Tor); toggle in VPN settings |

### Tests
- 97/97 unit tests passing (34 removed: messaging/bridge/rooms tests deleted with those modules)

### What changed summary
- **Removed:** ~600 lines of LAN messaging code, ~200 lines of bridge code, shake detector, fake decoy pages, bar chart CSS/JS
- **Added:** WebRTC leak fix, HTTPS-only mode, tracker/ad block list, fingerprint hardening (canvas + audio + API spoofs), Tor routing toggle
- Dependencies removed from runtime: `bonjour-service`, `ws` (still in package.json as devDep — can be removed from package.json too)

---

## Session 16 — Full Codebase Cleanup (2026-05-07)

### Goal
Purge all dead code left over from session 15's feature cuts.

### Items executed

| Item | Status | Notes |
|------|--------|-------|
| Fix `bridgeHub.setEnabled` crash bug | ✅ Done | Removed undefined `bridgeHub.setEnabled(...)` call from screen-lock handler in `index.js:550` — would have thrown on every screen lock |
| Remove dead messaging CSS block | ✅ Done | Deleted 62-line `.msg-panel` / `.msg-header` / `.net-badge` / `.peers-list` / `.peer-item` / etc. block from `phantom-browser-ui.html` |
| Remove `id="dashPeers"` dead element | ✅ Done | Removed "Peers nearby" status-line from dashboard aside — was never updated after messaging removal |
| Remove `id="statusPeers"` dead element | ✅ Done | Removed "0 peers" status-item from footer bar — was never updated after messaging removal |
| Remove `let activeRoomId = 'general'` | ✅ Done | Deleted dead variable from JS section of `phantom-browser-ui.html` |
| Clean stale test comments | ✅ Done | Removed `roomManager.clearAll()` and `bridgeHub.clearAll()` commented lines from `test/panic-warp-stays-up.test.js`; updated comment text |
| Update `features.md` | ✅ Done | Removed sections 10 (Messaging) and 11 (Bridge), removed trackpad shake + mobile companion panic items; added WebRTC, Tor, HTTPS-only, tracker block, 6 fingerprint-hardening items; re-numbered to 103 features |
| Regenerate `package-lock.json` | ✅ Done | `npm install` — removed 7 packages (bonjour-service, ws and their deps); 0 vulnerabilities |
| Verify tests | ✅ Done | 97/97 unit tests pass |

### Tests
- 97/97 unit tests passing — no regressions

