'use strict';

/**
 * Profile manager for Ram Browser.
 *
 * Disk layout (under app.getPath('userData')):
 *
 *   profiles/
 *     profiles-index.json          ← plain JSON index (names, colors, flags)
 *     <uuid>/
 *       prefs.enc                  ← encrypted profile prefs
 *       pin.salt + pin.hash        ← real PIN files (optional)
 *       pin-decoy.salt + .hash     ← decoy PIN files (optional)
 *       tab-snapshot.enc           ← encrypted tab state (written by tab-snapshot.js)
 *
 * The index is NOT encrypted because it only contains display metadata
 * (name, color, hidden flag). Sensitive data lives in encrypted prefs.enc.
 *
 * Profile keys: for profiles without a PIN, a random key is generated and
 * protected with Electron's safeStorage (OS Keychain on macOS, DPAPI on
 * Windows, libsecret on Linux). The encrypted blob is stored in `keySafe`
 * in the index. On first launch or if safeStorage is unavailable, falls
 * back to storing the raw key in `keyBase64`.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateKey, encryptJson, decryptJson } = require('./encryption');
const { hasPin, verifyPin, deriveProfileKey, setPin, setDecoyPin } = require('./pin');

// Electron safeStorage — machine-bound key protection via OS keychain.
// Available after app:ready. Falls back to plain base64 if unavailable.
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
 * Protect a 32-byte key Buffer using OS keychain (safeStorage).
 * Returns a hex string of the encrypted blob, or null if unavailable.
 * @param {Buffer} key
 * @returns {string|null}
 */
function protectKey(key) {
  const ss = getSafeStorage();
  if (!ss) return null;
  try {
    return ss.encryptString(key.toString('base64')).toString('hex');
  } catch {
    return null;
  }
}

/**
 * Recover a key protected with protectKey().
 * @param {string} hexBlob
 * @returns {Buffer|null}
 */
function recoverKey(hexBlob) {
  const ss = getSafeStorage();
  if (!ss || !hexBlob) return null;
  try {
    const decrypted = ss.decryptString(Buffer.from(hexBlob, 'hex'));
    return Buffer.from(decrypted, 'base64');
  } catch {
    return null;
  }
}

let profilesRoot;  // set via init()
let indexCache = null;

const DEFAULT_PROFILE_NAME = 'Personal';
const DEFAULT_PROFILE_COLOR = '#a78bfa';

const CONTAINERS = ['default', 'work', 'social', 'finance', 'research'];

// ── init ──────────────────────────────────────────────────────────────────────

/**
 * Initialise the profile manager.
 * @param {string} userDataPath  app.getPath('userData')
 */
async function init(userDataPath) {
  profilesRoot = path.join(userDataPath, 'profiles');
  await fs.mkdir(profilesRoot, { recursive: true });

  // Create default profile if none exist
  const index = await loadIndex();
  if (index.profiles.length === 0) {
    await createProfile({ name: DEFAULT_PROFILE_NAME, color: DEFAULT_PROFILE_COLOR });
  }
}

// ── index ─────────────────────────────────────────────────────────────────────

async function loadIndex() {
  const indexPath = path.join(profilesRoot, 'profiles-index.json');
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    indexCache = JSON.parse(raw);
    return indexCache;
  } catch {
    indexCache = { version: 1, activeUuid: null, profiles: [] };
    return indexCache;
  }
}

async function saveIndex(index) {
  indexCache = index;
  const indexPath = path.join(profilesRoot, 'profiles-index.json');
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');
}

// ── profile CRUD ──────────────────────────────────────────────────────────────

/**
 * Create a new profile.
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} [opts.color]
 * @param {boolean} [opts.hidden]
 * @param {string} [opts.pin]             Optional PIN to protect the profile
 * @param {string} [opts.decoyPin]        Optional decoy PIN
 * @param {string} [opts.decoyTargetUuid] UUID to load when decoy PIN is entered
 * @returns {Promise<object>}  Profile descriptor
 */
async function createProfile(opts = {}) {
  const { name, color = '#a78bfa', hidden = false, pin, decoyPin, decoyTargetUuid } = opts;

  const uuid = crypto.randomUUID();
  const profileDir = path.join(profilesRoot, uuid);
  await fs.mkdir(profileDir, { recursive: true });

  // Generate a random profile-level encryption key
  const key = generateKey();

  // Write initial encrypted prefs
  const prefs = {
    name: name || `Profile ${Date.now()}`,
    color,
    containers: CONTAINERS,
    wipeIntervalMs: 24 * 60 * 60 * 1000,
    rememberTabs: true,
    theme: 'dark'
  };
  await writePrefs(uuid, prefs, key);

  let hasPinFlag = false;
  let hasDecoyFlag = false;

  if (pin) {
    await setPin(profileDir, pin);
    hasPinFlag = true;
  }

  if (decoyPin) {
    await setDecoyPin(profileDir, decoyPin);
    hasDecoyFlag = true;
  }

  const descriptor = {
    uuid,
    name: prefs.name,
    color,
    hidden,
    hasPin: hasPinFlag,
    hasDecoy: hasDecoyFlag,
    decoyTargetUuid: decoyTargetUuid || null,
    createdAt: Date.now(),
    // For PIN-less profiles: protect key with OS keychain (safeStorage).
    // Falls back to plain base64 if safeStorage is unavailable.
    keySafe: pin ? null : protectKey(key),
    keyBase64: pin ? null : (protectKey(key) ? null : key.toString('base64'))
  };

  const index = await loadIndex();
  index.profiles.push(descriptor);
  if (!index.activeUuid) {
    index.activeUuid = uuid;
  }
  await saveIndex(index);

  return descriptor;
}

/**
 * List all non-hidden profiles (plus hidden ones if includeHidden is true).
 * @param {boolean} [includeHidden]
 * @returns {Promise<object[]>}
 */
async function listProfiles(includeHidden = false) {
  const index = await loadIndex();
  return index.profiles.filter((p) => includeHidden || !p.hidden);
}

/**
 * Get a profile descriptor by UUID.
 * @param {string} uuid
 * @returns {Promise<object|null>}
 */
async function getProfile(uuid) {
  const index = await loadIndex();
  return index.profiles.find((p) => p.uuid === uuid) || null;
}

/**
 * Get the currently active profile descriptor.
 * @returns {Promise<object|null>}
 */
async function getActiveProfile() {
  const index = await loadIndex();
  if (!index.activeUuid) return null;
  return getProfile(index.activeUuid);
}

/**
 * Switch to a profile, verifying PIN if required.
 *
 * @param {string} uuid
 * @param {string} [pin]  Required if the profile has a PIN
 * @returns {Promise<{result: 'ok'|'decoy'|'pin-required'|'invalid-pin', profile: object|null, key: Buffer|null}>}
 */
async function switchProfile(uuid, pin) {
  const profile = await getProfile(uuid);
  if (!profile) throw new Error(`Profile not found: ${uuid}`);

  const profileDir = path.join(profilesRoot, uuid);

  // Profile has a PIN → verify
  if (profile.hasPin) {
    if (!pin) return { result: 'pin-required', profile: null, key: null };

    const verification = await verifyPin(profileDir, pin);

    if (verification === 'decoy') {
      // Load the decoy target instead (silently)
      const targetUuid = profile.decoyTargetUuid;
      if (targetUuid) {
        const targetProfile = await getProfile(targetUuid);
        const targetKey = await resolveKey(targetProfile, null);
        await activateProfile(targetUuid);
        return { result: 'decoy', profile: targetProfile, key: targetKey };
      }
      // No decoy target configured: treat as invalid to avoid leaking info
      return { result: 'invalid-pin', profile: null, key: null };
    }

    if (verification === 'invalid') {
      return { result: 'invalid-pin', profile: null, key: null };
    }

    // Valid PIN
    const key = await deriveProfileKey(profileDir, pin);
    await activateProfile(uuid);
    return { result: 'ok', profile, key };
  }

  // No PIN: use stored key
  const key = await resolveKey(profile, null);
  await activateProfile(uuid);
  return { result: 'ok', profile, key };
}

/**
 * Delete a profile.
 * @param {string} uuid
 */
async function deleteProfile(uuid) {
  const index = await loadIndex();
  const idx = index.profiles.findIndex((p) => p.uuid === uuid);
  if (idx === -1) return;

  index.profiles.splice(idx, 1);

  if (index.activeUuid === uuid) {
    index.activeUuid = index.profiles[0]?.uuid || null;
  }

  await saveIndex(index);

  // Remove profile dir
  const profileDir = path.join(profilesRoot, uuid);
  await fs.rm(profileDir, { recursive: true, force: true });
}

/**
 * Update profile metadata (name, color, hidden).
 * @param {string} uuid
 * @param {object} updates  { name?, color?, hidden? }
 */
async function updateProfile(uuid, updates) {
  const index = await loadIndex();
  const profile = index.profiles.find((p) => p.uuid === uuid);
  if (!profile) throw new Error(`Profile not found: ${uuid}`);

  Object.assign(profile, updates);
  await saveIndex(index);

  // Also update encrypted prefs if name/color changed
  if (updates.name || updates.color) {
    const key = await resolveKey(profile, null);
    if (key) {
      const prefs = await readPrefs(uuid, key);
      if (updates.name) prefs.name = updates.name;
      if (updates.color) prefs.color = updates.color;
      await writePrefs(uuid, prefs, key);
    }
  }
}

/**
 * Get the profile directory path.
 * @param {string} uuid
 * @returns {string}
 */
function profileDir(uuid) {
  return path.join(profilesRoot, uuid);
}

// ── prefs ─────────────────────────────────────────────────────────────────────

async function readPrefs(uuid, key) {
  try {
    const prefsPath = path.join(profilesRoot, uuid, 'prefs.enc');
    const blob = await fs.readFile(prefsPath);
    return decryptJson(blob, key);
  } catch {
    return {};
  }
}

async function writePrefs(uuid, prefs, key) {
  const prefsPath = path.join(profilesRoot, uuid, 'prefs.enc');
  const blob = encryptJson(prefs, key);
  await fs.writeFile(prefsPath, blob);
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function activateProfile(uuid) {
  const index = await loadIndex();
  index.activeUuid = uuid;
  await saveIndex(index);
}

async function resolveKey(profile, _pin) {
  if (!profile) return null;
  // Prefer OS-keychain-protected key
  if (profile.keySafe) {
    const key = recoverKey(profile.keySafe);
    if (key) return key;
  }
  // Fallback: plain base64 (legacy / safeStorage unavailable)
  if (profile.keyBase64) {
    return Buffer.from(profile.keyBase64, 'base64');
  }
  return null;
}

// ── hidden profile unlock-phrase ─────────────────────────────────────────────
const { deriveKey, generateSalt, encrypt, decrypt } = require('./encryption');
const UNLOCK_TOKEN = Buffer.from('RAM_HIDDEN_UNLOCK', 'utf8');

/**
 * Set a secret unlock phrase for a hidden profile.
 * This phrase is typed in the profile switcher to reveal the hidden profile.
 * Stored as a scrypt-derived hash (same mechanism as PIN).
 * @param {string} uuid
 * @param {string} phrase
 */
async function setUnlockPhrase(uuid, phrase) {
  const dir = path.join(profilesRoot, uuid);
  const salt = generateSalt();
  const key = await deriveKey(phrase, salt);
  const hash = encrypt(UNLOCK_TOKEN, key, salt);
  await fs.writeFile(path.join(dir, 'unlock-phrase.salt'), salt);
  await fs.writeFile(path.join(dir, 'unlock-phrase.hash'), hash);
}

/**
 * Try to match a phrase against all hidden profiles.
 * Returns the matching profile descriptor (and its key) or null.
 * @param {string} phrase
 * @returns {Promise<{profile: object, key: Buffer|null}|null>}
 */
async function unlockHiddenProfile(phrase) {
  const index = await loadIndex();
  const hiddenProfiles = index.profiles.filter((p) => p.hidden);

  for (const profile of hiddenProfiles) {
    const dir = path.join(profilesRoot, profile.uuid);
    try {
      const salt = await fs.readFile(path.join(dir, 'unlock-phrase.salt'));
      const hash = await fs.readFile(path.join(dir, 'unlock-phrase.hash'));
      const key = await deriveKey(phrase, salt);
      const plain = decrypt(hash, key);
      if (plain.equals(UNLOCK_TOKEN)) {
        await activateProfile(profile.uuid);
        const profileKey = await resolveKey(profile, null);
        return { profile, key: profileKey };
      }
    } catch {
      // Not this profile — continue
    }
  }
  return null;
}

module.exports = {
  init,
  createProfile,
  listProfiles,
  getProfile,
  getActiveProfile,
  switchProfile,
  deleteProfile,
  updateProfile,
  readPrefs,
  writePrefs,
  profileDir,
  loadIndex,
  setUnlockPhrase,
  unlockHiddenProfile
};
