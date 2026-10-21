import { describe, expect, it } from 'vitest';
import {
  buildHostInstallRecord,
  classifyInstall,
  describeAge,
  entryHarness,
  HOST_INSTALL_FRESH_MS,
  HOST_INSTALL_STALE_MS,
  hostInstallKey,
  legacyHostInstallKey
} from '../src/host-install.js';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

describe('buildHostInstallRecord', () => {
  it('normalises the host for the key and keeps the raw hostname', () => {
    const r = buildHostInstallRecord({
      hostname: 'Desk.local',
      project: 'synoptic',
      kid: 'synoptic-claude@Desk',
      harness: 'claude-code',
      pluginVersion: '2.9.0',
      drift: { state: 'source', installed: { version: '2.9.0', digest: 'cb15e93a' } },
      nowMs: NOW
    });
    expect(r).toEqual({
      key: 'desk/synoptic/claude-code',
      host: 'desk',
      hostReported: 'Desk.local',
      project: 'synoptic',
      kid: 'synoptic-claude@Desk',
      harness: 'claude-code',
      pluginVersion: '2.9.0',
      fragmentVersion: '2.9.0',
      fragmentDigest: 'cb15e93a',
      fragmentState: 'source',
      refreshedAt: new Date(NOW).toISOString()
    });
  });

  it('records a drift check that could not run as uncomparable, with null fragment fields', () => {
    const r = buildHostInstallRecord({
      hostname: 'h',
      project: 'p',
      kid: null,
      harness: 'hook',
      pluginVersion: null,
      drift: null,
      nowMs: NOW
    });
    expect(r.fragmentState).toBe('uncomparable');
    expect(r.fragmentVersion).toBeNull();
    expect(r.fragmentDigest).toBeNull();
  });

  it('hostInstallKey is host/project/harness', () => {
    expect(hostInstallKey('desk', 'substrate', 'opencode')).toBe('desk/substrate/opencode');
    expect(legacyHostInstallKey('desk', 'substrate')).toBe('desk/substrate');
  });
});

describe('classifyInstall', () => {
  it('fresh under 24h, quiet under 7d, stale from 7d', () => {
    expect(classifyInstall({ refreshedAt: at(HOST_INSTALL_FRESH_MS - 1) }, NOW).state).toBe(
      'fresh'
    );
    expect(classifyInstall({ refreshedAt: at(HOST_INSTALL_FRESH_MS) }, NOW).state).toBe('quiet');
    expect(classifyInstall({ refreshedAt: at(HOST_INSTALL_STALE_MS - 1) }, NOW).state).toBe(
      'quiet'
    );
    expect(classifyInstall({ refreshedAt: at(HOST_INSTALL_STALE_MS) }, NOW).state).toBe('stale');
  });

  it('missing or unparseable refreshedAt is stale with no age', () => {
    expect(classifyInstall({}, NOW)).toEqual({ state: 'stale', ageMs: null });
    expect(classifyInstall({ refreshedAt: 'yesterday' }, NOW)).toEqual({
      state: 'stale',
      ageMs: null
    });
  });

  // A skewed clock must not produce a negative age.
  it('a future refreshedAt is fresh with age 0', () => {
    expect(classifyInstall({ refreshedAt: at(-3_600_000) }, NOW)).toEqual({
      state: 'fresh',
      ageMs: 0
    });
  });
});

describe('describeAge', () => {
  it('names the age in whole units', () => {
    expect(describeAge(null)).toBe('never');
    expect(describeAge(30_000)).toBe('just now');
    expect(describeAge(5 * 60_000)).toBe('5 minutes ago');
    expect(describeAge(3 * 3_600_000)).toBe('3 hours ago');
    expect(describeAge(12 * 86_400_000)).toBe('12 days ago');
    expect(describeAge(86_400_000)).toBe('1 day ago');
  });
});

describe('entryHarness', () => {
  it('names the harness SYNOPTIC_HARNESS declares', () => {
    expect(entryHarness('gemini')).toBe('gemini');
    expect(entryHarness('kimi')).toBe('kimi');
  });

  it("falls back to 'hook' when unset, empty or not a known harness", () => {
    expect(entryHarness(undefined)).toBe('hook');
    expect(entryHarness('')).toBe('hook');
    expect(entryHarness('not-a-harness')).toBe('hook');
    // An inherited key such as Object.prototype's is not a harness either.
    expect(entryHarness('constructor')).toBe('hook');
  });
});
