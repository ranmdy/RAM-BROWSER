'use strict';

/**
 * Encryption utilities for Ram Browser profile data.
 *
 * All profile data at rest is AES-256-GCM encrypted.
 * Keys are either derived from a PIN via scrypt or generated randomly and
 * stored in the OS keychain (handled by pin.js / manager.js).
 *
 * Format on disk:
 *   [ 32-byte salt (scrypt) | 12-byte IV | 16-byte auth tag | ciphertext ]
 *
 * When using a pre-derived key (no PIN), the salt field is zero-filled as a
 * placeholder so the binary layout stays uniform.
 */

const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;     // AES-256
const IV_LEN = 12;      // GCM standard nonce
const TAG_LEN = 16;     // GCM auth tag
const SALT_LEN = 32;    // scrypt salt
const SCRYPT_N = 16384; // CPU/memory cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/**
 * Derive a 256-bit key from a PIN + salt using scrypt.
 * @param {string} pin
 * @param {Buffer} salt  32-byte random salt
 * @returns {Promise<Buffer>}
 */
async function deriveKey(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pin, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Generate a fresh random key (for profiles without a PIN).
 * @returns {Buffer}
 */
function generateKey() {
  return crypto.randomBytes(KEY_LEN);
}

/**
 * Generate a fresh random salt.
 * @returns {Buffer}
 */
function generateSalt() {
  return crypto.randomBytes(SALT_LEN);
}

/**
 * Encrypt a Buffer or string with AES-256-GCM.
 *
 * @param {Buffer|string} plaintext
 * @param {Buffer} key  32-byte key
 * @param {Buffer} [salt]  Optional 32-byte salt to prepend (for PIN-based keys).
 *                         If omitted a zero buffer is used.
 * @returns {Buffer}  salt | iv | tag | ciphertext
 */
function encrypt(plaintext, key, salt) {
  const plaintextBuf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const iv = crypto.randomBytes(IV_LEN);
  const saltBuf = salt || Buffer.alloc(SALT_LEN, 0);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LEN });
  const encrypted = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([saltBuf, iv, tag, encrypted]);
}

/**
 * Decrypt a blob produced by encrypt().
 *
 * @param {Buffer} blob
 * @param {Buffer} key  32-byte key
 * @returns {Buffer}  plaintext
 */
function decrypt(blob, key) {
  if (blob.length < SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error('Encrypted blob is too short');
  }

  const iv = blob.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = blob.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(SALT_LEN + IV_LEN + TAG_LEN);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Extract the salt bytes from an encrypted blob.
 * Useful when re-deriving the key from a PIN.
 * @param {Buffer} blob
 * @returns {Buffer}
 */
function extractSalt(blob) {
  return blob.subarray(0, SALT_LEN);
}

/**
 * Encrypt a JSON-serialisable value.
 * @param {*} value
 * @param {Buffer} key
 * @param {Buffer} [salt]
 * @returns {Buffer}
 */
function encryptJson(value, key, salt) {
  return encrypt(JSON.stringify(value), key, salt);
}

/**
 * Decrypt and parse JSON from an encrypted blob.
 * @param {Buffer} blob
 * @param {Buffer} key
 * @returns {*}
 */
function decryptJson(blob, key) {
  return JSON.parse(decrypt(blob, key).toString('utf8'));
}

module.exports = {
  deriveKey,
  generateKey,
  generateSalt,
  encrypt,
  decrypt,
  extractSalt,
  encryptJson,
  decryptJson,
  KEY_LEN,
  SALT_LEN
};
