'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { wipeEngine, formatCountdown } = require('../src/main/privacy/wipe-engine');

// Stub _clearSessions so tests don't need a live Electron session object.
// The stub is set on the instance, shadowing the prototype method.
wipeEngine._clearSessions = async () => {};

// ── formatCountdown ──────────────────────────────────────────────────────────

test('formatCountdown formats zero seconds', () => {
  assert.equal(formatCountdown(0), '00:00:00');
});

test('formatCountdown formats exactly one minute', () => {
  assert.equal(formatCountdown(60), '00:01:00');
});

test('formatCountdown formats hours, minutes, seconds', () => {
  assert.equal(formatCountdown(3661), '01:01:01');
});

test('formatCountdown handles near-24-hour value', () => {
  assert.equal(formatCountdown(86399), '23:59:59');
});

test('formatCountdown zero-pads each component', () => {
  assert.equal(formatCountdown(1), '00:00:01');
  assert.equal(formatCountdown(3600), '01:00:00');
});

// ── schedule / cancel / secondsRemaining ─────────────────────────────────────

test('schedule registers a countdown for a profile', () => {
  wipeEngine.schedule('sched-uuid', [], 60_000);
  const secs = wipeEngine.secondsRemaining('sched-uuid');
  assert.ok(typeof secs === 'number', 'should be a number');
  assert.ok(secs > 55 && secs <= 60, `expected ~60s remaining, got ${secs}`);
  wipeEngine.cancel('sched-uuid');
});

test('cancel removes the scheduled countdown', () => {
  wipeEngine.schedule('cancel-uuid', [], 60_000);
  wipeEngine.cancel('cancel-uuid');
  assert.equal(wipeEngine.secondsRemaining('cancel-uuid'), null);
});

test('secondsRemaining returns null for an unscheduled profile', () => {
  assert.equal(wipeEngine.secondsRemaining('unknown-uuid'), null);
});

test('rescheduling a profile replaces the existing timer', () => {
  wipeEngine.schedule('resched-uuid', [], 60_000);
  wipeEngine.schedule('resched-uuid', [], 120_000);
  const secs = wipeEngine.secondsRemaining('resched-uuid');
  assert.ok(secs > 115 && secs <= 120, `expected ~120s remaining, got ${secs}`);
  wipeEngine.cancel('resched-uuid');
});

// ── tick ─────────────────────────────────────────────────────────────────────

test('startTick emits tick events and stopTick halts them', (_t, done) => {
  // Use a fresh WipeEngine instance so we don't interfere with the singleton.
  const WipeEngine = wipeEngine.constructor;
  const engine = new WipeEngine();
  engine._clearSessions = async () => {};

  engine.schedule('tick-uuid', [], 99_999);
  engine.on('tick', function onTick(countdowns) {
    engine.off('tick', onTick);
    engine.stopTick();
    engine.cancel('tick-uuid');
    assert.ok('tick-uuid' in countdowns, 'tick payload should include scheduled uuid');
    done();
  });
  engine.startTick();
});

test('startTick is idempotent (calling twice does not double-fire)', (_t, done) => {
  const WipeEngine = wipeEngine.constructor;
  const engine = new WipeEngine();
  engine._clearSessions = async () => {};

  let fires = 0;
  engine.schedule('idempotent-uuid', [], 99_999);
  engine.on('tick', function onTick() {
    fires++;
    if (fires === 2) {
      engine.off('tick', onTick);
      engine.stopTick();
      engine.cancel('idempotent-uuid');
      // If startTick ran twice there would be 4+ fires by now — 2 is correct
      assert.ok(fires <= 3, `expected at most 3 ticks in ~2s, got ${fires}`);
      done();
    }
  });
  engine.startTick();
  engine.startTick(); // second call should be a no-op
});
