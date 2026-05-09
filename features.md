# Ram Browser — Feature Reference

> Privacy-first Electron browser. No big tech. No telemetry. No shortcuts.

---

## 1. Core Browser

| # | Feature | Status |
|---|---------|--------|
| 1 | Electron + Chromium shell (frameless, custom chrome) | ✅ |
| 2 | WebContentsView-based tab management | ✅ |
| 3 | Tab open / close / switch / restore after wipe | ✅ |
| 4 | URL bar with Google search fallback | ✅ |
| 5 | Back / Forward / Reload | ✅ |
| 6 | New-window requests → new tab | ✅ |
| 7 | Horizontal tab bar (Safari-style) | ✅ |
| 8 | Custom minimal macOS menu bar | ✅ |
| 9 | Settings page (full in-app preferences) | ✅ |

---

## 2. VPN & Network

| # | Feature | Status |
|---|---------|--------|
| 10 | Cloudflare WARP auto-register + connect on launch | ✅ |
| 11 | WARP proxy mode on port 40000 | ✅ |
| 12 | VPN kill switch — all requests cancelled if WARP drops | ✅ |
| 13 | DNS over HTTPS via Cloudflare 1.1.1.1 (baked in) | ✅ |
| 14 | DNS leak verification on launch | ✅ |
| 15 | WARP status polling every 3s (latency, region, state) | ✅ |
| 16 | WARP daemon crash auto-restart (max 3 attempts, then kill switch) | ✅ |
| 17 | Auto-reconnect on network change / machine wake | ✅ |
| 18 | Browser hidden until WARP confirms connected | ✅ |
| 19 | AutofillServerCommunication disabled at Chromium level | ✅ |
| 20 | Spellchecker disabled (no keystrokes sent to server) | ✅ |
| 21 | WebRTC leak protection (CLI flag + per-session policy) | ✅ |
| 22 | Tor routing option (SOCKS5 via Tor Browser or system Tor) | ✅ |

---

## 3. Panic & Wipe

| # | Feature | Status |
|---|---------|--------|
| 23 | Panic button — double-click wipes everything in <1s | ✅ |
| 24 | Keyboard shortcut panic (Cmd+Shift+X) | ✅ |
| 25 | Panic clears: storage, tabs, clipboard, UI | ✅ |
| 26 | WARP stays connected through panic (verified invariant) | ✅ |
| 27 | Panic button visibility toggle (configurable in settings) | ✅ |
| 28 | 24-hour auto-wipe cycle (configurable 1h – 7d) | ✅ |
| 29 | Wipe countdown ticker in UI | ✅ |
| 30 | Manual "Wipe Now" button | ✅ |
| 31 | Encrypted tab snapshot before wipe, restore after | ✅ |
| 32 | Per-tab "Forget on wipe" option | ✅ |
| 33 | Per-container manual wipe | ✅ |
| 34 | Wipe on quit (configurable) | ✅ |

---

## 4. Profiles & Encryption

| # | Feature | Status |
|---|---------|--------|
| 35 | Multi-profile system (create, switch, delete) | ✅ |
| 36 | UUID-based anonymous folder names on disk | ✅ |
| 37 | AES-256-GCM encrypted profile storage | ✅ |
| 38 | PIN system — set, verify, clear | ✅ |
| 39 | Argon2id PIN hashing (64MB RAM cost, 3 passes, 4 threads) | ✅ |
| 40 | Decoy PIN — shows fake clean profile under duress | ✅ |
| 41 | Ghost mode cascade — wipe real + load decoy + clear everything | ✅ |
| 42 | Failed-PIN panic (configurable: 3 / 5 / 10 attempts) | ✅ |
| 43 | PIN lockout timer (60s × 2^attempts, capped at 1h) | ✅ |
| 44 | OS keychain key protection (macOS Keychain / DPAPI / libsecret) | ✅ |
| 45 | Machine-bound encryption (keys can't be copied and cracked offline) | ✅ |
| 46 | Hidden profiles with unlock-phrase | ✅ |
| 47 | Change PIN from settings | ✅ |
| 48 | Change Decoy PIN from settings | ✅ |

---

## 5. Lock & Security

| # | Feature | Status |
|---|---------|--------|
| 49 | Auto-lock on sleep / screen lock | ✅ |
| 50 | PIN overlay on lock — can't dismiss without correct PIN | ✅ |
| 51 | All web content hidden on lock | ✅ |
| 52 | Focus-loss blur overlay (privacy screen on window blur) | ✅ |
| 53 | Auto-blackout after N minutes unfocused (configurable) | ✅ |
| 54 | Screen capture protection (setContentProtection) | ✅ |
| 55 | Windows SetWindowDisplayAffinity excludes from capture | ✅ |

---

## 6. Camera & Mic Vault

| # | Feature | Status |
|---|---------|--------|
| 56 | Vault states: Locked / Session / Timed | ✅ |
| 57 | Locked — hard block at permission handler, no site can request | ✅ |
| 58 | Session — granted until browser closes | ✅ |
| 59 | Timed — auto-revokes after N minutes with countdown | ✅ |
| 60 | Timed duration configurable (1min / 5min / 15min) | ✅ |
| 61 | Finance container: vault permanently locked | ✅ |
| 62 | Vault forced locked on panic and ghost mode | ✅ |
| 63 | Per-origin grant tracking (revoked on tab close) | ✅ |
| 64 | Vault indicator dot in toolbar (green = session, yellow = timed) | ✅ |
| 65 | Default vault state configurable in settings | ✅ |

---

## 7. Session Containers

| # | Feature | Status |
|---|---------|--------|
| 66 | 5 isolated containers: Default, Work, Social, Finance, Research | ✅ |
| 67 | Per-container isolated storage partitions | ✅ |
| 68 | Finance hardening: vault locked + JS blocked + no notifications | ✅ |
| 69 | Right-click tab → Move to container | ✅ |
| 70 | Per-container manual wipe | ✅ |

---

## 8. Privacy Tooling

| # | Feature | Status |
|---|---------|--------|
| 71 | Link sanitiser — strips UTM, fbclid, gclid, HubSpot, referral params | ✅ |
| 72 | Redirect unwrapping (Facebook, Google, LinkedIn, DuckDuckGo) | ✅ |
| 73 | Privacy report — blocked trackers, sanitised links, denied media | ✅ |
| 74 | Privacy report reset on wipe | ✅ |
| 75 | HTTPS-only mode — http:// upgraded to https:// at request level | ✅ |
| 76 | Request-level tracker/ad blocking (~50 domains hardcoded) | ✅ |
| 77 | Canvas fingerprint noise (getImageData + toDataURL patched) | ✅ |
| 78 | AudioContext fingerprint noise (getChannelData patched) | ✅ |
| 79 | hardwareConcurrency spoofed → 4 | ✅ |
| 80 | deviceMemory spoofed → 4 | ✅ |
| 81 | Font enumeration blocked (only generic families revealed) | ✅ |
| 82 | BatteryStatusManager, WebXR, GenericSensor disabled at Chromium level | ✅ |

---

## 9. Safe Screenshot Tool

| # | Feature | Status |
|---|---------|--------|
| 83 | Keyboard shortcut Ctrl+Shift+S | ✅ |
| 84 | Drag to select region (Enter = full window, Esc = cancel) | ✅ |
| 85 | Auto-redacts URL bar → "Private Browser" | ✅ |
| 86 | Auto-redacts tab titles, WARP latency, notification badges | ✅ |
| 87 | Manual blur boxes over sensitive areas | ✅ |
| 88 | EXIF metadata stripped (pure Node, zero external deps) | ✅ |
| 89 | Save to disk or copy to clipboard | ✅ |

---

## 10. Settings Page

| # | Feature | Status |
|---|---------|--------|
| 90 | General — panic button visibility, theme, start page | ✅ |
| 91 | Security — change PIN, change decoy PIN, failed attempts threshold, auto-lock, blackout timeout, screen capture | ✅ |
| 92 | Privacy — wipe interval, wipe on quit, link sanitiser, HTTPS-only, tracker block, privacy report reset | ✅ |
| 93 | VPN — kill switch toggle, WARP latency display, DNS info, Tor toggle | ✅ |
| 94 | Vault — default state, timed duration | ✅ |
| 95 | Containers — per-container settings, finance hardening summary | ✅ |
| 96 | About — version, test count, reset all defaults | ✅ |

---

## 11. Testing

| # | Feature | Status |
|---|---------|--------|
| 97 | 97 unit tests across 7 test files | ✅ |
| 98 | 8 E2E Playwright tests | ✅ |

---

## 12. Packaging

| # | Feature | Status |
|---|---------|--------|
| 99  | macOS DMG + ZIP | ✅ |
| 100 | Windows NSIS installer | ✅ |
| 101 | Linux AppImage + deb | ✅ |
| 102 | App icon (SVG → PNG 16–512px) | ✅ |
| 103 | GitHub Releases auto-updater | ✅ |

---

*Total: 103 features across 12 categories*
