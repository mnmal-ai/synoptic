// What one host has installed for one repo. Pure: builds the record the
// cold-start writes and classifies one a reader holds, so the writer
// (host-report.js) and the fleet audit (host-audit.js) share it.
//
// Staleness is the reader's call: a dead host cannot report that it is dead,
// so the row carries only refreshedAt and every reader classifies it here.

import { normaliseHost } from './fleet-fragments.js';
import { HARNESSES } from './wire-mcp.js';

export const HOST_INSTALL_FRESH_MS = 24 * 60 * 60 * 1000;
export const HOST_INSTALL_STALE_MS = 7 * HOST_INSTALL_FRESH_MS;

/** The upsert key: one row per host, repo and harness. */
export function hostInstallKey(host, project, harness) {
  return `${host}/${project}/${harness}`;
}

/**
 * The harness the harness-neutral cold-start entry records: the one its
 * launcher declares in SYNOPTIC_HARNESS, when that names a known harness, and
 * `hook` otherwise, so a typo cannot mint a row of its own.
 *
 * @param {string|undefined} declared
 */
export function entryHarness(declared) {
  return typeof declared === 'string' && Object.hasOwn(HARNESSES, declared) ? declared : 'hook';
}

/** The key rows carried before the harness joined it, for cleaning them up. */
export function legacyHostInstallKey(host, project) {
  return `${host}/${project}`;
}

/**
 * @param {{ hostname: string, project: string, kid: string|null, harness: string,
 *   pluginVersion: string|null,
 *   drift: { state: string, installed?: { version: string, digest: string|null } }|null,
 *   nowMs: number }} p
 */
export function buildHostInstallRecord({
  hostname,
  project,
  kid,
  harness,
  pluginVersion,
  drift,
  nowMs
}) {
  const host = normaliseHost(hostname);
  return {
    key: hostInstallKey(host, project, harness),
    host,
    hostReported: String(hostname ?? ''),
    project,
    kid: kid ?? null,
    harness,
    pluginVersion: pluginVersion ?? null,
    fragmentVersion: drift?.installed?.version ?? null,
    fragmentDigest: drift?.installed?.digest ?? null,
    // null means the check could not run, which is not the same as no fragment.
    fragmentState: drift?.state ?? 'uncomparable',
    refreshedAt: new Date(nowMs).toISOString()
  };
}

/**
 * fresh < 24h, quiet < 7d, stale beyond, or when refreshedAt is missing or
 * unparseable. A future timestamp (clock skew) is fresh with age 0, never a
 * negative age.
 *
 * @returns {{ state: 'fresh'|'quiet'|'stale', ageMs: number|null }}
 */
export function classifyInstall(row, nowMs) {
  const t = Date.parse(row?.refreshedAt ?? '');
  if (Number.isNaN(t)) return { state: 'stale', ageMs: null };
  const ageMs = Math.max(0, nowMs - t);
  if (ageMs < HOST_INSTALL_FRESH_MS) return { state: 'fresh', ageMs };
  if (ageMs < HOST_INSTALL_STALE_MS) return { state: 'quiet', ageMs };
  return { state: 'stale', ageMs };
}

/** Whole-unit age, for rendering beside a state. */
export function describeAge(ageMs) {
  if (ageMs === null || ageMs === undefined) return 'never';
  const units = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute']
  ];
  for (const [ms, unit] of units) {
    const n = Math.floor(ageMs / ms);
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}
