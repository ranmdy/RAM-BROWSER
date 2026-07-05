'use strict';

/**
 * Encrypted tab snapshot for Ram Browser.
 *
 * Saves the current set of open tabs (URL, title, pinned, container) to an
 * AES-256-GCM encrypted file under the active profile directory.
 *
 * The snapshot is read on startup so tabs are restored after a wipe cycle.
 * It is written on every tab change but debounced to avoid I/O thrashing.
 *
 * File location:
 *   <profileDir>/tab-snapshot.enc
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { encryptJson, decryptJson, generateKey } = require('../profiles/encryption');

const DEBOUNCE_MS = 800;
const SNAPSHOT_FILENAME = 'tab-snapshot.enc';

class TabSnapshotManager {
  /**
   * @param {string} profileDir  Absolute path to profile directory
   * @param {Buffer} key         32-byte AES key
   */
  constructor(profileDir, key) {
    this._dir = profileDir;
    this._key = key;
    this._debounceTimer = null;
  }

  get _snapshotPath() {
    return path.join(this._dir, SNAPSHOT_FILENAME);
  }

  /**
   * Save a snapshot immediately (no debounce).
   * @param {Array<{url:string, title:string, pinned:boolean, container:string}>} tabs
   * @param {number} [activeIndex]
   */
  async writeDirect(tabs, activeIndex = 0) {
    const snapshot = {
      version: 1,
      capturedAt: Date.now(),
      activeIndex,
      tabs: tabs.map((t) => ({
        url: t.url || '',
        title: t.title || '',
        pinned: Boolean(t.pinned),
        // Accept legacy `containerId` from old snapshots being re-written
        container: t.container || t.containerId || 'default'
      }))
    };

    const blob = encryptJson(snapshot, this._key);

    // Atomic write: write to .tmp then rename
    const tmp = this._snapshotPath + '.tmp';
    await fs.writeFile(tmp, blob);
    await fs.rename(tmp, this._snapshotPath);
  }

  /**
   * Save a snapshot with debounce (call on every tab change).
   * @param {Array} tabs
   * @param {number} [activeIndex]
   */
  write(tabs, activeIndex = 0) {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this.writeDirect(tabs, activeIndex).catch(() => {});
      this._debounceTimer = null;
    }, DEBOUNCE_MS);
  }

  /**
   * Read and decrypt the snapshot.
   * @returns {Promise<object|null>}  Snapshot object or null if none/corrupt
   */
  async read() {
    try {
      const blob = await fs.readFile(this._snapshotPath);
      const snapshot = decryptJson(blob, this._key);
      // Normalise legacy snapshots that stored `containerId`
      if (snapshot && Array.isArray(snapshot.tabs)) {
        for (const t of snapshot.tabs) {
          if (!t.container && t.containerId) t.container = t.containerId;
        }
      }
      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Delete the snapshot file (called on panic / manual wipe).
   */
  async clear() {
    try {
      await fs.unlink(this._snapshotPath);
    } catch {
      // File may not exist
    }
    // Also remove any stale .tmp
    try {
      await fs.unlink(this._snapshotPath + '.tmp');
    } catch {}
  }

  /**
   * Replace the encryption key (e.g. after a profile PIN change).
   * Reads the existing snapshot with the old key, re-encrypts with the new one.
   * @param {Buffer} oldKey
   * @param {Buffer} newKey
   */
  async rekey(oldKey, newKey) {
    try {
      const blob = await fs.readFile(this._snapshotPath);
      const snapshot = decryptJson(blob, oldKey);
      const newBlob = encryptJson(snapshot, newKey);
      await fs.writeFile(this._snapshotPath, newBlob);
    } catch {
      // If we can't rekey, just clear the snapshot
      await this.clear();
    }
    this._key = newKey;
  }
}

/**
 * Create a TabSnapshotManager for the given profile directory.
 * If no key is provided a fresh random one is generated (useful in tests).
 *
 * @param {string} profileDir
 * @param {Buffer} [key]
 * @returns {TabSnapshotManager}
 */
function createSnapshotManager(profileDir, key) {
  return new TabSnapshotManager(profileDir, key || generateKey());
}

module.exports = { TabSnapshotManager, createSnapshotManager };
