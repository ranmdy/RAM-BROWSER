# RAM Browser

**[rambrowser.netlify.app](https://rambrowser.netlify.app)** — Landing page

A privacy-first desktop browser built on Electron. Always-on VPN, automatic 24-hour wipe, encrypted profiles, and a hardware-level vault for your camera and mic.

## Features

- **Always-on WARP VPN** — traffic routed through Cloudflare WARP with a kill-switch that cuts the connection if the VPN drops
- **24-hour wipe engine** — all browsing data (cache, cookies, history, sessions) wiped on a configurable timer, automatically
- **Encrypted profiles** — each profile is Argon2id-encrypted with a PIN; lose the PIN, lose the profile — by design
- **Ghost mode** — decoy PIN opens a clean empty profile; real profile stays hidden
- **5-container isolation** — Default, Work, Social, Finance, Research — storage, cookies, and identity partitioned per container
- **Vault** — camera, microphone, location, clipboard, and notifications denied by default; granted per-site, per-session, then forgotten
- **Panic wipe** — one shortcut clears everything instantly
- **No accounts, no cloud sync, no telemetry** — ever

## Download

Get the latest release from the [Releases](https://github.com/ranmdy/RAM-BROWSER/releases) page.

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Ram Browser-x.x.x-arm64.dmg` |
| macOS (Intel) | `Ram Browser-x.x.x.dmg` |

## Build from source

```bash
# Install dependencies
npm install

# Run in development
npm start

# Build macOS DMG
PYTHON=/usr/bin/python3 npm run dist:mac
```

**Requirements:** Node.js 18+, macOS 12+

## Architecture

```
src/
  main/
    index.js              # Electron main process, IPC handlers
    preload.js            # Context bridge (renderer ↔ main)
    privacy/
      wipe-engine.js      # 24-hour wipe timer
      tab-snapshot.js     # Tab session persistence
    profiles/
      manager.js          # Profile CRUD, ghost mode
      encryption.js       # Argon2id key derivation
      pin.js              # PIN verify / set / decoy
    security/
      warp-supervisor.js  # WARP VPN process management
      screenshot.js       # Screen capture
      exif-strip.js       # EXIF metadata removal
  shared/
    link-sanitiser.js     # URL tracking param stripping
phantom-browser-ui.html   # Renderer — full browser UI
landing/                  # Landing page (GitHub Pages)
```

## License

Private — all rights reserved.
