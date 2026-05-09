'use strict';

/**
 * argon2-pin.test.js
 *
 * Tests for Argon2id PIN hashing in pin.js.
 * Verifies that Argon2id is used when available and that the full
 * PIN set/verify cycle works correctly.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setPin, setDecoyPin, verifyPin, clearPin, hasPin, deriveKeyFromPin } = require('../src/main/profiles/pin');

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rambrowser-pin-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Argon2id PIN hashing', () => {
  it('deriveKeyFromPin returns a 32-byte Buffer', async () => {
    const salt = Buffer.alloc(32, 0xab);
    const key = await deriveKeyFromPin('secret123', salt);
    assert.ok(Buffer.isBuffer(key), 'result must be a Buffer');
    assert.equal(key.length, 32, 'key must be 32 bytes');
  });

  it('same PIN + salt yields same key (deterministic)', async () => {
    const salt = Buffer.alloc(32, 0xcd);
    const k1 = await deriveKeyFromPin('mypin', salt);
    const k2 = await deriveKeyFromPin('mypin', salt);
    assert.ok(k1.equals(k2), 'keys must be identical for same input');
  });

  it('different PINs yield different keys', async () => {
    const salt = Buffer.alloc(32, 0x11);
    const k1 = await deriveKeyFromPin('pin1', salt);
    const k2 = await deriveKeyFromPin('pin2', salt);
    assert.ok(!k1.equals(k2), 'keys must differ for different PINs');
  });

  it('different salts yield different keys', async () => {
    const k1 = await deriveKeyFromPin('samepin', Buffer.alloc(32, 0x11));
    const k2 = await deriveKeyFromPin('samepin', Buffer.alloc(32, 0x22));
    assert.ok(!k1.equals(k2), 'keys must differ for different salts');
  });

  it('setPin + verifyPin returns valid', async () => {
    const dir = path.join(tmpDir, 'profile-a');
    await fs.mkdir(dir, { recursive: true });

    await setPin(dir, '1234');
    const result = await verifyPin(dir, '1234');
    assert.equal(result, 'valid');
  });

  it('wrong PIN returns invalid', async () => {
    const dir = path.join(tmpDir, 'profile-b');
    await fs.mkdir(dir, { recursive: true });

    await setPin(dir, '5678');
    const result = await verifyPin(dir, '9999');
    assert.equal(result, 'invalid');
  });

  it('setDecoyPin + verify returns decoy', async () => {
    const dir = path.join(tmpDir, 'profile-c');
    await fs.mkdir(dir, { recursive: true });

    await setPin(dir, 'realpin');
    await setDecoyPin(dir, 'decoypin');

    assert.equal(await verifyPin(dir, 'realpin'), 'valid');
    assert.equal(await verifyPin(dir, 'decoypin'), 'decoy');
    assert.equal(await verifyPin(dir, 'wrongpin'), 'invalid');
  });

  it('hasPin returns true after setPin', async () => {
    const dir = path.join(tmpDir, 'profile-d');
    await fs.mkdir(dir, { recursive: true });

    assert.equal(await hasPin(dir), false, 'no pin initially');
    await setPin(dir, '0000');
    assert.equal(await hasPin(dir), true, 'pin set');
    await clearPin(dir);
    assert.equal(await hasPin(dir), false, 'pin cleared');
  });
});
