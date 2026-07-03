'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

// We require the module fresh by clearing the cache so each test file
// gets an isolated singleton (profilesRoot, indexCache).
delete require.cache[require.resolve('../src/main/profiles/manager')];
const manager = require('../src/main/profiles/manager');

let tmpDir;

// ── setup ────────────────────────────────────────────────────────────────────

test('setup: init creates a default Personal profile', async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ram-pm-test-'));
  await manager.init(tmpDir);

  const profiles = await manager.listProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'Personal');
  assert.equal(profiles[0].color, '#a78bfa');
  assert.equal(profiles[0].hasPin, false);
  // PIN-less profiles store a base64 encryption key
  assert.ok(typeof profiles[0].keyBase64 === 'string');
});

test('init is idempotent (calling again does not create a second default)', async () => {
  await manager.init(tmpDir);
  const profiles = await manager.listProfiles();
  assert.equal(profiles.length, 1);
});

// ── getActiveProfile ─────────────────────────────────────────────────────────

test('getActiveProfile returns the currently active profile', async () => {
  const active = await manager.getActiveProfile();
  assert.ok(active);
  assert.equal(active.name, 'Personal');
});

// ── createProfile ─────────────────────────────────────────────────────────────

test('createProfile adds a profile to the list', async () => {
  const p = await manager.createProfile({ name: 'Work', color: '#30d158' });
  assert.equal(p.name, 'Work');
  assert.equal(p.hasPin, false);
  assert.ok(typeof p.keyBase64 === 'string');

  const profiles = await manager.listProfiles();
  assert.equal(profiles.length, 2);
  assert.ok(profiles.find((x) => x.name === 'Work'));
});

test('createProfile with PIN sets hasPin and clears keyBase64', async () => {
  const p = await manager.createProfile({ name: 'Secure', pin: '123456' });
  assert.equal(p.hasPin, true);
  assert.equal(p.keyBase64, null);

  const inList = (await manager.listProfiles()).find((x) => x.name === 'Secure');
  assert.ok(inList);
  assert.equal(inList.hasPin, true);
});

// ── profileDir ────────────────────────────────────────────────────────────────

test('profileDir returns a path that contains the profile UUID', async () => {
  const active = await manager.getActiveProfile();
  const dir = manager.profileDir(active.uuid);
  assert.ok(dir.includes(active.uuid));
  assert.ok(path.isAbsolute(dir));
});

// ── switchProfile ─────────────────────────────────────────────────────────────

test('switchProfile to a PIN-less profile returns ok', async () => {
  const work = (await manager.listProfiles()).find((p) => p.name === 'Work');
  const result = await manager.switchProfile(work.uuid, null);
  assert.equal(result.result, 'ok');
  assert.equal(result.profile.name, 'Work');
  assert.ok(result.key instanceof Buffer);
});

test('switchProfile updates getActiveProfile', async () => {
  const work = (await manager.listProfiles()).find((p) => p.name === 'Work');
  await manager.switchProfile(work.uuid, null);
  const active = await manager.getActiveProfile();
  assert.equal(active.uuid, work.uuid);
});

test('switchProfile to PIN-protected profile without PIN returns pin-required', async () => {
  const secure = (await manager.listProfiles()).find((p) => p.name === 'Secure');
  const result = await manager.switchProfile(secure.uuid, null);
  assert.equal(result.result, 'pin-required');
  assert.equal(result.profile, null);
});

test('switchProfile with correct PIN returns ok', async () => {
  const secure = (await manager.listProfiles()).find((p) => p.name === 'Secure');
  const result = await manager.switchProfile(secure.uuid, '123456');
  assert.equal(result.result, 'ok');
  assert.equal(result.profile.name, 'Secure');
  assert.ok(result.key instanceof Buffer);
});

test('switchProfile with wrong PIN returns invalid-pin', async () => {
  const secure = (await manager.listProfiles()).find((p) => p.name === 'Secure');
  const result = await manager.switchProfile(secure.uuid, '000000');
  assert.equal(result.result, 'invalid-pin');
  assert.equal(result.profile, null);
});

test('switchProfile throws for a nonexistent UUID', async () => {
  await assert.rejects(
    () => manager.switchProfile('nonexistent-uuid', null),
    /Profile not found/
  );
});

// ── PIN-profile prefs (bug #2: key derived from PIN, self-heal) ───────────────

test('PIN profile prefs are readable with the unlock key', async () => {
  const p = await manager.createProfile({ name: 'PinPrefs', pin: '424242' });
  const result = await manager.switchProfile(p.uuid, '424242');
  assert.equal(result.result, 'ok');
  const prefs = await manager.readPrefs(p.uuid, result.key);
  assert.equal(prefs.name, 'PinPrefs');
  assert.equal(prefs.rememberTabs, true);
});

test('healPrefs regenerates prefs encrypted under a lost key', async () => {
  const p = await manager.createProfile({ name: 'HealMe', pin: '111111' });
  // Simulate a pre-fix profile: prefs.enc encrypted under a random, lost key
  const { generateKey, encryptJson } = require('../src/main/profiles/encryption');
  const lostKey = generateKey();
  const prefsPath = path.join(manager.profileDir(p.uuid), 'prefs.enc');
  await fs.writeFile(prefsPath, encryptJson({ name: 'unreachable' }, lostKey));

  const result = await manager.switchProfile(p.uuid, '111111');
  assert.equal(result.result, 'ok');
  // Unlock must have healed prefs under the PIN-derived key
  const prefs = await manager.readPrefs(p.uuid, result.key);
  assert.equal(prefs.name, 'HealMe');
});

test('healPrefs leaves readable prefs untouched', async () => {
  const p = await manager.createProfile({ name: 'NoHeal', pin: '222222' });
  const first = await manager.switchProfile(p.uuid, '222222');
  const prefs = await manager.readPrefs(p.uuid, first.key);
  prefs.homepageUrl = 'https://example.com';
  await manager.writePrefs(p.uuid, prefs, first.key);

  const second = await manager.switchProfile(p.uuid, '222222');
  const after = await manager.readPrefs(p.uuid, second.key);
  assert.equal(after.homepageUrl, 'https://example.com'); // not reset to defaults
});

// ── deleteProfile ─────────────────────────────────────────────────────────────

test('deleteProfile removes the profile from the list', async () => {
  await manager.createProfile({ name: 'ToDelete' });
  const before = await manager.listProfiles();
  const target = before.find((p) => p.name === 'ToDelete');
  await manager.deleteProfile(target.uuid);
  const after = await manager.listProfiles();
  assert.equal(after.length, before.length - 1);
  assert.ok(!after.find((p) => p.name === 'ToDelete'));
});

// ── teardown ──────────────────────────────────────────────────────────────────

test('teardown: remove temp directory', async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});
