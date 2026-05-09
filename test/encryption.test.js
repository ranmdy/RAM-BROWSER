'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateKey,
  generateSalt,
  encrypt,
  decrypt,
  extractSalt,
  encryptJson,
  decryptJson,
  KEY_LEN,
  SALT_LEN
} = require('../src/main/profiles/encryption');

test('generateKey returns a 32-byte Buffer', () => {
  const key = generateKey();
  assert.ok(Buffer.isBuffer(key));
  assert.equal(key.length, KEY_LEN);
});

test('generateSalt returns a 32-byte Buffer', () => {
  const salt = generateSalt();
  assert.ok(Buffer.isBuffer(salt));
  assert.equal(salt.length, SALT_LEN);
});

test('encrypt/decrypt roundtrip preserves string plaintext', () => {
  const key = generateKey();
  const blob = encrypt('Hello, Ram Browser!', key);
  assert.equal(decrypt(blob, key).toString('utf8'), 'Hello, Ram Browser!');
});

test('encrypt/decrypt roundtrip preserves arbitrary bytes', () => {
  const key = generateKey();
  const data = Buffer.from([0x00, 0x01, 0xFE, 0xFF]);
  assert.ok(decrypt(encrypt(data, key), key).equals(data));
});

test('decrypt throws with wrong key (auth tag mismatch)', () => {
  const blob = encrypt('secret', generateKey());
  assert.throws(() => decrypt(blob, generateKey()));
});

test('decrypt throws when blob is too short', () => {
  assert.throws(() => decrypt(Buffer.alloc(10), generateKey()));
});

test('explicit salt is embedded at the start of the blob', () => {
  const key = generateKey();
  const salt = generateSalt();
  const blob = encrypt('data', key, salt);
  assert.ok(extractSalt(blob).equals(salt));
});

test('omitting salt produces a zero-filled salt prefix', () => {
  const blob = encrypt('data', generateKey());
  assert.ok(extractSalt(blob).equals(Buffer.alloc(SALT_LEN, 0)));
});

test('each encrypt call produces a unique ciphertext (random IV)', () => {
  const key = generateKey();
  const a = encrypt('same content', key);
  const b = encrypt('same content', key);
  assert.notDeepEqual(a, b);
});

test('encryptJson/decryptJson roundtrip preserves complex object', () => {
  const key = generateKey();
  const obj = { name: 'Personal', color: '#a78bfa', nested: { arr: [1, 2, 3] } };
  assert.deepEqual(decryptJson(encryptJson(obj, key), key), obj);
});

test('encryptJson/decryptJson roundtrip preserves arrays and nulls', () => {
  const key = generateKey();
  const val = [null, true, 42, 'hello'];
  assert.deepEqual(decryptJson(encryptJson(val, key), key), val);
});
