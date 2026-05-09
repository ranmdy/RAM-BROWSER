# Phantom Browser

> **Privacy-First Desktop Browser · Always On · Zero Trace**

A complete technical specification and implementation guide for Phantom Browser — a desktop privacy browser built on Electron with a Chromium rendering engine, designed around a single principle: *what you do in this browser leaves no trace unless you explicitly choose otherwise.*

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [System Architecture](#2-system-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Project Structure](#4-project-structure)
5. [UI Design — Safari-Inspired](#5-ui-design--safari-inspired)
6. [Feature Specifications](#6-feature-specifications)
   - 6.1 [Always-On VPN (Cloudflare WARP)](#61-always-on-vpn-cloudflare-warp)
   - 6.2 [24-Hour Wipe Cycle](#62-24-hour-wipe-cycle)
   - 6.3 [Multi-Profile System](#63-multi-profile-system)
   - 6.4 [PIN Lock & Decoy System](#64-pin-lock--decoy-system)
   - 6.5 [Session Containers](#65-session-containers)
   - 6.6 [Camera & Microphone Vault](#66-camera--microphone-vault)
   - 6.7 [Screenshot Protection](#67-screenshot-protection)
   - 6.8 [Link Sanitiser](#68-link-sanitiser)
   - 6.9 [Panic Button](#69-panic-button)
   - 6.10 [Safe Screenshot Tool](#610-safe-screenshot-tool)
   - 6.11 [Custom Homepage & Dashboard](#611-custom-homepage--dashboard)
   - 6.12 [Local Network Messaging](#612-local-network-messaging)
   - 6.13 [Same-Machine Profile Bridge](#613-same-machine-profile-bridge)
   - 6.14 [Notifications](#614-notifications)
7. [Feature Interaction Map](#7-feature-interaction-map)
8. [Build Roadmap](#8-build-roadmap)
9. [Development Setup](#9-development-setup)
10. [Core Security Principles](#10-core-security-principles)
11. [Infrastructure Cost](#11-infrastructure-cost)

---

## 1. Product Vision

Phantom Browser is built for individuals and organisations that require maximum privacy, operational security, and zero data retention by default. Every feature is built around a single principle:

> **Browse freely. Leave nothing behind. Stay protected — always.**

Phantom is **not** a Chromium fork — it is an Electron application that uses Chromium's rendering and session APIs through Electron's `BrowserView` / `WebContentsView` primitives. This keeps the binary small, the security surface tractable, and lets the browser ship every feature in this document without forking and maintaining a browser engine.

**Non-negotiable design rules:**
- The VPN is infrastructure, not a feature. No content loads without an active tunnel.
- Every file on disk is encrypted. Every message in transit is encrypted.
- Nothing is saved by default. Everything has a wipe timer.
- No accounts, no logins, no cloud sync — ever.

---

## 2. System Architecture

Phantom runs as four cooperating layers inside a single Electron process tree:

```
┌──────────────────────────────────────────────────────────────────┐
│                       MAIN PROCESS (Node.js)                     │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐  │
│  │  WARP      │ │  Profile   │ │  Crypto    │ │  IPC Bridge  │  │
│  │  Manager   │ │  Manager   │ │  Vault     │ │  Router      │  │
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └──────┬───────┘  │
│        │              │              │                │          │
│  ┌─────▼──────────────▼──────────────▼────────────────▼───────┐ │
│  │         Session Partition Manager (Chromium)               │ │
│  │   default · work · social · finance · research · custom    │ │
│  └──────────────────────────┬─────────────────────────────────┘ │
└─────────────────────────────┼───────────────────────────────────┘
                              │
        ┌─────────────────────┼──────────────────────┐
        │                     │                      │
   ┌────▼─────┐         ┌─────▼─────┐         ┌──────▼─────┐
   │ Renderer │         │ Renderer  │         │  Renderer  │
   │  (UI)    │         │  (Tab N)  │   ···   │  (Tab N+1) │
   │ Electron │         │ Chromium  │         │  Chromium  │
   └──────────┘         └───────────┘         └────────────┘
                              │
                    ┌─────────▼──────────┐
                    │  WARP Tunnel       │
                    │  (SOCKS5 proxy)    │
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │ Cloudflare Network │
                    └────────────────────┘
```

### Process Responsibilities

| Process | Responsibility |
|---|---|
| **Main** (Node.js) | WARP daemon supervision, profile/PIN management, encryption, IPC routing, mDNS, OS integrations |
| **UI Renderer** | The chrome — toolbar, tabs, sidebar, dashboard, dialogs, settings |
| **Tab Renderers** | One isolated Chromium renderer per tab, partitioned by session container |
| **WARP Daemon** (subprocess) | Bundled `warp-svc` / `warp-cli` running as a child process |

### Key Architectural Decisions

1. **Session partitioning is the foundation of containers.** Electron's `session.fromPartition('persist:work')` API gives every container its own cookie jar, cache, and storage space at the Chromium level. This is enforced by Chromium itself, not by application code.
2. **All network traffic is intercepted in `webRequest`.** Before any request leaves the main process, it passes through the kill switch interceptor that verifies WARP is active, sanitises the URL, and confirms the request is on the allowed proxy.
3. **The UI is a single renderer** that uses `<webview>` or (preferred) `BrowserView`/`WebContentsView` to host page content. Tabs are not separate Electron windows — they are views layered on a single window.
4. **All disk I/O for profile data goes through an encryption shim.** Profiles never write plaintext — every write passes through libsodium `secretbox` keyed from the profile's PIN-derived key.

---

## 3. Technology Stack

| Layer | Technology | Version target | Purpose |
|---|---|---|---|
| App shell | Electron | ≥ 30.x | Cross-platform desktop runtime |
| Rendering | Chromium (via Electron) | matched to Electron | Web compatibility, session API |
| VPN protocol | WireGuard via Cloudflare WARP | latest WARP CLI | Always-on tunnel, $0 infra |
| VPN daemon | `warp-svc` + `warp-cli` (bundled) | latest | Tunnel control |
| Kill switch | `session.webRequest.onBeforeRequest` | Chromium API | Pre-flight request gate |
| DNS | Cloudflare 1.1.1.1 (DoH) | — | Encrypted DNS in WARP tunnel |
| Encryption | libsodium (`sodium-native`) | ≥ 4.x | All crypto operations |
| PIN hashing | Argon2id (`argon2`) | — | Password hashing, OS keychain |
| Keychain | `keytar` | ≥ 7.x | OS-native credential storage |
| Session containers | Electron `session.fromPartition()` | — | Isolated cookie/storage jars |
| Peer discovery | mDNS via `bonjour-service` | latest | Zero-config local peer detection |
| Peer transport | `ws` (WebSocket) | ≥ 8.x | Direct device-to-device messaging |
| Same-machine bridge | Electron `ipcMain` / `ipcRenderer` | — | Cross-profile IPC |
| Screenshot blocker | `SetWindowDisplayAffinity` (Win32) / `NSWindowSharingNone` (Cocoa) | — | OS-level capture prevention |
| Storage wipe | `session.clearStorageData()` | Chromium API | Comprehensive purge |
| Image processing | `sharp` + Node Canvas | latest | Safe screenshot redaction & EXIF strip |
| OS sleep events | `electron.powerMonitor` | — | Lock-on-sleep trigger |
| URL parsing | `url` (Node) + custom rules | — | Link sanitiser |
| UI framework | React 18 + TypeScript | — | The chrome (toolbar/tabs/dialogs) |
| Styling | CSS Modules + CSS Variables | — | Themable, scoped styles |

---

## 4. Project Structure

```
phantom-browser/
├── package.json
├── electron-builder.yml          # Build / packaging config
├── tsconfig.json
├── /resources/
│   ├── /warp/
│   │   ├── /win32/  warp-svc.exe  warp-cli.exe
│   │   ├── /darwin/ warp-svc      warp-cli
│   │   └── /linux/  warp-svc      warp-cli
│   └── icons/
├── /src/
│   ├── /main/                    # Main process (Node.js)
│   │   ├── index.ts              # App entry, lifecycle
│   │   ├── /warp/
│   │   │   ├── manager.ts        # Daemon supervisor
│   │   │   ├── kill-switch.ts    # webRequest interceptor
│   │   │   └── status-poll.ts    # Latency / health
│   │   ├── /profiles/
│   │   │   ├── manager.ts        # CRUD + UUID + index
│   │   │   ├── encryption.ts     # libsodium secretbox shim
│   │   │   ├── pin.ts            # Argon2 + keychain
│   │   │   └── decoy.ts          # Ghost-mode logic
│   │   ├── /containers/
│   │   │   └── partition-map.ts  # container ↔ session mapping
│   │   ├── /vault/
│   │   │   └── permissions.ts    # camera/mic interceptor
│   │   ├── /privacy/
│   │   │   ├── link-sanitiser.ts # tracking param stripper
│   │   │   ├── wipe-engine.ts    # 24h cycle
│   │   │   ├── tab-snapshot.ts   # encrypted tab persistence
│   │   │   └── report.ts         # daily privacy stats
│   │   ├── /security/
│   │   │   ├── screenshot.ts     # OS-level capture block
│   │   │   ├── focus-blur.ts     # focus-loss overlay
│   │   │   ├── lock.ts           # PIN lock screen
│   │   │   └── panic.ts          # one-shot panic sequence
│   │   ├── /messaging/
│   │   │   ├── mdns.ts           # peer discovery
│   │   │   ├── transport.ts      # WebSocket peer protocol
│   │   │   ├── crypto.ts         # libsodium box keypairs
│   │   │   └── rooms.ts          # room state
│   │   ├── /bridge/
│   │   │   └── ipc-router.ts     # same-machine cross-profile
│   │   └── /ipc/
│   │       └── channels.ts       # typed IPC contract
│   ├── /renderer/                # UI renderer (React)
│   │   ├── index.tsx
│   │   ├── /components/
│   │   │   ├── TitleBar/         # Tab strip + WARP pill + profile chip
│   │   │   ├── UrlBar/
│   │   │   ├── Sidebar/
│   │   │   ├── Dashboard/
│   │   │   ├── Vault/
│   │   │   ├── ProfileSwitcher/
│   │   │   ├── MessagingPanel/
│   │   │   ├── PinLock/
│   │   │   └── PanicButton/
│   │   ├── /styles/
│   │   │   ├── tokens.css        # Design tokens (colors, spacing)
│   │   │   └── theme.css
│   │   └── /state/               # UI state (Zustand or similar)
│   ├── /preload/                 # Context bridge between main & renderer
│   │   └── index.ts
│   └── /shared/                  # Types shared across processes
│       └── types.ts
├── /test/
└── /docs/
```

---

## 5. UI Design — Safari-Inspired

The interface borrows Safari's hallmarks — **compact unified toolbar, rounded pill tabs, translucent chrome, generous use of white space** — and adapts them for a privacy browser. Where Safari uses subtle blue accents, Phantom uses a refined ghost-violet (`#a78bfa`) as its signature.

### 5.1 Design Language

| Property | Value | Notes |
|---|---|---|
| **Default theme** | Dark | Privacy-aligned, reduces light leakage |
| **Surface treatment** | Translucent (`backdrop-filter: blur(40px) saturate(180%)`) | Identical to Safari's chrome |
| **Corner radius** | 6/8/12/16/20 px scale | Matches Apple HIG |
| **Tab shape** | Rounded pills, 9px radius | Safari 15+ aesthetic |
| **Typography (chrome)** | `-apple-system, "SF Pro Display"` | Native on macOS, falls back gracefully |
| **Typography (mono)** | `"SF Mono", "JetBrains Mono"` | Status bar, latency readouts |
| **Signature accent** | Ghost-violet `#a78bfa` | Logo, focus rings, active states |
| **Status colors** | Green `#30d158`, Yellow `#ffd60a`, Red `#ff453a` | macOS system colors |

### 5.2 Layout Anatomy

```
┌─────────────────────────────────────────────────────────────────────┐
│ ●●●  ◉ Personal ▾  • WARP 23ms   ⊕ ⊕ ⊕ ⊕ ⊕  +     🔒 🛡 💬 ⬇ ⚙ ⚠ │  ← Tab strip (44px)
├─────────────────────────────────────────────────────────────────────┤
│ ◀ ▶ ↻        🔒 [Work]  docs.internal.example/wiki/architecture  ⊟ │  ← URL bar (44px)
├─────────────────────────────────────────────────────────────────────┤
│           │                                                         │
│  Sidebar  │          Page content (BrowserView)                     │
│  240px    │          OR Dashboard homepage                          │
│           │                                                         │
│  Profile  │                                                         │
│  Containers│                                                        │
│  Tab Groups│                                                        │
│           │                                                         │
├─────────────────────────────────────────────────────────────────────┤
│ • WARP·Frankfurt·23ms   DNS·1.1.1.1   Wipe in 21:12:43   3 peers   │  ← Status bar (26px)
└─────────────────────────────────────────────────────────────────────┘
```

### 5.3 Top Chrome (Safari Comparison)

Like Safari, Phantom merges the **window controls, profile selector, tab strip, and primary actions** into a single 44px row. Unlike Safari, the row also carries a permanent **WARP status pill** showing live latency — the user is reminded every second that the tunnel is active.

The URL bar lives in its own 44px row below. A persistent **container tag** appears inside the URL bar (e.g. `[Work]`, `[Finance]`) — this is the only privacy-browser concept that doesn't exist in Safari, and it's deliberately placed where Safari shows the page's title in reader mode.

### 5.4 Tab Pills

Tabs adopt Safari's compact rounded shape. Pinned tabs collapse to favicon-only (32×32px). The **container colour shows as a 2px underline** on the active tab, never as a heavy left-border (which would look noisy at scale).

### 5.5 Dashboard (Default Homepage)

The dashboard greets the user with a centered logomark and the line *"Browse freely. Leave nothing behind."* Below sits a single 52px-tall search input (DuckDuckGo by default), then a 4-up stat grid showing **VPN latency, time-to-next-wipe, container count, and vault state**. An 8-icon quick-links row mirrors Safari's Top Sites. The fold ends with a horizontal **privacy report** showing trackers blocked, links sanitised, and camera requests denied as small bar charts.

Every dashboard widget is independently toggleable in profile settings.

### 5.6 Popovers

Popovers (profile switcher, vault, downloads) use the same translucent surface as the toolbar. They animate in with a 180ms scale-and-fade (`cubic-bezier(0.16, 1, 0.3, 1)`) — Apple's signature ease — and dismiss when the user clicks anywhere outside.

### 5.7 Lock Screen

The PIN lock screen takes over the entire window with a 96% opacity blackout and a 60px backdrop blur. Six dot indicators show PIN entry progress. The decoy PIN is indistinguishable from the real PIN at the screen level — the only difference is what loads after.

### 5.8 Status Bar

A single-line 26px status bar at the bottom shows live system state in `SF Mono` 10.5px: `WARP · Frankfurt · 23ms  ·  DNS · 1.1.1.1 (DoH)  ·  Wipe in 21:12:43  ·  3 peers · office-wifi`. This is the single most informationally-dense UI element — it gives security-conscious users full situational awareness without requiring them to open a panel.

> 📁 **The full interactive UI prototype is included as `phantom-browser-ui.html`** — it implements every screen described above (dashboard, profile switcher, vault, messaging panel, PIN lock) with working interactions and the complete design system.

---
## 6. Feature Specifications

Each feature below includes a **purpose** statement, an **architecture sketch**, **implementation specifics** with concrete API calls, **data flow**, and **edge case handling**. Every specification is designed to actually work — code snippets are real, not pseudo-code.

---

### 6.1 Always-On VPN (Cloudflare WARP)

**Purpose.** The VPN is infrastructure, not a feature. Every page load, every request, every DNS query travels through the WARP tunnel. The browser will not load any content without a confirmed active connection.

#### Architecture

The browser bundles platform-specific WARP binaries in `/resources/warp/<platform>/`. On launch, the **WARP Manager** spawns `warp-svc` as a child process and uses `warp-cli` to connect, configure SOCKS5 proxy mode, and report status back via stdout polling.

```
┌──────────────────┐      spawn      ┌──────────────────┐
│  Main Process    │────────────────▶│  warp-svc daemon │
│  WARP Manager    │                 │  (subprocess)    │
└────────┬─────────┘                 └────────┬─────────┘
         │ commands                           │ tunnel
         │ via warp-cli                       ▼
         │                            ┌──────────────────┐
         ▼                            │  WireGuard       │
   ┌──────────────────┐               │  to Cloudflare   │
   │  Status poller   │◀──────────────│  edge            │
   │  (latency, up?)  │   poll/3s     └──────────────────┘
   └──────────────────┘
         │
         │ if disconnected
         ▼
   ┌──────────────────┐
   │  Kill switch     │
   │  activates       │
   └──────────────────┘
```

#### Implementation

**1. Daemon supervisor (`src/main/warp/manager.ts`)**

```ts
import { spawn, ChildProcess } from 'child_process';
import { app } from 'electron';
import path from 'path';

const PROXY_PORT = 40000; // SOCKS5 port WARP listens on locally

class WarpManager {
  private daemon: ChildProcess | null = null;
  private connected = false;
  private latencyMs = 0;
  private listeners = new Set<(s: WarpStatus) => void>();

  async start(): Promise<void> {
    const platform = process.platform; // 'darwin' | 'win32' | 'linux'
    const binDir = path.join(process.resourcesPath, 'warp', platform);
    const svcPath = path.join(binDir, platform === 'win32' ? 'warp-svc.exe' : 'warp-svc');

    // 1. Spawn warp-svc as a child process
    this.daemon = spawn(svcPath, [], { stdio: 'pipe' });
    this.daemon.on('exit', (code) => this.onDaemonExit(code));

    // 2. Use warp-cli to register, set proxy mode, and connect
    await this.cli(['register', '--accept-tos']);
    await this.cli(['set-mode', 'proxy']);
    await this.cli(['set-proxy-port', String(PROXY_PORT)]);
    await this.cli(['connect']);

    // 3. Start polling
    this.startStatusPolling();
  }

  private startStatusPolling() {
    setInterval(async () => {
      const out = await this.cli(['status']);   // "Status: Connected"
      const wasConnected = this.connected;
      this.connected = out.includes('Connected');
      const lat = await this.cli(['warp-stats']); // parse latency from output
      this.latencyMs = parseLatency(lat);
      if (wasConnected !== this.connected) this.notify();
    }, 3000);
  }

  async stop(): Promise<void> {
    if (this.connected) await this.cli(['disconnect']);
    this.daemon?.kill('SIGTERM');
    this.daemon = null;
    this.connected = false;
  }

  proxyUrl(): string { return `socks5://127.0.0.1:${PROXY_PORT}`; }
  isConnected(): boolean { return this.connected; }
  latency(): number { return this.latencyMs; }

  onStatusChange(cb: (s: WarpStatus) => void) { this.listeners.add(cb); }
  private notify() {
    const s = { connected: this.connected, latencyMs: this.latencyMs };
    this.listeners.forEach(cb => cb(s));
  }

  // ... cli() helper that promisifies child_process.exec on warp-cli
}

export const warp = new WarpManager();
```

**2. Browser-wide proxy configuration**

Once the daemon reports the proxy is up, every Electron `Session` is configured to route through it:

```ts
import { session } from 'electron';

async function configureProxy(s: Electron.Session) {
  await s.setProxy({
    proxyRules: warp.proxyUrl(),       // socks5://127.0.0.1:40000
    proxyBypassRules: '<local>',       // never proxy mDNS / loopback
  });
  // Force DoH so DNS goes through the tunnel encrypted
  s.setSpellCheckerEnabled(false);
}
```

This must be called **before** any `BrowserView` loads a URL. The kill switch (next section) blocks any request made before this completes.

#### Kill Switch (`src/main/warp/kill-switch.ts`)

The kill switch is a `webRequest.onBeforeRequest` interceptor installed on every session partition. If WARP is not connected, the request is cancelled. If WARP is connected but the request is somehow not going through the proxy (e.g. an extension trying to bypass), it is also cancelled.

```ts
import { warp } from './manager';

export function installKillSwitch(s: Electron.Session) {
  s.webRequest.onBeforeRequest((details, callback) => {
    // 1. Allow loopback and mDNS (messaging needs these and they never leave the device)
    if (isLocalAddress(details.url)) return callback({ cancel: false });

    // 2. Block all non-loopback traffic if WARP is down
    if (!warp.isConnected()) {
      showKillSwitchOverlay();
      return callback({ cancel: true });
    }

    // 3. Otherwise allow — proxy is already configured at session level
    callback({ cancel: false });
  });
}

function isLocalAddress(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === 'localhost' ||
      u.hostname === '127.0.0.1' ||
      u.hostname === '::1' ||
      u.hostname.endsWith('.local')      // mDNS
    );
  } catch { return false; }
}
```

#### DNS Leak Protection

Cloudflare WARP routes DNS through 1.1.1.1 over DoH automatically when in proxy mode. Phantom additionally:

1. Sets the `--enable-features=DnsOverHttps` and `--dns-over-https-server=https://1.1.1.1/dns-query` Chromium flags via `app.commandLine.appendSwitch(...)` on app startup.
2. Disables the OS-level DNS resolver for browser sessions by setting `dnsOverHttpsConfig` on the session.
3. Verifies on launch by issuing a DNS query for a known canary domain (e.g. `dnsleak.cloudflare.com`) and confirming the response IP matches a Cloudflare edge.

#### Toolbar Status Indicator (UI contract)

The renderer subscribes to WARP status via the IPC channel `warp:status`:

```ts
// preload/index.ts
contextBridge.exposeInMainWorld('phantom', {
  warp: {
    onStatus: (cb: (s: WarpStatus) => void) => ipcRenderer.on('warp:status', (_, s) => cb(s)),
  }
});
```

The pill renders one of three states:

| Latency | Indicator |
|---|---|
| < 150 ms, connected | 🟢 Green dot, latency in ms |
| ≥ 150 ms, connected | 🟡 Yellow dot, latency in ms |
| Disconnected | 🔴 Red dot pulsing, "Reconnecting…" |

#### Edge Cases

- **Daemon crash:** `daemon.on('exit')` triggers an automatic restart (max 3 attempts in 30 s, then full kill switch).
- **WARP service rate limit:** WARP free tier has bandwidth caps. Phantom shows a non-modal banner if Cloudflare returns rate-limit headers.
- **Network change (laptop sleep/move):** `electron.powerMonitor` and `net.online` events trigger a reconnect.
- **First launch on metered connection:** WARP downloads ~30 MB on first registration. The user sees a "Setting up secure tunnel" splash with progress.

---

### 6.2 24-Hour Wipe Cycle

**Purpose.** Every 24 hours, the browser performs a full data purge across all profiles and containers. Wiping is automated, silent, and comprehensive. Tabs survive via an encrypted snapshot — the user never sees their workspace disappear.

#### What Gets Wiped vs Preserved

| Wiped (every 24 h) | Preserved across wipes |
|---|---|
| Cookies & sessions | Tab URLs & order |
| Cache & page content | Tab groupings |
| Browsing history log | Pinned messages (with optional expiry) |
| Form data & autofill | Profile settings & PIN |
| LocalStorage / IndexedDB | Quick links |
| Service workers | Theme preferences |
| WebSQL, FileSystem API | |

#### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Wipe Engine (per profile, independent timers)      │
├─────────────────────────────────────────────────────┤
│  1. Capture tab snapshot   ─►  encrypted JSON file  │
│  2. clearStorageData()     ─►  per-partition purge  │
│  3. Reload renderer shell                           │
│  4. Restore from snapshot  ─►  lazy load            │
│  5. Reset privacy report counters                   │
└─────────────────────────────────────────────────────┘
```

#### Tab Snapshot System (`src/main/privacy/tab-snapshot.ts`)

A continuous lightweight snapshot is written every time tabs change (open, close, reorder, navigate). Only URL, title, and order are captured — never page content.

```ts
import sodium from 'sodium-native';
import fs from 'fs/promises';
import path from 'path';

interface TabSnapshot {
  version: 1;
  capturedAt: number;
  windows: { tabs: { url: string; title: string; pinned: boolean; containerId: string }[] }[];
}

class TabSnapshotManager {
  constructor(private profileDir: string, private encryptionKey: Buffer) {}

  async write(snapshot: TabSnapshot): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
    const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
    sodium.randombytes_buf(nonce);

    const ciphertext = Buffer.alloc(plaintext.length + sodium.crypto_secretbox_MACBYTES);
    sodium.crypto_secretbox_easy(ciphertext, plaintext, nonce, this.encryptionKey);

    // Atomic write: write to .tmp, then rename
    const tmp = path.join(this.profileDir, 'tab-snapshot.enc.tmp');
    const dst = path.join(this.profileDir, 'tab-snapshot.enc');
    await fs.writeFile(tmp, Buffer.concat([nonce, ciphertext]));
    await fs.rename(tmp, dst);
  }

  async read(): Promise<TabSnapshot | null> {
    try {
      const buf = await fs.readFile(path.join(this.profileDir, 'tab-snapshot.enc'));
      const nonce = buf.subarray(0, sodium.crypto_secretbox_NONCEBYTES);
      const ciphertext = buf.subarray(sodium.crypto_secretbox_NONCEBYTES);
      const plaintext = Buffer.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES);
      const ok = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, this.encryptionKey);
      if (!ok) return null;
      return JSON.parse(plaintext.toString('utf8'));
    } catch { return null; }
  }

  async clear(): Promise<void> {
    try { await fs.unlink(path.join(this.profileDir, 'tab-snapshot.enc')); } catch {}
  }
}
```

The snapshot is debounced — writes happen at most once per 800ms to avoid I/O thrashing on rapid tab changes.

#### Wipe Engine (`src/main/privacy/wipe-engine.ts`)

```ts
class WipeEngine {
  private timers = new Map<string, NodeJS.Timeout>();

  schedule(profileId: string, intervalMs = 24 * 60 * 60 * 1000) {
    this.cancel(profileId);
    this.timers.set(profileId, setTimeout(() => this.run(profileId), intervalMs));
  }

  cancel(profileId: string) {
    const t = this.timers.get(profileId);
    if (t) { clearTimeout(t); this.timers.delete(profileId); }
  }

  async run(profileId: string): Promise<void> {
    const profile = await profiles.get(profileId);

    // 1. Capture snapshot before wipe (only if user opted in)
    if (profile.settings.rememberTabs) {
      const snap = await tabs.captureSnapshot(profileId);
      await snapshotManager.write(snap);
    }

    // 2. Wipe every container session for this profile
    for (const containerId of profile.containers) {
      const partition = `persist:${profileId}:${containerId}`;
      const s = session.fromPartition(partition);
      await s.clearStorageData({
        storages: [
          'cookies', 'filesystem', 'indexdb', 'localstorage',
          'shadercache', 'websql', 'serviceworkers', 'cachestorage'
        ]
      });
      await s.clearCache();
      await s.clearAuthCache();
      await s.clearHostResolverCache();
    }

    // 3. Wipe pinned messages (per spec — even pinned wipe on 24h cycle)
    await messaging.wipePersistedMessages(profileId);

    // 4. Reset vault permissions
    await vault.resetForProfile(profileId);

    // 5. Reset privacy report
    await report.reset(profileId);

    // 6. Reload shell + restore tabs (lazy)
    await renderer.reloadShell(profileId);
    if (profile.settings.rememberTabs) {
      const snap = await snapshotManager.read();
      if (snap) await tabs.restoreLazy(profileId, snap);
    }

    // 7. Reschedule next wipe
    this.schedule(profileId);
  }
}
```

#### Lazy Tab Loading

After a wipe, only the **active tab** loads its URL. Every other tab is created as a `BrowserView` placeholder that shows the favicon + title from the snapshot but **does not call `loadURL()`** until the user clicks it.

```ts
async function restoreLazy(profileId: string, snap: TabSnapshot) {
  for (const win of snap.windows) {
    for (let i = 0; i < win.tabs.length; i++) {
      const tab = win.tabs[i];
      if (i === win.activeIndex) {
        await createTabAndLoad(tab);
      } else {
        createSuspendedTab(tab);  // shows in tab strip, no loadURL yet
      }
    }
  }
}
```

#### User Controls

Exposed in profile settings:

| Setting | Default | Range |
|---|---|---|
| Remember tabs across wipe | On | Per profile toggle |
| Wipe interval | 24 h | Min 1 h, max 7 days |
| Per-tab "forget on wipe" | Off | Right-click tab → Forget |
| Manual wipe (incl. snapshot) | — | Settings → "Wipe Now" button |

---

### 6.3 Multi-Profile System

**Purpose.** Profiles are isolated local containers — no logins, no accounts, no cloud sync. Each profile is a sealed bubble with its own sessions, settings, PIN, vault, containers, and wipe timer.

#### Disk Structure

```
~/Library/Application Support/PhantomBrowser/   (macOS)
%APPDATA%/PhantomBrowser/                       (Windows)
~/.config/PhantomBrowser/                       (Linux)
└── profiles/
    ├── profiles-index.enc                      ← encrypted index
    ├── 7c9e6f24-b8.../                         ← profile UUID (anon on disk)
    │   ├── session-data/                       ← Chromium partition data
    │   ├── containers/                         ← per-container session jars
    │   │   ├── default/
    │   │   ├── work/
    │   │   ├── social/
    │   │   ├── finance/
    │   │   └── research/
    │   ├── tab-snapshot.enc
    │   ├── prefs.enc                           ← encrypted preferences
    │   ├── pinned-messages.enc
    │   └── pin.salt                            ← Argon2 salt (no hash on disk)
    └── 1f3a8d62-c4.../                         ← another profile
```

> **Key invariant:** profile folders are **anonymous on disk**. Their names are UUIDs, their contents are encrypted. The only place the profile name "Personal" exists is inside `profiles-index.enc`. If an attacker only had the disk, they would see N folders of opaque encrypted data.

#### Profile Index (`profiles-index.enc`)

```ts
interface ProfilesIndex {
  version: 1;
  profiles: {
    uuid: string;
    name: string;
    color: string;             // "#a78bfa"
    hidden: boolean;
    hiddenAccessCode?: string; // hash of secret unlock phrase
    hasPin: boolean;
    hasDecoy: boolean;
    decoyTargetUuid?: string;  // if user enters decoy PIN, switch to this profile
    createdAt: number;
  }[];
}
```

The index itself is encrypted with a **machine-bound key** derived from a secret stored in the OS keychain at first launch. This means even the index is unreadable on a stolen disk.

#### Profile Manager (`src/main/profiles/manager.ts`)

```ts
import { v4 as uuidv4 } from 'uuid';

class ProfileManager {
  async create(name: string, color: string, opts: CreateOpts): Promise<Profile> {
    const uuid = uuidv4();
    const profileDir = path.join(this.root, uuid);
    await fs.mkdir(profileDir, { recursive: true });

    // Generate a per-profile encryption key
    const profileKey = sodium.crypto_secretbox_keygen();

    // If the user set a PIN, the profile key is derived from it via Argon2
    if (opts.pin) {
      await pinSystem.set(uuid, opts.pin, profileKey);
    } else {
      // No PIN: store key in OS keychain bound to the profile UUID
      await keytar.setPassword('com.phantom.browser', uuid, profileKey.toString('base64'));
    }

    // Write encrypted prefs
    await this.writePrefs(uuid, defaultPrefs(name, color), profileKey);

    // Update index
    await this.updateIndex(idx => idx.profiles.push({ uuid, name, color, ... }));

    return this.load(uuid);
  }

  async switch(uuid: string, openPin?: string): Promise<void> {
    const profile = await this.load(uuid);

    // Real PIN: load this profile
    // Decoy PIN: silently load the configured decoy profile instead
    if (profile.hasPin) {
      const result = await pinSystem.verify(uuid, openPin!);
      if (result === 'decoy') {
        await ghostMode.activate(profile.decoyTargetUuid!);
        return;
      }
      if (result === 'invalid') throw new Error('PIN_INVALID');
    }

    // Set up sessions for every container
    for (const container of profile.containers) {
      const partition = `persist:${uuid}:${container.id}`;
      const s = session.fromPartition(partition);
      await proxy.configure(s);          // WARP SOCKS5
      installKillSwitch(s);
      installVaultInterceptor(s);
      installLinkSanitiser(s);
    }

    // Restore tabs
    await tabs.restoreFor(uuid);

    // Start the per-profile wipe timer
    wipeEngine.schedule(uuid, profile.settings.wipeIntervalMs);

    // Broadcast new mDNS identity for messaging
    await messaging.setIdentity(profile.messagingDisplayName, profile.messagingColor);
  }
}
```

#### Hidden Profiles

Hidden profiles do **not** appear in the standard profile switcher dropdown. They are accessed by typing a secret unlock phrase into the profile switcher's search field. The phrase is hashed with Argon2 and matched against `hiddenAccessCode` in the index.

```ts
async function unlockHidden(typed: string): Promise<Profile | null> {
  const hashed = await argon2.hash(typed, { type: argon2.argon2id });
  for (const p of index.profiles.filter(p => p.hidden)) {
    if (await argon2.verify(p.hiddenAccessCode!, typed)) return load(p.uuid);
  }
  return null;
}
```

The hidden profile's existence is fully deniable — without the phrase, there is no UI surface that hints at it, and without the index decryption key, there is no on-disk evidence.

#### Per-Profile Settings

| Setting | Default | Per profile? |
|---|---|---|
| PIN | None | Yes |
| Decoy PIN | None | Yes |
| WARP region preference | Auto | Yes |
| Wipe interval | 24 h | Yes |
| Tab snapshot enabled | On | Yes |
| Vault default state | Locked | Yes |
| Custom homepage URL | Dashboard | Yes |
| Theme | System | Yes |
| Messaging display name | Random | Yes |

---

### 6.4 PIN Lock & Decoy System

**Purpose.** Lock the browser at the OS level when the machine sleeps. Provide a decoy PIN that silently loads a fake profile while wiping the real session — for hostile-environment scenarios.

#### PIN Storage

PINs are **never** stored as plaintext or as direct hashes. They are stored as **Argon2id hashes inside the OS keychain** — Keychain on macOS, Credential Manager on Windows, libsecret on Linux.

```ts
import argon2 from 'argon2';
import keytar from 'keytar';

const ARGON_OPTS = {
  type: argon2.argon2id,
  memoryCost: 65536,    // 64 MB
  timeCost: 3,
  parallelism: 4,
};

class PinSystem {
  async set(profileUuid: string, pin: string, profileKey: Buffer): Promise<void> {
    const hash = await argon2.hash(pin, ARGON_OPTS);
    await keytar.setPassword(`phantom.pin.${profileUuid}`, 'real', hash);

    // The profile encryption key is wrapped with a key derived from the PIN
    const wrappingKey = await this.derive(pin, profileUuid);
    const wrapped = wrap(profileKey, wrappingKey);
    await keytar.setPassword(`phantom.pkey.${profileUuid}`, 'wrapped', wrapped.toString('base64'));
  }

  async setDecoy(profileUuid: string, decoyPin: string): Promise<void> {
    const hash = await argon2.hash(decoyPin, ARGON_OPTS);
    await keytar.setPassword(`phantom.pin.${profileUuid}`, 'decoy', hash);
  }

  async verify(profileUuid: string, pin: string): Promise<'real' | 'decoy' | 'invalid'> {
    const real = await keytar.getPassword(`phantom.pin.${profileUuid}`, 'real');
    const decoy = await keytar.getPassword(`phantom.pin.${profileUuid}`, 'decoy');

    if (real && await argon2.verify(real, pin)) return 'real';
    if (decoy && await argon2.verify(decoy, pin)) return 'decoy';
    return 'invalid';
  }

  // PIN-to-key derivation (separate from password verification)
  private async derive(pin: string, salt: string): Promise<Buffer> {
    return Buffer.from(await argon2.hash(pin, { ...ARGON_OPTS, raw: true, salt: Buffer.from(salt) }));
  }
}
```

#### Lock-on-Sleep

```ts
import { powerMonitor } from 'electron';

powerMonitor.on('suspend', () => security.lockAllProfiles());
powerMonitor.on('lock-screen', () => security.lockAllProfiles());

// Platform-specific listeners for finer-grained events:
if (process.platform === 'darwin') {
  // NSWorkspaceWillSleepNotification is captured by powerMonitor.on('suspend')
}
if (process.platform === 'win32') {
  // WM_WTSSESSION_CHANGE: register via systemPreferences if needed
  powerMonitor.on('lock-screen', () => security.lockAllProfiles());
}
if (process.platform === 'linux') {
  // systemd PrepareForSleep — captured by powerMonitor on Linux 4+
}
```

When `lockAllProfiles()` runs:
1. Every visible `BrowserView` is hidden (set `setBackgroundColor('#000000')` and zero-rect).
2. The PIN lock overlay is shown on every Phantom window.
3. All vault permissions are temporarily suspended (re-granted on unlock).
4. The same-machine bridge drops on both ends.
5. WARP **stays connected** — the tunnel does not drop on sleep.

Returning from sleep restores everything **only after** PIN verification succeeds.

#### Ghost Mode (Decoy PIN)

When the user enters the decoy PIN:

```ts
async function activateGhostMode(realProfileUuid: string, decoyTargetUuid: string) {
  // 1. Wipe real session — silently, in background
  await wipeEngine.runImmediate(realProfileUuid, { skipSnapshot: true });

  // 2. Make real profiles invisible in this session
  ui.hideProfilesExcept([decoyTargetUuid]);

  // 3. Switch to the decoy profile
  await profiles.switch(decoyTargetUuid);

  // 4. Show the decoy homepage
  await tabs.openHomepage(decoyTargetUuid);

  // 5. Send silent push to paired mobile (if configured)
  if (settings.pairedMobileToken) {
    await mobilePush.send(settings.pairedMobileToken, { type: 'decoy-activated' });
  }
}
```

**Decoy profile rules (hard-coded, no overrides):**
- Vault is permanently locked — no camera/mic ever
- Decoy never appears in the profile switcher
- Decoy cannot use the same-machine bridge
- Decoy cannot trigger panic notifications
- Decoy has no visible messaging panel

#### Failed-PIN Panic

Optional setting: trigger a full panic after 3 wrong PIN entries.

```ts
let attempts = 0;
function onPinAttempt(pin: string, profileUuid: string) {
  const result = pinSystem.verify(profileUuid, pin);
  if (result === 'invalid') {
    attempts++;
    if (settings.panicOnFailedPin && attempts >= 3) panic.trigger();
  } else {
    attempts = 0;
  }
}
```

---
### 6.5 Session Containers

**Purpose.** Containers are isolated cookie/session jars within a single profile. Same WARP, same PIN — but sites in different containers cannot cross-contaminate cookies, localStorage, or service workers.

#### Implementation: Electron Session Partitioning

Containers map directly onto Electron's `session.fromPartition()` API. Every partition has its own Chromium-managed storage that is enforced at the engine level — application code cannot accidentally bridge them.

```ts
import { session, BrowserView } from 'electron';

interface Container {
  id: string;          // 'default' | 'work' | 'social' | 'finance' | 'research' | <custom-uuid>
  name: string;
  color: string;       // CSS hex
  hardened: boolean;   // true for finance, configurable for custom
  scriptBlocker: 'standard' | 'strict';
}

class ContainerManager {
  private partitionFor(profileUuid: string, containerId: string): string {
    return `persist:${profileUuid}:${containerId}`;
  }

  sessionFor(profileUuid: string, containerId: string): Electron.Session {
    const s = session.fromPartition(this.partitionFor(profileUuid, containerId));
    return s;
  }

  async setupSession(profileUuid: string, container: Container): Promise<void> {
    const s = this.sessionFor(profileUuid, container.id);

    // 1. Proxy through WARP
    await s.setProxy({ proxyRules: warp.proxyUrl(), proxyBypassRules: '<local>' });

    // 2. Install kill switch, vault, link sanitiser
    installKillSwitch(s);
    installVaultInterceptor(s, profileUuid);
    installLinkSanitiser(s);

    // 3. Hardening for Finance container
    if (container.hardened) {
      await s.setPermissionRequestHandler((wc, perm, cb) => cb(false));  // deny all
      s.webRequest.onBeforeRequest({ urls: ['*://*/*.js'] }, (d, cb) => {
        // strict mode: block third-party scripts
        if (isThirdPartyScript(d)) return cb({ cancel: true });
        cb({ cancel: false });
      });
    }
  }

  async openTabInContainer(profileUuid: string, containerId: string, url: string) {
    const s = this.sessionFor(profileUuid, containerId);
    const view = new BrowserView({ webPreferences: { session: s, contextIsolation: true } });
    await view.webContents.loadURL(url);
    return view;
  }
}
```

#### Default Containers (built-in)

| Container | Border colour | Hardening |
|---|---|---|
| Default | none | Standard |
| Work | `#0a84ff` | Standard |
| Social | `#30d158` | Standard |
| Finance | `#ff453a` | **Strict**: vault always locked, third-party JS blocked, no notification permissions |
| Research | `#ffd60a` | Standard |

#### Moving a Tab Between Containers

When a user right-clicks a tab → "Move to Finance":

```ts
async function moveTab(tab: Tab, newContainerId: string) {
  const url = tab.view.webContents.getURL();
  const profileUuid = tab.profileUuid;

  // 1. Wipe the current tab's session data BEFORE moving
  await containers.sessionFor(profileUuid, tab.containerId)
    .clearStorageData({ origin: new URL(url).origin });

  // 2. Destroy the old BrowserView
  tab.view.webContents.destroy();

  // 3. Open fresh in the new container
  const view = await containers.openTabInContainer(profileUuid, newContainerId, url);
  tab.view = view;
  tab.containerId = newContainerId;

  // 4. Update UI border colour
  ui.refreshTab(tab);
}
```

#### Container Wipe Behaviour

- **24-hour cycle:** all containers wiped simultaneously
- **Manual single-container wipe:** Settings → Container → Wipe Now
- **Move tab between containers:** wipes the tab's origin in the source container

---

### 6.6 Camera & Microphone Vault

**Purpose.** Replace Chromium's standard permission system entirely. No site ever holds persistent camera or microphone access. Every request is intercepted and the user explicitly chooses block / session-only / timed.

#### Implementation: Permission Interceptor

```ts
import { session } from 'electron';

type VaultGrant =
  | { kind: 'block' }
  | { kind: 'session'; tabId: number }              // revoked when tab closes
  | { kind: 'timed'; expiresAt: number };           // revoked by timer

class Vault {
  private state: 'locked' | 'session' | 'timed' = 'locked';
  private grants = new Map<string, VaultGrant>();   // key: `${origin}:${permission}`

  install(s: Electron.Session, profileUuid: string) {
    s.setPermissionRequestHandler(async (webContents, permission, callback, details) => {
      // Only intercept camera and microphone
      if (permission !== 'media' || !this.isMediaRequest(details)) {
        return callback(false); // deny everything else by default
      }

      // Locked vault: silently deny
      if (this.state === 'locked') return callback(false);

      // Decoy profile: hard-coded locked
      if (profiles.isDecoy(profileUuid)) return callback(false);

      // Show the in-browser dialog
      const choice = await ui.showVaultDialog({
        origin: details.requestingUrl,
        permission: this.permissionLabel(details),
      });

      if (choice.kind === 'block') return callback(false);

      const key = `${new URL(details.requestingUrl).origin}:${permission}`;
      this.grants.set(key, choice);
      callback(true);

      // Auto-revocation
      if (choice.kind === 'session') {
        webContents.once('destroyed', () => this.grants.delete(key));
      } else if (choice.kind === 'timed') {
        setTimeout(() => {
          this.grants.delete(key);
          this.notifyRevoked(key);
        }, choice.expiresAt - Date.now());
      }
    });

    // Permission CHECK handler (chromium calls this on every getUserMedia)
    s.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
      if (permission !== 'media') return false;
      const key = `${requestingOrigin}:${permission}`;
      const grant = this.grants.get(key);
      if (!grant) return false;
      if (grant.kind === 'timed' && grant.expiresAt < Date.now()) {
        this.grants.delete(key);
        return false;
      }
      return true;
    });
  }

  lock() { this.state = 'locked'; this.grants.clear(); this.notifyAll(); }
  setSessionMode() { this.state = 'session'; }
  setTimedMode() { this.state = 'timed'; }

  activeGrants(): VaultGrant[] { return Array.from(this.grants.values()); }
}
```

#### Toolbar Indicator States

| State | Icon | Tooltip |
|---|---|---|
| Locked | 🔒 (text-quaternary colour) | "Vault locked — no access" |
| Session active | 🟢 (green) | "Camera active for `meet.example.com`" |
| Timed active | ⏱ (with countdown) | "Mic for `studio.example.com` — 4:32 left" |

Clicking the icon opens the **Vault popover** (see UI prototype) showing every active grant with a Revoke button.

#### Hard Rules

- **Decoy profile:** vault is permanently locked, no exceptions.
- **Ephemeral tabs:** vault is locked regardless of profile setting.
- **Panic button:** all grants revoked instantly, vault forced to locked state.
- **Profile switch:** vault state isolated per profile (each profile has independent grants).

---

### 6.7 Screenshot Protection

**Purpose.** Three layers prevent screen capture tools, remote-access software, and malicious extensions from capturing browser content.

#### Layer 1 — Focus-Loss Blur (Renderer)

The instant the browser window loses focus, an opaque overlay is applied. The blur is a renderer-side CSS effect because the page's pixels are inside the renderer.

```ts
// Renderer-side
window.addEventListener('blur', () => {
  document.body.classList.add('phantom-focus-blur');
});
window.addEventListener('focus', () => {
  document.body.classList.remove('phantom-focus-blur');
});
```

```css
body.phantom-focus-blur webview,
body.phantom-focus-blur .browser-content {
  filter: blur(28px) saturate(0.4);
  pointer-events: none;
}
body.phantom-focus-blur::after {
  content: '';
  position: fixed; inset: 0;
  background: rgba(28, 28, 30, 0.7);
  backdrop-filter: blur(20px);
  z-index: 9999;
}
```

But CSS blur alone isn't sufficient — a screenshot tool capturing the actual framebuffer would still get the unblurred pixels because `filter` is composited. So the blur is reinforced by Layer 3 below.

#### Layer 2 — Sleep/Lock Blackout

When the OS fires a sleep event, the entire window is set to solid black (not blurred). This is done in the **main process** so it cannot be raced:

```ts
import { BrowserWindow, powerMonitor } from 'electron';

powerMonitor.on('suspend', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor('#000000');
    win.webContents.send('phantom:lock');           // renderer hides everything
    // and hide the BrowserView entirely
    for (const view of win.getBrowserViews()) {
      win.removeBrowserView(view);                  // detach but keep alive
    }
  }
});
```

On wake + correct PIN entry, views are reattached.

#### Layer 3 — OS-Level Window Display Affinity

The strongest layer. The OS itself excludes the window from screen capture.

**Windows** — `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` via `node-ffi-napi` or a tiny native module:

```ts
// src/main/security/screenshot.ts (Windows)
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const SetWindowDisplayAffinity = user32.func(
  'int __stdcall SetWindowDisplayAffinity(void *hwnd, int dwAffinity)'
);
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;  // since Windows 10 v2004

export function protectWindow(win: Electron.BrowserWindow) {
  if (process.platform !== 'win32') return;
  const hwnd = win.getNativeWindowHandle();        // Buffer
  SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
}
```

**macOS** — `NSWindow.sharingType = NSWindowSharingNone`:

```ts
// On macOS, Electron exposes setContentProtection()
export function protectWindow(win: Electron.BrowserWindow) {
  win.setContentProtection(true);   // sets NSWindowSharingNone on macOS, equivalent on Windows ≥ 10 v2004
}
```

In fact `BrowserWindow.setContentProtection(true)` is the cross-platform Electron API that wraps both — Phantom calls it on every window at creation:

```ts
const win = new BrowserWindow({ /* ... */ });
win.setContentProtection(true);      // single call covers Windows + macOS
```

**Linux** has no equivalent OS-level API. On Linux, Phantom relies on Layers 1 and 2 plus a warning surfaced in the security settings.

---

### 6.8 Link Sanitiser

**Purpose.** Strip known tracking parameters from every URL before the request leaves the browser. Sites still load — they just lose all referral context.

#### Tracking Parameters Removed

| Parameter | Source |
|---|---|
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` | Google Analytics |
| `fbclid` | Facebook |
| `gclid`, `gbraid`, `wbraid` | Google Ads |
| `mc_eid`, `mc_cid` | Mailchimp |
| `igshid` | Instagram |
| `twclid` | Twitter / X |
| `msclkid` | Microsoft Ads |
| `_hsenc`, `_hsmi`, `__hstc`, `__hssc` | HubSpot |
| `mkt_tok` | Marketo |
| `vero_id`, `vero_conv` | Vero |
| `oly_anon_id`, `oly_enc_id` | Omeda |
| `ref`, `referrer`, `referer` | Generic referral |
| `yclid` | Yandex |
| `dclid` | Google DoubleClick |

The list is maintained in `src/main/privacy/tracking-params.ts` and is updated via signed list updates (no per-user telemetry — the list is a static JSON shipped with each release).

#### Implementation

```ts
// src/main/privacy/link-sanitiser.ts
import { session } from 'electron';
import { TRACKING_PARAMS, TRACKING_PARAM_PATTERNS } from './tracking-params';

export function installLinkSanitiser(s: Electron.Session) {
  s.webRequest.onBeforeRequest((details, callback) => {
    const cleaned = sanitiseUrl(details.url);
    if (cleaned !== details.url) {
      report.recordSanitised(details.url, cleaned);
      return callback({ cancel: false, redirectURL: cleaned });
    }
    callback({ cancel: false });
  });
}

export function sanitiseUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { return input; }

  let modified = false;
  for (const param of Array.from(url.searchParams.keys())) {
    if (TRACKING_PARAMS.has(param) ||
        TRACKING_PARAM_PATTERNS.some(rx => rx.test(param))) {
      url.searchParams.delete(param);
      modified = true;
    }
  }

  return modified ? url.toString() : input;
}
```

The sanitiser runs **before** the request leaves the proxy, so even the WARP exit node never sees the tracking parameters. The destination server sees a clean URL.

#### Privacy Report Integration

Every sanitised URL is logged to the daily privacy report:

```ts
class PrivacyReport {
  private counts = { sanitised: 0, blocked: 0, mediaBlocked: 0, requests: 0 };
  private samples: SanitiseSample[] = [];

  recordSanitised(before: string, after: string) {
    this.counts.sanitised++;
    if (this.samples.length < 100) {  // cap samples to avoid memory bloat
      this.samples.push({ host: new URL(before).host, params: diffParams(before, after) });
    }
  }
}
```

The report is wiped with the 24-hour cycle.

---
### 6.9 Panic Button

**Purpose.** One action, everything gone. The browser appears freshly opened. The full sequence executes in under one second.

#### Trigger Methods

| Method | Implementation |
|---|---|
| Keyboard shortcut | `globalShortcut.register('CommandOrControl+Shift+X', panic.trigger)` (configurable) |
| Toolbar button | Double-click required (anti-accident) |
| Trackpad shake | Detect rapid X-axis acceleration via mouse-move sampling |
| Mobile companion | Local push from paired phone via mDNS |
| Failed PIN attempts | After 3 invalid PINs (optional setting) |

#### Panic Sequence (`src/main/security/panic.ts`)

```ts
class PanicSystem {
  private inProgress = false;

  async trigger(): Promise<void> {
    if (this.inProgress) return;
    this.inProgress = true;
    const t0 = Date.now();

    // 1. Lock UI immediately — instant visual response
    BrowserWindow.getAllWindows().forEach(w => {
      w.webContents.send('phantom:lock-instant');
      w.setBackgroundColor('#000000');
    });

    // 2. Cancel all in-flight requests by destroying every BrowserView
    for (const win of BrowserWindow.getAllWindows()) {
      for (const view of win.getBrowserViews()) {
        view.webContents.close();
        win.removeBrowserView(view);
      }
    }

    // 3. Wipe every active profile's session in parallel
    const activeProfiles = profiles.allActive();
    await Promise.all(activeProfiles.map(p => this.wipeProfile(p.uuid)));

    // 4. Clear tab snapshots for all profiles
    await Promise.all(activeProfiles.map(p => snapshotManager.clearFor(p.uuid)));

    // 5. Lock all vaults
    vault.lockAll();

    // 6. Clear OS clipboard
    clipboard.clear();

    // 7. Tear down messaging entirely
    await messaging.panicShutdown();   // stop mDNS broadcast, close all WS, wipe memory

    // 8. Drop the same-machine bridge
    await bridge.dropAll();

    // 9. Reload shell to homepage — WARP STAYS UP
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('phantom:reload-clean'));

    console.log(`Panic complete in ${Date.now() - t0}ms`);
    this.inProgress = false;
  }

  private async wipeProfile(uuid: string) {
    const p = await profiles.load(uuid);
    for (const c of p.containers) {
      const s = session.fromPartition(`persist:${uuid}:${c.id}`);
      await s.clearStorageData();
      await s.clearCache();
      await s.clearAuthCache();
    }
  }
}
```

#### Trackpad Shake Detection

```ts
// renderer-side, samples mouse movement
class ShakeDetector {
  private samples: { x: number; t: number }[] = [];

  start() {
    window.addEventListener('mousemove', e => {
      const now = performance.now();
      this.samples = this.samples.filter(s => now - s.t < 600);
      this.samples.push({ x: e.screenX, t: now });
      if (this.detect()) phantom.panic.trigger();
    });
  }

  private detect(): boolean {
    if (this.samples.length < 8) return false;
    let direction = 0, changes = 0;
    for (let i = 1; i < this.samples.length; i++) {
      const d = Math.sign(this.samples[i].x - this.samples[i-1].x);
      if (d !== 0 && d !== direction) { changes++; direction = d; }
    }
    return changes >= 5;   // five direction changes in 600ms = shake
  }
}
```

#### Hard Invariants

- **WARP stays connected** — the tunnel never drops during panic. Outside observers see a steady network connection.
- **No telemetry, no logs** — panic itself leaves no trace. There is no "panic event" record.
- **Visible state after panic** = visible state of a fresh launch. No banner, no toast, no animation that would hint to a third party that a panic was triggered.

---

### 6.10 Safe Screenshot Tool

**Purpose.** A built-in screenshot tool that automatically redacts sensitive browser elements (URL, tab titles, profile names) before the file is saved. Image EXIF metadata is fully stripped.

#### Capture Flow

```
Ctrl+Shift+S
    │
    ▼
Selection overlay (renderer)
    │  (drag rectangle)
    ▼
desktopCapturer.getSources()  ─►  capture region as PNG
    │
    ▼
Auto-redaction pipeline (sharp + canvas)
  ├─ Replace URL bar text with "Private Browser"
  ├─ Replace tab titles with "Tab 1", "Tab 2"…
  ├─ Hide profile name
  ├─ Blur other tabs
  ├─ Hide notification badges
  └─ Replace VPN status with "Protected"
    │
    ▼
Preview with manual blur boxes (user can add more)
    │
    ▼
Strip EXIF metadata (sharp .withMetadata({}))
    │
    ▼
Save to disk OR copy to clipboard
```

#### Implementation

```ts
import { desktopCapturer, screen, clipboard, nativeImage } from 'electron';
import sharp from 'sharp';

class SafeScreenshot {
  async capture(region: { x: number; y: number; w: number; h: number }) {
    // 1. Use desktopCapturer to grab the screen
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: screen.getPrimaryDisplay().size.width,
                       height: screen.getPrimaryDisplay().size.height }
    });
    const phantomSource = sources.find(s => s.name.includes('Phantom'));
    if (!phantomSource) throw new Error('Could not capture');

    let image = phantomSource.thumbnail.toPNG();

    // 2. Crop to the selected region
    image = await sharp(image).extract(region).toBuffer();

    // 3. Compute redaction zones from the renderer's element layout
    const zones = await this.computeRedactionZones(region);

    // 4. Apply redactions (blur + overlay text)
    image = await this.applyRedactions(image, zones);

    // 5. Strip EXIF
    image = await sharp(image).withMetadata({}).png().toBuffer();

    return image;
  }

  private async computeRedactionZones(region: Region): Promise<RedactionZone[]> {
    // The renderer reports the bounding rects of:
    //   .url-bar, .tab .title, .profile-chip, .icon-btn .badge, .warp-pill
    return await ipcInvoke('phantom:get-redaction-zones', region);
  }

  private async applyRedactions(buf: Buffer, zones: RedactionZone[]): Promise<Buffer> {
    // Composite blur + text overlays via sharp
    const blurs = await Promise.all(zones
      .filter(z => z.kind === 'blur' || z.kind === 'replace')
      .map(async z => {
        const region = await sharp(buf).extract({ left: z.x, top: z.y, width: z.w, height: z.h })
          .blur(20).toBuffer();
        return { input: region, top: z.y, left: z.x };
      }));
    let out = await sharp(buf).composite(blurs).toBuffer();

    // Then overlay replacement text (URL bar → "Private Browser", etc.)
    const textOverlays = await Promise.all(zones.filter(z => z.kind === 'replace')
      .map(z => this.renderTextOverlay(z)));
    out = await sharp(out).composite(textOverlays).toBuffer();

    return out;
  }

  private async renderTextOverlay(zone: RedactionZone): Promise<sharp.OverlayOptions> {
    // Use Node Canvas to render the replacement text matching browser's font
    const { createCanvas } = await import('canvas');
    const canvas = createCanvas(zone.w, zone.h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2c2c2e';
    ctx.fillRect(0, 0, zone.w, zone.h);
    ctx.fillStyle = '#a0a0a8';
    ctx.font = '13px -apple-system';
    ctx.textBaseline = 'middle';
    ctx.fillText(zone.replacementText!, 12, zone.h / 2);
    return { input: canvas.toBuffer('image/png'), top: zone.y, left: zone.x };
  }
}
```

#### What Gets Redacted

| Element | Replacement |
|---|---|
| URL bar | "Private Browser" |
| Tab titles (other tabs) | "Tab 1", "Tab 2", … |
| Active tab title | Blurred |
| Profile name chip | Hidden |
| WARP latency | "Protected" |
| Notification badges | Hidden |
| Vault active permissions | Hidden |
| EXIF metadata | Stripped from output PNG |

The user can toggle individual redactions in the preview, and add manual blur rectangles by drawing them.

---

### 6.11 Custom Homepage & Dashboard

**Purpose.** Every profile opens to its own configured homepage. Default is the built-in privacy dashboard.

#### Default Dashboard Widgets

| Widget | Source data |
|---|---|
| Profile name + colour | `profiles.current()` |
| WARP status + region | `warp.status()` |
| Time-to-next-wipe | `wipeEngine.nextWipeAt(profile)` |
| Active container count | `containers.activeCount(profile)` |
| Vault state | `vault.stateFor(profile)` |
| Search bar | DuckDuckGo by default, configurable |
| Quick links (up to 8) | `profile.quickLinks` |
| Today's privacy report | `report.today(profile)` |

Every widget is independently toggleable in profile settings.

#### Implementation

The dashboard is a React component served from a special internal URL `phantom://dashboard`. The custom protocol is registered in main:

```ts
import { protocol } from 'electron';

app.whenReady().then(() => {
  protocol.handle('phantom', (request) => {
    const url = new URL(request.url);
    if (url.host === 'dashboard') {
      return new Response(dashboardHtml, { headers: { 'content-type': 'text/html' } });
    }
    return new Response('not found', { status: 404 });
  });
});
```

The dashboard HTML loads `dashboard.bundle.js` which queries main process state via `phantom.api.dashboard.snapshot()` exposed through the preload script.

#### Decoy Profile Homepage

Configured during decoy setup. Options:
- A real-looking news site URL (loads through WARP normally)
- A blank search page
- A fake work dashboard (custom HTML stored in profile)
- Any custom URL

The decoy homepage is the **first thing visible after decoy PIN entry**. It must look unremarkable.

---

### 6.12 Local Network Messaging

**Purpose.** Built-in messaging that works only between users on the same WiFi. No servers, no accounts, no internet. Messages travel directly between devices via mDNS discovery + WebSocket transport, encrypted with libsodium.

#### Protocol Overview

```
Device A                           Device B
   │                                  │
   │── mDNS broadcast ──────────────▶│  (every 30s)
   │  _phantom._tcp.local             │
   │  TXT: { pubkey, name, color }    │
   │                                  │
   │◀───────── mDNS broadcast ────────│
   │                                  │
   │── WS connect ──────────────────▶│  (peer-initiated)
   │   handshake: exchange box pubkey │
   │                                  │
   │◀══════ encrypted message ═══════▶│
   │   crypto_box(msg, recipientPub, │
   │              myPriv, nonce)      │
```

#### mDNS Discovery (`src/main/messaging/mdns.ts`)

```ts
import { Bonjour } from 'bonjour-service';
import sodium from 'sodium-native';

class MdnsDiscovery {
  private bonjour = new Bonjour();
  private myService: any;
  private peers = new Map<string, Peer>();

  async start(displayName: string, color: string) {
    // Generate fresh keypair every session — perfect forward secrecy
    const pubKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
    const privKey = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
    sodium.crypto_box_keypair(pubKey, privKey);
    this.privKey = privKey;

    const port = await this.startWebSocketServer(privKey);

    // Broadcast our presence
    this.myService = this.bonjour.publish({
      name: `phantom-${randomId()}`,
      type: 'phantom',
      port,
      txt: {
        v: '1',
        pubkey: pubKey.toString('base64'),
        name: displayName,
        color,
      }
    });

    // Discover peers
    const browser = this.bonjour.find({ type: 'phantom' });
    browser.on('up', service => this.onPeerDiscovered(service));
    browser.on('down', service => this.onPeerLost(service));
  }

  async stop() {
    this.myService?.stop();
    this.bonjour.destroy();
    sodium.sodium_memzero(this.privKey);
    this.peers.clear();
  }
}
```

#### Encrypted Message Transport

```ts
import sodium from 'sodium-native';

interface WireMessage {
  v: 1;
  type: 'dm' | 'room' | 'broadcast';
  room?: string;
  nonce: string;     // base64
  ciphertext: string; // base64
  fromPubkey: string;
}

function encryptForPeer(plaintext: string, peerPubKey: Buffer, myPrivKey: Buffer): WireMessage {
  const nonce = Buffer.alloc(sodium.crypto_box_NONCEBYTES);
  sodium.randombytes_buf(nonce);
  const msg = Buffer.from(plaintext, 'utf8');
  const ct = Buffer.alloc(msg.length + sodium.crypto_box_MACBYTES);
  sodium.crypto_box_easy(ct, msg, nonce, peerPubKey, myPrivKey);
  return {
    v: 1, type: 'dm',
    nonce: nonce.toString('base64'),
    ciphertext: ct.toString('base64'),
    fromPubkey: ourPubkey.toString('base64'),
  };
}

function decryptFromPeer(wire: WireMessage, senderPubKey: Buffer, myPrivKey: Buffer): string | null {
  const ct = Buffer.from(wire.ciphertext, 'base64');
  const nonce = Buffer.from(wire.nonce, 'base64');
  const pt = Buffer.alloc(ct.length - sodium.crypto_box_MACBYTES);
  const ok = sodium.crypto_box_open_easy(pt, ct, nonce, senderPubKey, myPrivKey);
  return ok ? pt.toString('utf8') : null;
}
```

#### Rooms

Rooms are named groups. Anyone on the network can create one. Joining a room does **not** show prior history — you only see messages sent after you joined.

```ts
interface Room {
  name: string;
  isPrivate: boolean;
  passwordHash?: string;       // Argon2 if private + password
  members: Set<string>;         // pubkeys of current members
  symmetricKey?: Buffer;        // for room messages, derived if password-protected
}

class RoomManager {
  async create(name: string, opts: { private?: boolean; password?: string }) { /* ... */ }
  async join(name: string, password?: string) { /* ... */ }
  async send(room: Room, message: string) {
    // For rooms, use symmetric key derived from room password (or random if public)
    // and broadcast to all members
  }
}
```

#### Persistence Rules

| State | Storage |
|---|---|
| Unpinned messages | In-memory only; gone on browser close |
| Pinned messages | Encrypted file `pinned-messages.enc` in profile dir |
| 24h wipe | Even pinned messages cleared |
| Custom pin expiry | User can set `expiresAt` per pinned message |
| Panic | All messages wiped instantly, mDNS stopped |

#### Presence

```ts
type Presence = 'active' | 'away' | 'offline';

class PresenceTracker {
  private lastActivity = Date.now();

  // Update from any user input
  bumpActivity() { this.lastActivity = Date.now(); }

  current(): Presence {
    const idle = Date.now() - this.lastActivity;
    return idle > 10 * 60 * 1000 ? 'away' : 'active';
  }
}

// mDNS heartbeat broadcasts presence every 30s
setInterval(() => {
  mdns.updateTxt({ presence: presenceTracker.current() });
}, 30000);

// Peer marked offline if heartbeat lost for 30s
function onPeerHeartbeatLost(peerId: string) {
  setTimeout(() => {
    if (!peerSeenSince(peerId, Date.now() - 30000)) markOffline(peerId);
  }, 30000);
}
```

#### Critical Invariants

- **No internet path:** the mDNS protocol is link-local only. WebSockets connect to peer's IP on the local network. Traffic never exits the LAN.
- **Bypasses WARP:** since this is local-only, the WebSocket connections are excluded from the proxy via the `<local>` bypass rule.
- **Fresh keys every launch:** the libsodium keypair is regenerated on every browser launch. Past messages cannot be decrypted even if old keys are recovered later.
- **Decoy profile has no messaging panel** (or shows a clean empty one).

---
### 6.13 Same-Machine Profile Bridge

#### Purpose

Allows the user to send a tab, link, or note from one of their own profiles to another **without** that data ever leaving the local machine, without the two profiles seeing each other's cookies, history, or vault, and without using the local-network messaging system (which would be overkill for same-machine transfer).

#### Architecture

```
┌────────────────────────┐         ┌────────────────────────┐
│  Profile A (Renderer)  │         │  Profile B (Renderer)  │
│   "Send tab to Work"   │         │   Inbox notification   │
└──────────┬─────────────┘         └──────────▲─────────────┘
           │ ipcRenderer.invoke              │ ipcRenderer.on
           ▼                                  │
┌──────────────────────────────────────────────────────────┐
│                  Main Process — BridgeHub                 │
│  • routes by destination profile UUID                     │
│  • encrypts payload with libsodium (defence in depth)     │
│  • drops if destination is decoy or has bridge disabled   │
└──────────────────────────────────────────────────────────┘
```

The bridge is a main-process service. Renderers never talk directly to each other — every payload passes through `BridgeHub` in the main process, which enforces the opt-in checks.

#### Shareable / Never-Shareable

| Allowed across the bridge | Blocked at the bridge |
|---|---|
| Tab URL + title | Cookies and storage |
| Plain links | Browsing history |
| Plain text notes | Vault grants |
| Files the user explicitly attaches | Container partitions |
| | Saved passwords or autofill data |
| | Anything from a hidden or decoy profile |

#### Implementation

```typescript
// src/main/bridge/BridgeHub.ts
import { ipcMain, BrowserWindow, Notification } from 'electron';
import sodium from 'libsodium-wrappers';

type BridgePayload =
  | { kind: 'tab';  url: string; title: string }
  | { kind: 'link'; url: string }
  | { kind: 'note'; text: string }
  | { kind: 'file'; name: string; bytes: Uint8Array };

interface BridgeMessage {
  fromProfile: string;
  toProfile: string;
  payload: BridgePayload;
  sentAt: number;
}

export class BridgeHub {
  // Per-profile opt-in. Default OFF; user must enable in Settings.
  private bridgeEnabled = new Map<string, boolean>();
  // Per-profile inbox key (defence in depth — even main-process memory is encrypted).
  private inboxKeys = new Map<string, Uint8Array>();

  constructor(private profileManager: ProfileManager) {
    ipcMain.handle('bridge:send', this.handleSend.bind(this));
    ipcMain.handle('bridge:setEnabled', (_e, on: boolean) => {
      const profile = this.profileManager.current();
      this.bridgeEnabled.set(profile.id, on);
    });
    ipcMain.handle('bridge:listProfiles', this.listEligibleTargets.bind(this));
  }

  private listEligibleTargets() {
    const me = this.profileManager.current();
    return this.profileManager
      .all()
      .filter(p => p.id !== me.id)
      .filter(p => !p.isHidden && !p.isDecoy)
      .filter(p => this.bridgeEnabled.get(p.id) === true)
      .map(p => ({ id: p.id, name: p.name, color: p.color }));
  }

  private async handleSend(_e: Electron.IpcMainInvokeEvent, msg: BridgeMessage) {
    const sender = this.profileManager.current();

    // Hard rule: decoys cannot send.
    if (sender.isDecoy) return { ok: false, reason: 'decoy_blocked' };

    // Sender must have bridge ON.
    if (!this.bridgeEnabled.get(sender.id)) return { ok: false, reason: 'sender_disabled' };

    // Receiver must have bridge ON and must not be decoy/hidden.
    const target = this.profileManager.byId(msg.toProfile);
    if (!target || target.isDecoy || target.isHidden) {
      return { ok: false, reason: 'invalid_target' };
    }
    if (!this.bridgeEnabled.get(target.id)) return { ok: false, reason: 'receiver_disabled' };

    // Encrypt with target's inbox key (in-memory only; rotated on every browser launch).
    const key = this.inboxKey(target.id);
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const cipher = sodium.crypto_secretbox_easy(
      sodium.from_string(JSON.stringify(msg)), nonce, key
    );

    // Deliver to target profile's window if open; otherwise queue in memory.
    const targetWindow = this.findWindowForProfile(target.id);
    if (targetWindow) {
      targetWindow.webContents.send('bridge:incoming', { nonce, cipher });
    } else {
      this.queueForProfile(target.id, { nonce, cipher });
    }

    // OS notification on the target side.
    new Notification({
      title: 'Bridge',
      body: `${sender.name} sent you a ${msg.payload.kind}`,
      silent: false
    }).show();

    return { ok: true };
  }

  private inboxKey(profileId: string): Uint8Array {
    let k = this.inboxKeys.get(profileId);
    if (!k) {
      k = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
      this.inboxKeys.set(profileId, k);
    }
    return k;
  }
}
```

```typescript
// src/renderer/bridge/SendTab.ts — invoked from the tab right-click menu
async function sendCurrentTabTo(targetProfileId: string) {
  const tab = activeTab();
  await window.bridge.send({
    fromProfile: currentProfile.id,
    toProfile: targetProfileId,
    payload: { kind: 'tab', url: tab.url, title: tab.title },
    sentAt: Date.now()
  });
}
```

#### Privacy Safeguards

- **Both sides must opt in** before any bridge communication is possible. Default is off for every profile.
- **Decoy profiles can neither send nor receive.** A decoy must look like an isolated, normal browser session.
- **Hidden profiles never appear** in the target dropdown of any other profile.
- **Inbox keys rotate on every launch** — queued messages from a previous session are unrecoverable.
- **No persistent log** of bridge messages on disk. Inbox is in-memory and is wiped along with everything else on the 24-hour cycle or on panic.
- **Files are passed by value** (copied into the target profile's downloads), not by reference. The two profiles never share a filesystem handle.

---

### 6.14 Notification System

#### Purpose

Web push and `Notification` API messages are leaks waiting to happen — they persist across sessions, can identify the user via push subscriptions, and can betray a hidden or decoy profile by surfacing a notification from the "real" one. Phantom intercepts every notification, treats them as session-scoped by default, and silences decoys completely.

#### Behaviour

| Profile state | Notification behaviour |
|---|---|
| Standard profile | Shown via OS notification centre. Wiped on the 24-hour cycle along with everything else. |
| Standard, user-exempted site | Persists past wipes for that origin only. |
| Hidden profile | Shown only while the hidden profile is unlocked and active. |
| Decoy profile | **All notifications hard-blocked.** No OS notification, no in-app indicator. |
| Locked (PIN screen up) | Queued silently, surfaced on unlock. |
| After panic | Inbox cleared; push subscriptions revoked. |

#### Implementation

```typescript
// src/main/notifications/NotificationGuard.ts
import { app, session, Notification } from 'electron';

export function installNotificationGuard(profile: ProfileContext) {
  const ses = profile.session;

  // 1. Permission gate — decoy is hard-no.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'notifications') {
      if (profile.isDecoy) return callback(false);
      return callback(profile.notificationsAllowed(permissionOriginOf(_wc)));
    }
    // ... other permissions handled elsewhere
  });

  // 2. Intercept the actual fire so we can record it for the wipe cycle
  //    and strip identifying tags before it hits the OS.
  app.on('web-contents-created', (_e, wc) => {
    if (wc.session !== ses) return;
    wc.on('-notification' as any, (event: any, options: any) => {
      if (profile.isDecoy) { event.preventDefault(); return; }

      // Drop tag — used by sites to track + correlate.
      delete options.tag;

      // Record so the wipe engine can clear it on the 24h cycle.
      profile.notificationLog.add({
        origin: permissionOriginOf(wc),
        firedAt: Date.now()
      });
    });
  });
}
```

The wipe engine then clears `notificationLog`, the OS notification centre entries created by the app, and any push subscriptions that aren't on the user's exemption list.

#### Hard Rules

- A decoy profile **never** fires a notification, even if a website has been previously granted permission in another profile. Permissions are per-profile.
- A push subscription is **never** persisted across the 24-hour wipe unless the user has explicitly added the origin to the exemption list.
- The OS notification body shows the **profile name as the title prefix** (e.g. `[Work] Slack — new message`) so that a notification surfacing while a different profile is active cannot be misread.

---

## 7. Feature Interaction Map

This is the most important section of the document. Phantom's security guarantees come not from any single feature but from how they cascade. The table below describes the exact chain that fires for each user-visible event. Engineers should treat this as the contract — any code change that breaks one of these cascades is a security regression, not just a bug.

| Event | Cascading behaviour |
|---|---|
| **App launch** | (1) Spawn `warp-svc` daemon. (2) Block all renderer creation until WARP reports `Connected` and DNS handshake completes. (3) Load `profiles-index.enc` from disk and prompt for unlock if multi-profile is enabled. (4) Start mDNS messaging discovery. (5) Decrypt the active profile's tab snapshot and create lazy tab placeholders (no navigation yet). (6) Start the wipe scheduler. (7) Show PIN screen if PIN-on-launch is enabled. |
| **PIN entered correctly** | (1) Renderers are unblurred. (2) Vault returns to `Locked` (any in-flight `Session` grants are dropped). (3) Lazy tab placeholders are now navigable. (4) Bridge inbox flushes any messages queued while locked. (5) Notification queue surfaces in OS notification centre. |
| **Decoy PIN entered** | (1) Real session is wiped synchronously in the background — cookies, cache, history, snapshots, vault, notification log, bridge inbox. (2) Decoy profile is mounted from its own encrypted folder. (3) WARP stays connected (the decoy must look like a normal Phantom session). (4) Bridge is forcibly disabled for the decoy. (5) Messaging panel is hidden. (6) From this point the user can only return to a real profile by relaunching the app. |
| **24-hour wipe fires** | (1) Pause renderer navigation. (2) Snapshot tab URLs/titles/order to encrypted file. (3) `session.clearStorageData()` for cookies/cache/localStorage/serviceWorkers/indexedDB. (4) Clear history database. (5) Clear notification log + push subscriptions (minus exemptions). (6) Clear bridge inbox. (7) Clear privacy report counters older than 24h. (8) Resume navigation; tabs reload lazily as the user clicks them. |
| **Panic triggered** | See §6.9 for full sequence. WARP **stays up**. Vault locks. Renderers destroyed. Profiles wiped (including decoys' wipe markers). Snapshots deleted. Bridge inbox cleared. Messaging shut down. Clipboard cleared. App reloads to homepage. |
| **Profile switched** | (1) Save current profile's tab snapshot. (2) Tear down all renderer windows of the outgoing profile. (3) Vault locks. (4) Bridge is paused mid-switch (no cross-profile leakage). (5) Mount new profile's session partition. (6) Restore lazy tabs from new profile's snapshot. (7) WARP stays connected throughout. |
| **Container changed on a tab** | (1) Tab navigates to `about:blank`. (2) Origin storage of the *outgoing* container for that origin is cleared. (3) Tab is recreated under the new partition. (4) Tab pill underline colour updates. (5) Vault grants — which are per-origin — re-evaluate against the new partition. |
| **Link clicked** | (1) `webRequest.onBeforeRequest` runs the link sanitiser. (2) Tracking parameters stripped; URL rewritten via `redirectURL`. (3) Privacy report increments per parameter family. (4) Navigation proceeds inside the WARP tunnel, with the kill switch ready to drop the request if WARP is down. |
| **Camera or mic requested** | (1) Permission handler checks Vault state. (2) If `Locked`, request is denied and a toast appears in the URL bar. (3) If `Session`, granted for this tab + origin only, evaporated when the tab closes or the profile switches. (4) If `Timed`, granted with a countdown; a background timer auto-revokes. (5) Toolbar indicator turns red while permission is live. |
| **Window loses focus** | (1) CSS `--blur-amount` flips from `0px` to `12px` on the renderer root. (2) `setContentProtection(true)` is verified active. (3) If unfocused for >2 minutes, the screen blackouts (sleep-style) regardless of OS sleep state. |
| **Peer joins the LAN** | (1) mDNS service discovery announces the new peer with its public key in the TXT record. (2) Peer appears in the messaging panel as "active". (3) No connection is opened — peer is discovered but not contacted until the user explicitly messages them. |
| **Peer leaves the LAN** | (1) mDNS goodbye received, or heartbeat lost for 30s. (2) Peer marked offline in the panel. (3) Open WebSocket to that peer is closed. (4) Their public key is forgotten on the next browser launch (fresh-key-per-session means they will re-announce a new identity anyway). |
| **Tab sent via the bridge** | (1) `BridgeHub` validates both sides have the bridge enabled and neither is a decoy. (2) Payload encrypted with the target profile's in-memory inbox key. (3) If the target profile window is open, payload is delivered live; otherwise it is queued in memory until the next time that profile is unlocked. (4) OS notification fires on the target side, prefixed with the sending profile's name. |
| **Failed PIN attempts exceed limit** | (1) Lockout timer starts (60s × 2^attempts capped at 1h). (2) On the configured threshold (default 5 wrong attempts), the panic sequence fires automatically. (3) WARP stays up. (4) App reloads to a clean homepage and demands re-unlock. |

---
## 8. Build Roadmap

The features are designed to be implemented in a strict order. Earlier phases produce the security primitives later phases depend on. Skipping ahead — for example, building Containers before the Wipe Engine exists — leaves the project in a state where features look done but actually leak data on every launch.

### Phase 1 — Core Infrastructure (Weeks 1–4)

Goal: a single-profile browser that is provably routing all traffic through WARP and that wipes itself cleanly on shutdown.

- Electron + Chromium shell with custom chrome (top bar, tab strip, sidebar shell)
- WARP integration: bundled `warp-svc` / `warp-cli`, daemon lifecycle, proxy URL wired into Electron via `app.commandLine.appendSwitch('proxy-server', …)`
- Kill switch interceptor in `webRequest.onBeforeRequest`
- DoH (Cloudflare 1.1.1.1) inside the tunnel
- Single-profile session persistence + manual "Wipe now" button
- Status bar showing WARP / DNS / kill-switch state

**Exit criteria:** `tcpdump` on the host shows zero traffic except the WireGuard handshake to `engage.cloudflareclient.com`. Closing the app and re-opening it produces an empty cookie jar.

### Phase 2 — Security Hardening (Weeks 5–8)

Goal: the security perimeter is real, not just visible.

- Multi-profile system with encrypted folders + `profiles-index.enc`
- Argon2 PIN system with OS keychain integration
- Lock-on-sleep via `powerMonitor`
- Decoy / Ghost profile creation flow
- Hidden profile unlock-phrase flow
- Camera/Mic Vault with three states + permission handler override
- Screenshot protection: focus-loss blur, sleep blackout, `setContentProtection(true)`, `SetWindowDisplayAffinity` on Windows via `koffi`
- Panic button (keyboard, double-click, shake) with full cascade

**Exit criteria:** an external screen recorder produces a black frame for the Phantom window. A wrong PIN entered N times triggers a clean panic. A decoy PIN produces a believable-looking empty browser session within 200ms.

### Phase 3 — User Features (Weeks 9–12)

Goal: the daily-driver experience.

- Session containers (Default, Work, Social, Finance, Research) with per-partition `session` instances
- Finance container hardening (no extensions, fingerprint randomisation, third-party cookies hard-blocked)
- Link sanitiser with full tracker list
- Safe screenshot tool with URL-bar / tab-title redaction + EXIF strip
- Custom homepage / privacy dashboard at `phantom://dashboard`
- Decoy homepage variants
- 24-hour wipe scheduler with encrypted tab snapshot + lazy reload

**Exit criteria:** A user can run a workday inside Phantom without falling back to another browser. Privacy dashboard counters match what `webRequest` actually saw.

### Phase 4 — Messaging & Bridge (Weeks 13–16)

Goal: ambient privacy-preserving communication.

- mDNS / Bonjour discovery with libsodium identity
- WebSocket transport, encrypted with `crypto_box_easy`
- Rooms with optional password (Argon2 → symmetric key)
- Presence (active / away / offline)
- Same-machine bridge with opt-in per profile
- Notification interception + per-profile policy
- Decoy hard-exclusions for both bridge and messaging

**Exit criteria:** Two Phantom instances on the same Wi-Fi can chat without a single byte leaving the LAN (`tcpdump` on the gateway confirms). A bridge from Profile A to Profile B does not appear in Profile C's UI even if Profile C is the active one at the moment.

---

## 9. Development Setup

### Prerequisites

- **Node.js** 20.x or newer
- **npm** 10.x or newer (or pnpm / yarn — examples use npm)
- **Python 3** + a C/C++ toolchain (required by `node-gyp` for `libsodium-wrappers` native bindings on first install)
  - Linux: `build-essential`, `libnss3`, `libxss1`, `libasound2`
  - macOS: Xcode Command Line Tools
  - Windows: "Desktop development with C++" workload from Visual Studio Build Tools
- **Cloudflare WARP binaries** placed under `resources/warp/<platform>/` — see below

### Getting Started

```bash
# 1. Clone and install
git clone https://github.com/<your-org>/phantom-browser.git
cd phantom-browser
npm install

# 2. Drop in the WARP binaries (these are NOT redistributed — fetch from Cloudflare)
mkdir -p resources/warp/{darwin,win32,linux}
# macOS:    copy warp-svc and warp-cli from /Applications/Cloudflare WARP.app
# Windows:  copy warp-svc.exe and warp-cli.exe from "C:\Program Files\Cloudflare\Cloudflare WARP\"
# Linux:    install cloudflare-warp package, copy /usr/bin/warp-cli + /usr/bin/warp-svc

# 3. Run in dev mode (renderer hot-reload, main process auto-restart)
npm run dev

# 4. Run the test suite (security invariants are part of the suite)
npm test

# 5. Package for the current platform
npm run package          # produces an unpacked build under dist/
npm run dist             # produces a signed installer (DMG / NSIS / AppImage)
```

### `package.json` scripts (excerpt)

```json
{
  "scripts": {
    "dev": "concurrently -k \"vite\" \"electron-forge start --inspect\"",
    "build": "tsc -p tsconfig.main.json && vite build",
    "package": "electron-builder --dir",
    "dist": "electron-builder",
    "test": "vitest run && playwright test",
    "test:security": "vitest run tests/security",
    "lint": "eslint . --ext .ts,.tsx",
    "typecheck": "tsc --noEmit"
  }
}
```

### `electron-builder` configuration (excerpt)

```yaml
appId: com.phantombrowser.app
productName: Phantom
asar: true
asarUnpack:
  - resources/warp/**/*           # WARP binaries must be unpacked to be executable
extraResources:
  - from: resources/warp/${os}
    to:   warp
    filter: ["**/*"]
mac:
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  notarize: true
win:
  target: nsis
  signAndEditExecutable: true
linux:
  target: [AppImage, deb]
  category: Network
```

### Project Layout in Practice

```
phantom-browser/
├── src/
│   ├── main/               # Electron main process — security-critical
│   │   ├── index.ts        # bootstrap, blocks until WARP up
│   │   ├── warp/           # WarpManager
│   │   ├── profiles/       # ProfileManager + encrypted index
│   │   ├── pin/            # PinSystem, ghost mode, decoy
│   │   ├── vault/          # Camera/Mic Vault
│   │   ├── containers/     # ContainerManager
│   │   ├── wipe/           # WipeEngine + TabSnapshotManager
│   │   ├── panic/          # PanicSystem
│   │   ├── bridge/         # BridgeHub
│   │   ├── messaging/      # mDNS + libsodium transport
│   │   ├── screenshot/     # SafeScreenshot + display-affinity
│   │   └── dashboard/      # phantom:// protocol
│   ├── renderer/           # All UI code — see phantom-browser-ui.html for the design reference
│   │   ├── chrome/         # Top bar, tab strip, sidebar
│   │   ├── dashboard/      # Homepage widgets
│   │   ├── popovers/       # Profile switcher, vault, messaging
│   │   └── lock/           # PIN screen
│   └── shared/             # Type definitions used by both processes
├── resources/
│   └── warp/               # Bundled WARP binaries (ignored by git)
├── tests/
│   ├── security/           # Invariant tests — see below
│   ├── unit/
│   └── e2e/                # Playwright
└── build/                  # Code-signing certs, entitlements, icons
```

### Security Invariant Tests (`tests/security/`)

These are not optional. Every PR runs them; failure is a release blocker.

- `kill-switch.spec.ts` — kill WARP mid-request and assert no packet escapes
- `wipe-cycle.spec.ts` — fire wipe and assert cookies/history/cache/notifications all gone
- `decoy-isolation.spec.ts` — log into a site in real profile, enter decoy PIN, assert decoy sees no cookie / no history / no vault grant from the real one
- `bridge-decoy-block.spec.ts` — assert decoy never appears as bridge target and cannot send
- `messaging-no-internet.spec.ts` — start messaging, assert zero packets to non-RFC1918 destinations
- `screenshot-protection.spec.ts` — invoke OS screen capture, assert frame is black or `WDA_EXCLUDEFROMCAPTURE` is set
- `panic-warp-stays-up.spec.ts` — fire panic, assert WARP daemon is still `Connected` afterward

---

## 10. Core Security Principles

These are the seven principles every contributor must internalise. When in doubt during a code review, return to this list — anything that violates one of them is wrong, no matter how convenient.

### 1. Zero Trust Default

Every feature is *off* until the user turns it on. Notifications are wiped, bridge is disabled, containers default to the most-isolated option, push subscriptions are dropped on every wipe. The user has to *opt in* to any persistence; the system never opts them in. This is the inverse of every mainstream browser.

### 2. No Persistent Identity

Phantom is identity-less by design. There is no account, no telemetry ID, no "your Phantom" cloud sync. Profiles are anonymous UUIDs on disk. Messaging keys regenerate every launch. Push subscriptions die on every 24-hour wipe. The browser is a tool, not a relationship.

### 3. Separation of Layers

The four-layer architecture (Network / Storage / Identity / Communication) is enforced by partitions, not by convention. A bug in the messaging layer cannot leak cookies because the messaging layer is in a different `session.fromPartition`. A bug in the bridge cannot leak vault grants because the vault is in main-process memory the bridge cannot reach. **Don't paper over a layer-violation bug — fix the layering.**

### 4. Deniability at Every Level

Phantom must withstand a "show me your browser" request. Decoys, ghost mode, hidden profiles, encrypted profile names, and the always-clean homepage exist so that the *visible* state of the browser carries no information about the *real* state. A forensic examination of the disk should reveal indistinguishable encrypted blobs, not labelled-by-purpose folders.

### 5. No Trace Unless Chosen

The 24-hour wipe is the floor, not the ceiling. Anything that survives a wipe must be the result of an explicit user choice — a site exempted from notifications, a download saved deliberately, a tab pinned. Default behaviour is *forget*. If you find yourself adding a "let's keep this around in case the user wants it" cache, you are wrong; the user can ask for it back.

### 6. Encryption Everywhere

- Profile folders: encrypted at rest with keys derived from PIN + OS keychain entropy.
- Tab snapshots: libsodium `secretbox` with per-profile keys.
- Bridge inbox: libsodium `secretbox` with in-memory keys rotated per launch.
- Messaging: libsodium `box` with per-launch keypairs (perfect forward secrecy).
- DNS: DoH inside the WARP tunnel.
- IPC where it crosses a trust boundary: encrypted even though it never leaves the process.

If a piece of data exists somewhere outside main-process RAM, it is encrypted. No exceptions.

### 7. Kill Switch Non-Negotiable

The browser will refuse to make a single request unless WARP is up. There is no "fall back to clearnet for just a moment" mode. There is no "the user said it's OK". The kill switch is enforced in `webRequest.onBeforeRequest`, which is the lowest-level interceptor Electron exposes; if it fails closed there, the request never reaches the OS socket layer.

This is the one principle that has no override and no settings toggle. Everything else is configurable; the kill switch is not.

---

## 11. Infrastructure Cost

Phantom is a desktop application. It has no servers, no accounts, no telemetry, no cloud sync, no analytics backend. The infrastructure cost is therefore zero, and that is by design — a privacy-first product that has servers to bill you against has servers that can be subpoenaed.

| Component | Hosted by | Cost |
|---|---|---|
| WARP VPN | Cloudflare (free tier, no account required) | $0 |
| DNS resolver | `1.1.1.1` over DoH (free) | $0 |
| Profile storage | User's own disk | $0 |
| Local-network messaging | mDNS + WebSocket on the user's LAN | $0 |
| Push / sync | Not implemented (intentional) | $0 |
| Telemetry / analytics | Not implemented (intentional) | $0 |
| Update channel | GitHub Releases (or self-hosted static file) | $0 |
| **Total recurring** | | **$0/month** |

The only non-zero costs are the one-time-ish ones associated with shipping any desktop application: an Apple Developer ID for notarisation (~$99/year), a Windows code-signing certificate (~$200/year), and a domain name. None of those are "infrastructure" in the running-the-product sense.

---

## 12. License & Acknowledgements

Phantom Browser is built on the shoulders of the open-source community:

- [Electron](https://www.electronjs.org/) — the desktop runtime
- [Chromium](https://www.chromium.org/) — the rendering engine
- [Cloudflare WARP](https://1.1.1.1/) — the VPN tunnel
- [libsodium](https://libsodium.gitbook.io/) — the cryptography
- [Argon2](https://github.com/P-H-C/phc-winner-argon2) — the PIN hashing
- [bonjour-service](https://github.com/onlxltd/bonjour-service) — mDNS discovery
- [sharp](https://sharp.pixelplumbing.com/) — image processing for the safe screenshot tool

Phantom itself is released under the **GPL-3.0** license. A privacy tool whose source you cannot read is not a privacy tool.

---

*"The best privacy is the one that costs nothing to maintain — yours, or theirs."*
