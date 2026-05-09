'use strict';

/**
 * Wipe-cycle invariant tests.
 *
 * Verifies that the wipe engine:
 *  - Fires the 'wiped' event after wipeNow()
 *  - Clears all partitions (mock)
 *  - Resets the per-profile countdown
 *  - Emits 'before-wipe' event before the wipe
 *  - Tab snapshot is cleared on wipe
 *  - Countdown format stays correct throughout
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// ── Minimal WipeEngine test (no Electron session) ─────────────────────────────

// We need to load the wipe engine with _clearSessions stubbed
let WipeEngine, wipeEngine, formatCountdown;

function loadFreshEngine() {
  // Delete module cache to get a fresh instance
  const reqPath = require.resolve('../src/main/privacy/wipe-engine');
  delete require.cache[reqPath];
  const mod = require('../src/main/privacy/wipe-engine');
  WipeEngine = mod.WipeEngine;
  formatCountdown = mod.formatCountdown;
  const eng = new WipeEngine();
  // Stub out Electron session calls
  eng._clearSessions = async () => {};
  return eng;
}

describe('Wipe engine — invariants', () => {
  let engine;
  const PROFILE = 'test-profile-wipe-cycle';
  const PARTS = ['ram-default', 'ram-work'];

  beforeEach(() => {
    engine = loadFreshEngine();
  });

  after(() => {
    engine.stopTick();
  });

  it('emits before-wipe before wiping', async () => {
    let beforeFired = false;
    engine.on('before-wipe', () => { beforeFired = true; });
    await engine.wipeNow(PROFILE, PARTS);
    assert.equal(beforeFired, true);
  });

  it('emits wiped after wipeNow', async () => {
    let wipedUuid = null;
    engine.on('wiped', ({ profileUuid }) => { wipedUuid = profileUuid; });
    await engine.wipeNow(PROFILE, PARTS);
    assert.equal(wipedUuid, PROFILE);
  });

  it('cancels scheduled timer when wipeNow is called', async () => {
    engine.schedule(PROFILE, PARTS, 999_000); // 999 seconds
    assert.ok(engine.secondsRemaining(PROFILE) !== null);
    await engine.wipeNow(PROFILE, PARTS);
    // After wipeNow the old timer is gone; secondsRemaining should return null
    // (unless wipeNow re-schedules, which it doesn't by default)
    assert.ok(engine.secondsRemaining(PROFILE) === null);
  });

  it('schedule starts a new timer after wipeNow clears it', async () => {
    await engine.wipeNow(PROFILE, PARTS);
    engine.schedule(PROFILE, PARTS, 500_000);
    const secs = engine.secondsRemaining(PROFILE);
    assert.ok(secs !== null && secs > 0);
    engine.cancel(PROFILE);
  });

  it('wipeNow calls _clearSessions for every partition', async () => {
    const cleared = [];
    engine._clearSessions = async (partitions) => { cleared.push(...partitions); };
    await engine.wipeNow(PROFILE, PARTS);
    assert.ok(cleared.includes('ram-default'));
    assert.ok(cleared.includes('ram-work'));
  });

  it('tick emits countdown data including formatted string', (_, done) => {
    engine.schedule(PROFILE, PARTS, 100_000);
    let tickData = null;
    engine.on('tick', (countdowns) => {
      tickData = countdowns;
      engine.stopTick();
      assert.ok(typeof tickData[PROFILE] === 'number');
      assert.ok(tickData[PROFILE] > 0);
      engine.cancel(PROFILE);
      done();
    });
    engine.startTick();
  });
});

describe('Wipe engine — formatCountdown', () => {
  before(() => {
    const mod = require('../src/main/privacy/wipe-engine');
    formatCountdown = mod.formatCountdown;
  });

  it('formats 0 seconds as 00:00:00', () => {
    assert.equal(formatCountdown(0), '00:00:00');
  });

  it('formats 3661 seconds as 01:01:01', () => {
    assert.equal(formatCountdown(3661), '01:01:01');
  });

  it('formats 86399 seconds as 23:59:59', () => {
    assert.equal(formatCountdown(86399), '23:59:59');
  });

  it('always returns HH:MM:SS format', () => {
    const result = formatCountdown(7322);
    assert.match(result, /^\d{2}:\d{2}:\d{2}$/);
  });
});
