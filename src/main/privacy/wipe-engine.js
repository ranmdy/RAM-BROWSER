'use strict';

/**
 * 24-hour wipe engine for Ram Browser.
 *
 * Each profile has an independent countdown timer. When the timer fires:
 *  1. Tab snapshot is saved (if rememberTabs is enabled).
 *  2. All Electron session storage for the profile's containers is cleared.
 *  3. The renderer is notified so it can reload the tab shell.
 *  4. The timer is rescheduled.
 *
 * The engine also broadcasts a live countdown to the renderer every second
 * via the 'wipe:countdown' IPC channel so the status bar can display it.
 */

const { session } = require('electron');
const { EventEmitter } = require('node:events');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const COUNTDOWN_TICK_MS = 1000;

class WipeEngine extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {timer: NodeJS.Timeout, scheduledAt: number, intervalMs: number}>} */
    this._timers = new Map();
    this._tickInterval = null;
  }

  /**
   * Start the global countdown tick (broadcasts wipe:countdown every second).
   * Call once after app is ready.
   */
  startTick() {
    if (this._tickInterval) return;
    this._tickInterval = setInterval(() => {
      this.emit('tick', this._allCountdowns());
    }, COUNTDOWN_TICK_MS);
  }

  stopTick() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }

  /**
   * Schedule a wipe for a profile.
   * @param {string} profileUuid
   * @param {string[]} partitions  Electron session partition names for this profile
   * @param {number} [intervalMs]
   */
  schedule(profileUuid, partitions, intervalMs = DEFAULT_INTERVAL_MS) {
    this.cancel(profileUuid);

    const scheduledAt = Date.now();
    const timer = setTimeout(() => {
      this._run(profileUuid, partitions, intervalMs);
    }, intervalMs);

    // Allow the process to exit even if the timer is pending
    if (timer.unref) timer.unref();

    this._timers.set(profileUuid, { timer, scheduledAt, intervalMs, partitions });
  }

  /**
   * Cancel a scheduled wipe.
   * @param {string} profileUuid
   */
  cancel(profileUuid) {
    const entry = this._timers.get(profileUuid);
    if (entry) {
      clearTimeout(entry.timer);
      this._timers.delete(profileUuid);
    }
  }

  /**
   * Immediately wipe a profile's session data (cancels any pending timer, does NOT reschedule).
   * @param {string} profileUuid
   * @param {string[]} partitions
   */
  async wipeNow(profileUuid, partitions) {
    this.cancel(profileUuid); // cancel any scheduled timer first
    this.emit('before-wipe', { profileUuid });
    await this._clearSessions(partitions);
    this.emit('wiped', { profileUuid, timestamp: Date.now() });
  }

  /**
   * Get seconds remaining until the next wipe for a profile.
   * @param {string} profileUuid
   * @returns {number|null}  seconds remaining, or null if not scheduled
   */
  secondsRemaining(profileUuid) {
    const entry = this._timers.get(profileUuid);
    if (!entry) return null;
    const elapsed = Date.now() - entry.scheduledAt;
    const remaining = Math.max(0, entry.intervalMs - elapsed);
    return Math.floor(remaining / 1000);
  }

  // ── private ─────────────────────────────────────────────────────────────────

  async _run(profileUuid, partitions, intervalMs) {
    this._timers.delete(profileUuid);

    this.emit('before-wipe', { profileUuid });
    await this._clearSessions(partitions);
    this.emit('wiped', { profileUuid, timestamp: Date.now() });

    // Reschedule
    this.schedule(profileUuid, partitions, intervalMs);
  }

  async _clearSessions(partitions) {
    const storageTypes = [
      'cookies',
      'filesystem',
      'indexdb',
      'localstorage',
      'shadercache',
      'websql',
      'serviceworkers',
      'cachestorage'
    ];

    await Promise.all(
      partitions.map(async (partition) => {
        try {
          const s = session.fromPartition(partition);
          await s.clearStorageData({ storages: storageTypes });
          await s.clearCache();
          await s.clearAuthCache();
          await s.clearHostResolverCache();
        } catch (err) {
          // Session may not exist yet; that is fine
          void err;
        }
      })
    );
  }

  _allCountdowns() {
    const result = {};
    for (const [uuid] of this._timers) {
      result[uuid] = this.secondsRemaining(uuid);
    }
    return result;
  }
}

/**
 * Format seconds as HH:MM:SS.
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatCountdown(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

const wipeEngine = new WipeEngine();

module.exports = { wipeEngine, WipeEngine, formatCountdown };
