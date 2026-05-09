'use strict';

/**
 * WARP daemon supervisor for Ram Browser.
 *
 * Manages the Cloudflare WARP CLI:
 *   1. On first launch, registers and configures WARP in proxy mode.
 *   2. Polls connection status every 3 seconds.
 *   3. Reconnects on failure (max 3 attempts in 30s, then activates kill switch).
 *   4. Listens for network changes and reconnects.
 *
 * The supervisor degrades gracefully when warp-cli is not installed.
 */

const { exec } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { powerMonitor, net } = require('electron');

const POLL_INTERVAL_MS = 3_000;
const MAX_RESTARTS_IN_WINDOW = 3;
const RESTART_WINDOW_MS = 30_000;
const WARP_PROXY_PORT = 40000;

class WarpSupervisor extends EventEmitter {
  constructor() {
    super();
    this._poll = null;
    this._status = { connected: false, latencyMs: null, city: null, country: null };
    this._restartHistory = []; // timestamps of recent restarts
    this._killSwitchActive = false;
    this._installed = null; // null = unknown, true/false after first check
  }

  async start() {
    // Check if warp-cli is installed
    this._installed = await this._isInstalled();
    if (!this._installed) {
      this.emit('status', { ...this._status, error: 'warp-cli not installed' });
      return;
    }

    // One-time setup (idempotent — safe to call even if already done)
    await this._setup();

    // Connect
    await this._connect();

    // Start polling
    this._poll = setInterval(() => this._pollStatus(), POLL_INTERVAL_MS);
    if (this._poll.unref) this._poll.unref();

    // Reconnect on network change — store refs so stop() can remove them
    this._onResume = () => this._handleNetworkChange();
    this._onOnline = () => this._handleNetworkChange();
    powerMonitor.on('resume', this._onResume);
    try { net.on?.('online', this._onOnline); } catch {}
  }

  stop() {
    if (this._poll) {
      clearInterval(this._poll);
      this._poll = null;
    }
    if (this._onResume) { powerMonitor.off('resume', this._onResume); this._onResume = null; }
    try { if (this._onOnline) net.off?.('online', this._onOnline); } catch {}
    this._onOnline = null;
  }

  getStatus() {
    return { ...this._status, killSwitch: this._killSwitchActive };
  }

  // ── private ─────────────────────────────────────────────────────────────────

  async _isInstalled() {
    return new Promise((resolve) => {
      exec('warp-cli --version', (err) => resolve(!err));
    });
  }

  async _setup() {
    // Set proxy mode and port (idempotent)
    await this._run('warp-cli set-mode proxy').catch(() => {});
    await this._run(`warp-cli set-proxy-port ${WARP_PROXY_PORT}`).catch(() => {});
    // Accept TOS on first launch (no-op if already accepted)
    await this._run('warp-cli register --accept-tos').catch(() => {});
  }

  async _connect() {
    await this._run('warp-cli connect').catch(() => {});
  }

  async _pollStatus() {
    if (!this._installed) return;

    try {
      const raw = await this._run('warp-cli status');
      const connected = /Connected/i.test(raw);
      const latencyMatch = raw.match(/(\d+)\s*ms/);
      const latencyMs = latencyMatch ? parseInt(latencyMatch[1], 10) : null;
      const cityMatch = raw.match(/city:\s*([^\n,]+)/i);
      const city = cityMatch ? cityMatch[1].trim() : null;

      const prev = this._status.connected;
      this._status = { connected, latencyMs, city };

      if (!connected && prev) {
        // Just disconnected — attempt reconnect
        await this._handleDisconnect();
      } else if (connected && this._killSwitchActive) {
        // Reconnected — deactivate kill switch
        this._killSwitchActive = false;
        this.emit('kill-switch', false);
      }

      this.emit('status', this.getStatus());
    } catch {
      // Silently ignore poll errors
    }
  }

  async _handleDisconnect() {
    const now = Date.now();
    // Prune old entries outside the window
    this._restartHistory = this._restartHistory.filter(
      (t) => now - t < RESTART_WINDOW_MS
    );

    if (this._restartHistory.length >= MAX_RESTARTS_IN_WINDOW) {
      if (!this._killSwitchActive) {
        this._killSwitchActive = true;
        this.emit('kill-switch', true);
      }
      return;
    }

    this._restartHistory.push(now);
    await this._connect();
  }

  async _handleNetworkChange() {
    if (this._killSwitchActive) return;
    await this._connect();
  }

  _run(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: 10_000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout || '');
      });
    });
  }
}

const warpSupervisor = new WarpSupervisor();

module.exports = { warpSupervisor };
