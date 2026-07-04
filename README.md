# RAM Browser

Desktop browser built on Electron. Routes all traffic through Cloudflare WARP, wipes browsing data on a 24-hour timer, and keeps profiles encrypted at rest with Argon2id.

→ [rambrowser.netlify.app](https://rambrowser.netlify.app)

## What it does

- WARP VPN on by default. Kill-switch cuts traffic if the tunnel drops.
- 24h wipe. Cache, cookies, history, sessions — gone on a timer. Configurable from 1h to 7 days.
- Encrypted profiles with a PIN. Argon2id-derived key. No PIN, no data.
- Decoy PIN that opens a clean profile. Real profile stays hidden.
- Five isolated containers (Default, Work, Social, Finance, Research). Nothing crosses between them.
- Camera, mic, location off by default. Granted per-site, per-session, then revoked.
- Panic shortcut (`Cmd+Shift+X`) wipes everything immediately.
- Fingerprint hardening — canvas noise, audio noise, spoofed hardware concurrency and memory, font enumeration blocked.
- Tracker/ad blocking via request interception (~50 domains).
- HTTPS-only mode, WebRTC leak protection, optional Tor routing.
- Multi-window: `Cmd+N` opens a new window; File → New Profile Window opens a PIN-less profile in its own window with fully isolated, in-memory sessions.
- Minimal start page — just search and a one-line privacy status; all controls live in the shield panel and Settings.
- Native macOS window chrome: real traffic lights with Move & Resize / Fill & Arrange tiling support.

## Install

[Releases →](https://github.com/ranmdy/RAM-BROWSER/releases)

macOS Apple Silicon: `Ram Browser-0.1.0-arm64.dmg`
macOS Intel: `Ram Browser-0.1.0.dmg`

Open the DMG, drag to Applications.

## Build

Requires Node 18+, macOS 12+.

```sh
npm install
npm start                              # dev
PYTHON=/usr/bin/python3 npm run dist:mac  # package (needs system Python for argon2)
```

## Structure

```
src/main/
  index.js              # main process, all IPC handlers
  preload.js            # context bridge
  privacy/
    wipe-engine.js
    tab-snapshot.js
  profiles/
    manager.js          # CRUD, ghost mode, OS keychain
    encryption.js       # AES-256-GCM
    pin.js              # Argon2id, decoy PIN
  security/
    warp-supervisor.js  # WARP daemon, auto-restart, kill-switch
    screenshot.js
    exif-strip.js
  shared/
    link-sanitiser.js   # strips utm_*, fbclid, redirect wrappers
phantom-browser-ui.html # entire renderer
docs/                   # landing page
```

## License

Private.
