'use strict';

/**
 * Unit tests for the encrypted tab snapshot manager.
 *
 * Covers the container field round-trip (regression: snapshots stored
 * `containerId` while the UI sends/reads `container`, silently dropping
 * container assignments on restore), legacy normalisation, rekey and clear.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSnapshotManager } = require('../src/main/privacy/tab-snapshot');
const { encryptJson, generateKey } = require('../src/main/profiles/encryption');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ram-snap-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('container field round-trips through write/read', async () => {
  const key = generateKey();
  const mgr = createSnapshotManager(dir, key);

  await mgr.writeDirect([
    { url: 'https://a.example', title: 'A', pinned: false, container: 'work' },
    { url: 'https://b.example', title: 'B', pinned: true, container: 'finance' },
    { url: 'https://c.example', title: 'C', pinned: false } // no container
  ], 1);

  const snap = await mgr.read();
  assert.ok(snap);
  assert.equal(snap.activeIndex, 1);
  assert.equal(snap.tabs[0].container, 'work');
  assert.equal(snap.tabs[1].container, 'finance');
  assert.equal(snap.tabs[1].pinned, true);
  assert.equal(snap.tabs[2].container, 'default');
});

test('legacy containerId snapshots are normalised to container on read', async () => {
  const key = generateKey();
  // Simulate an old snapshot written before the field rename
  const legacy = {
    version: 1,
    capturedAt: Date.now(),
    activeIndex: 0,
    tabs: [{ url: 'https://old.example', title: 'Old', pinned: false, containerId: 'social' }]
  };
  fs.writeFileSync(path.join(dir, 'tab-snapshot.enc'), encryptJson(legacy, key));

  const mgr = createSnapshotManager(dir, key);
  const snap = await mgr.read();
  assert.ok(snap);
  assert.equal(snap.tabs[0].container, 'social');
});

test('rekey preserves the snapshot under the new key', async () => {
  const oldKey = generateKey();
  const newKey = generateKey();

  const mgr = createSnapshotManager(dir, oldKey);
  await mgr.writeDirect([{ url: 'https://keep.example', title: 'Keep', container: 'research' }]);

  await mgr.rekey(oldKey, newKey);

  // A fresh manager with the new key (as pin:set creates) must read it
  const after = createSnapshotManager(dir, newKey);
  const snap = await after.read();
  assert.ok(snap);
  assert.equal(snap.tabs[0].url, 'https://keep.example');
  assert.equal(snap.tabs[0].container, 'research');

  // The old key must no longer decrypt it
  const stale = createSnapshotManager(dir, oldKey);
  assert.equal(await stale.read(), null);
});

test('rekey with a wrong old key clears the snapshot instead of leaving an undecryptable blob', async () => {
  const realKey = generateKey();
  const wrongKey = generateKey();
  const newKey = generateKey();

  const mgr = createSnapshotManager(dir, realKey);
  await mgr.writeDirect([{ url: 'https://x.example', title: 'X' }]);

  const rekeyer = createSnapshotManager(dir, wrongKey);
  await rekeyer.rekey(wrongKey, newKey);

  assert.equal(fs.existsSync(path.join(dir, 'tab-snapshot.enc')), false);
});

test('clear removes the snapshot file', async () => {
  const key = generateKey();
  const mgr = createSnapshotManager(dir, key);
  await mgr.writeDirect([{ url: 'https://z.example', title: 'Z' }]);
  assert.equal(fs.existsSync(path.join(dir, 'tab-snapshot.enc')), true);

  await mgr.clear();
  assert.equal(fs.existsSync(path.join(dir, 'tab-snapshot.enc')), false);
  assert.equal(await mgr.read(), null);
});
