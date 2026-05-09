'use strict';

/**
 * PIN system for Ram Browser.
 *
 * Each profile that has a PIN stores (preferring OS keychain):
 *   <profileDir>/pin.safe        – safeStorage-encrypted JSON: {salt: hex, hash: hex}
 *                                   (machine-bound; only decryptable on same OS user)
 *
 * Fallback when safeStorage is unavailable (non-Electron env or first launch):
 *   <profileDir>/pin.salt        – 32-byte random salt
 *   <profileDir>/pin.hash        – AES-256-GCM encrypted verification token
 *
 * On first successful verify via raw files, the data is transparently migrated
 * to a .safe blob and the raw files are removed.
 *
 * Key derivation: Argon2id (memoryCost: 65536, timeCost: 3, parallelism: 4).
 * Falls back to scrypt if argon2 is not available.
 *
 * Decoy PIN support: same layout under the `pin-decoy` prefix.
 *   <profileDir>/pin-decoy.safe
 *   (fallback: pin-decoy.salt + pin-decoy.hash)
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { deriveKey, generateSalt, encrypt, decrypt } = require('./encryption');

// Try to load argon2; fall back to scrypt (encryption.js deriveKey) if unavailable
let argon2;
try {
  argon2 = require('argon2');
} catch {
  argon2 = null;
}

const ARGON2_OPTS = {
  type: argon2?.argon2id,
  memoryCost: 65536,   // 64 MB
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
  raw: true
};

const VERIFICATION_TOKEN = Buffer.from('RAM_BROWSER_PIN_VALID', 'utf8');

// ── OS keychain helpers ───────────────────────────────────────────────────────

let _safeStorage = null;
function getSafeStorage() {
  if (_safeStorage !== null) return _safeStorage;
  try {
    const { safeStorage } = require('electron');
    _safeStorage = (safeStorage?.isEncryptionAvailable?.() ?? false) ? safeStorage : null;
  } catch {
    _safeStorage = null;
  }
  return _safeStorage;
}

/**
 * Encrypt salt+hash into a machine-bound safeStorage blob.
 * @param {Buffer} salt
 * @param {Buffer} hash
 * @returns {string|null} hex-encoded blob, or null if safeStorage unavailable
 */
function protectPinData(salt, hash) {
  const ss = getSafeStorage();
  if (!ss) return null;
  try {
    const payload = JSON.stringify({ salt: salt.toString('hex'), hash: hash.toString('hex') });
    return ss.encryptString(payload).toString('hex');
  } catch {
    return null;
  }
}

/**
 * Recover salt+hash from a safeStorage blob created by protectPinData().
 * @param {string} hexBlob
 * @returns {{salt: Buffer, hash: Buffer}|null}
 */
function recoverPinData(hexBlob) {
  const ss = getSafeStorage();
  if (!ss || !hexBlob) return null;
  try {
    const payload = ss.decryptString(Buffer.from(hexBlob, 'hex'));
    const { salt, hash } = JSON.parse(payload);
    return { salt: Buffer.from(salt, 'hex'), hash: Buffer.from(hash, 'hex') };
  } catch {
    return null;
  }
}

/**
 * Derive a 32-byte key from a PIN + salt.
 * Uses Argon2id if available, otherwise falls back to scrypt.
 * @param {string} pin
 * @param {Buffer} salt
 * @returns {Promise<Buffer>}
 */
async function deriveKeyFromPin(pin, salt) {
  if (argon2) {
    try {
      return await argon2.hash(pin, { ...ARGON2_OPTS, salt });
    } catch {
      // Argon2 error (e.g. salt too short) — fall through to scrypt
    }
  }
  return deriveKey(pin, salt);
}

/**
 * Store a PIN for a profile.
 * Prefers OS keychain (safeStorage). Falls back to raw files if unavailable.
 * @param {string} profileDir  Absolute path to profile directory
 * @param {string} pin
 */
async function setPin(profileDir, pin) {
  const salt = generateSalt();
  const key = await deriveKeyFromPin(pin, salt);
  const hash = encrypt(VERIFICATION_TOKEN, key, salt);

  const safeBlob = protectPinData(salt, hash);
  if (safeBlob) {
    await fs.writeFile(path.join(profileDir, 'pin.safe'), safeBlob, 'utf8');
    // Remove legacy raw files if present
    await fs.unlink(path.join(profileDir, 'pin.salt')).catch(() => {});
    await fs.unlink(path.join(profileDir, 'pin.hash')).catch(() => {});
  } else {
    await fs.writeFile(path.join(profileDir, 'pin.salt'), salt);
    await fs.writeFile(path.join(profileDir, 'pin.hash'), hash);
  }
}

/**
 * Store a decoy PIN for a profile.
 * Prefers OS keychain (safeStorage). Falls back to raw files if unavailable.
 * @param {string} profileDir
 * @param {string} decoyPin
 */
async function setDecoyPin(profileDir, decoyPin) {
  const salt = generateSalt();
  const key = await deriveKeyFromPin(decoyPin, salt);
  const hash = encrypt(VERIFICATION_TOKEN, key, salt);

  const safeBlob = protectPinData(salt, hash);
  if (safeBlob) {
    await fs.writeFile(path.join(profileDir, 'pin-decoy.safe'), safeBlob, 'utf8');
    await fs.unlink(path.join(profileDir, 'pin-decoy.salt')).catch(() => {});
    await fs.unlink(path.join(profileDir, 'pin-decoy.hash')).catch(() => {});
  } else {
    await fs.writeFile(path.join(profileDir, 'pin-decoy.salt'), salt);
    await fs.writeFile(path.join(profileDir, 'pin-decoy.hash'), hash);
  }
}

/**
 * Remove the PIN from a profile (all storage forms).
 * @param {string} profileDir
 */
async function clearPin(profileDir) {
  await Promise.all([
    fs.unlink(path.join(profileDir, 'pin.safe')).catch(() => {}),
    fs.unlink(path.join(profileDir, 'pin.salt')).catch(() => {}),
    fs.unlink(path.join(profileDir, 'pin.hash')).catch(() => {})
  ]);
}

/**
 * Remove the decoy PIN from a profile (all storage forms).
 * @param {string} profileDir
 */
async function clearDecoyPin(profileDir) {
  await Promise.all([
    fs.unlink(path.join(profileDir, 'pin-decoy.safe')).catch(() => {}),
    fs.unlink(path.join(profileDir, 'pin-decoy.salt')).catch(() => {}),
    fs.unlink(path.join(profileDir, 'pin-decoy.hash')).catch(() => {})
  ]);
}

/**
 * Check whether a profile has a PIN set.
 * @param {string} profileDir
 * @returns {Promise<boolean>}
 */
async function hasPin(profileDir) {
  for (const file of ['pin.safe', 'pin.salt']) {
    try {
      await fs.access(path.join(profileDir, file));
      return true;
    } catch {}
  }
  return false;
}

/**
 * Check whether a profile has a decoy PIN set.
 * @param {string} profileDir
 * @returns {Promise<boolean>}
 */
async function hasDecoyPin(profileDir) {
  for (const file of ['pin-decoy.safe', 'pin-decoy.salt']) {
    try {
      await fs.access(path.join(profileDir, file));
      return true;
    } catch {}
  }
  return false;
}

/**
 * Verify a PIN against stored salt + hash.
 * @param {string} profileDir
 * @param {string} pin
 * @returns {Promise<'valid'|'decoy'|'invalid'>}
 */
async function verifyPin(profileDir, pin) {
  // Try real PIN first
  const realResult = await tryVerify(profileDir, 'pin', pin);
  if (realResult) return 'valid';

  // Try decoy PIN
  const decoyResult = await tryVerify(profileDir, 'pin-decoy', pin);
  if (decoyResult) return 'decoy';

  return 'invalid';
}

/**
 * Derive a profile encryption key from PIN + stored salt.
 * Only call this after verifyPin returns 'valid'.
 * @param {string} profileDir
 * @param {string} pin
 * @returns {Promise<Buffer>}
 */
async function deriveProfileKey(profileDir, pin) {
  // Try keychain blob first (contains the salt)
  try {
    const safeBlob = await fs.readFile(path.join(profileDir, 'pin.safe'), 'utf8');
    const recovered = recoverPinData(safeBlob);
    if (recovered) return deriveKeyFromPin(pin, recovered.salt);
  } catch {}
  // Fall back to raw salt file
  const salt = await fs.readFile(path.join(profileDir, 'pin.salt'));
  return deriveKeyFromPin(pin, salt);
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function tryVerify(profileDir, prefix, pin) {
  try {
    let salt, hash;

    // 1. Try OS keychain (.safe blob)
    try {
      const safeBlob = await fs.readFile(path.join(profileDir, `${prefix}.safe`), 'utf8');
      const recovered = recoverPinData(safeBlob);
      if (recovered) {
        salt = recovered.salt;
        hash = recovered.hash;
      }
    } catch {}

    // 2. Fall back to raw files
    if (!salt || !hash) {
      salt = await fs.readFile(path.join(profileDir, `${prefix}.salt`));
      hash = await fs.readFile(path.join(profileDir, `${prefix}.hash`));
    }

    const key = await deriveKeyFromPin(pin, salt);
    const plaintext = decrypt(hash, key);
    const isValid = plaintext.equals(VERIFICATION_TOKEN);

    // 3. Migrate raw files → keychain on first successful verify
    if (isValid) {
      const safePath = path.join(profileDir, `${prefix}.safe`);
      const safeBlob = protectPinData(salt, hash);
      if (safeBlob) {
        await fs.writeFile(safePath, safeBlob, 'utf8').catch(() => {});
        await fs.unlink(path.join(profileDir, `${prefix}.salt`)).catch(() => {});
        await fs.unlink(path.join(profileDir, `${prefix}.hash`)).catch(() => {});
      }
    }

    return isValid;
  } catch {
    return false;
  }
}

module.exports = {
  setPin,
  setDecoyPin,
  clearPin,
  clearDecoyPin,
  hasPin,
  hasDecoyPin,
  verifyPin,
  deriveProfileKey,
  deriveKeyFromPin
};
