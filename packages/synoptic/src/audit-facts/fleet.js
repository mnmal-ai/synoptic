// The across-repo view behind --fleet: each sibling's fragment on disk, and
// every host's HostInstall rows.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { check } from '../audit.js';
import { auditFleetFragments, readFragment, scopeFleetToHost } from '../fleet-fragments.js';
import { compareVersions, isFragmentSourceRepo } from '../fragment-resolve.js';
import { listOrNull, readOrNull } from '../fs-safe.js';
import { auditHosts } from '../host-audit.js';
import { substrateQuery } from '../substrate-http.js';

// The ACROSS-repo view, opt-in via --fleet <parent-dir>. Not on by
// default because it needs a directory the audit cannot assume, and NOT a
// cold-start check: a per-repo hook would have to stat its siblings on every
// session to report a condition its own reader usually cannot fix.
/**
 * The fragment as COMMITTED, which is a different artifact from the one on disk
 * wherever it is tracked.
 *
 * Returns null for "untracked, or not a checkout" — a legitimate state, and
 * deliberately the same answer as "git could not tell me", because both mean
 * this run has no committed copy to compare against and neither is drift.
 * Reporting a hole as a difference would be the defect this check exists for.
 *
 * @param {string} repoDir
 * @returns {string|null}
 */
function committedFragment(repoDir) {
  try {
    return execFileSync('git', ['-C', repoDir, 'show', 'HEAD:.claude/substrate-conventions.md'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }
}

/** One git answer, or null when git could not give one. */
function gitOut(repoDir, args) {
  try {
    return execFileSync('git', ['-C', repoDir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Where the SOURCE repo's checkout stands relative to the release.
 *
 * A source that is ahead of the release made that release, so the released
 * marker (`+<digest>`, stamped by sync-fragment-version and enforced against
 * the body by test) is in its history. A stale clone never received it. That
 * one pickaxe search is what separates "unpublished edit" from "old checkout",
 * which read identically from the working tree alone.
 *
 * `behindUpstream` counts against the LAST FETCH — this runs no network — so it
 * can understate. The history check does not depend on it.
 *
 * @param {string} repoDir
 * @param {string|null} releasedDigest
 */
function sourceGitFacts(repoDir, releasedDigest) {
  let releasedInHistory = null;
  if (releasedDigest !== null) {
    const hit = gitOut(repoDir, [
      'log',
      '--all',
      '--format=%H',
      '-1',
      `-S+${releasedDigest}`,
      '--',
      '.claude/substrate-conventions.md',
      'packages/cortext-plugin/fragments/substrate-conventions.md'
    ]);
    releasedInHistory = hit === null ? null : hit !== '';
  }
  const branch = gitOut(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const originHead = gitOut(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const behind = gitOut(repoDir, ['rev-list', '--count', 'HEAD..@{u}']);
  return {
    releasedInHistory,
    branch: branch === null || branch === 'HEAD' ? null : branch,
    defaultBranch: originHead === null ? null : originHead.replace(/^origin\//, ''),
    behindUpstream: behind === null || !/^\d+$/.test(behind) ? null : Number(behind)
  };
}

const HOST_INSTALL_LIMIT = 500;
const HOST_INSTALL_FIELDS = [
  'key',
  'host',
  'hostReported',
  'project',
  'kid',
  'harness',
  'pluginVersion',
  'fragmentVersion',
  'fragmentDigest',
  'fragmentState',
  'refreshedAt',
  'pinState',
  'pinNote',
  'mcpJsonState',
  'mcpJsonNote',
  'authorityState',
  'authorityNote',
  'settingsState',
  'settingsNote',
  'settingsEnv'
];

/**
 * `fleetFindings` is null without --fleet; `hostFindings` is null without
 * --fleet or --hosts.
 *
 * @param {{ fleetDir: string|null, hosts?: boolean, directoryRows: Array<object>|null,
 *           candidates: Array<{ version: string, text: string }>,
 *           substrateUrl: string|null, env: Record<string, string|undefined>,
 *           fetchImpl: typeof fetch, thisHost?: string }} p
 */
export async function gatherFleet({
  fleetDir,
  hosts = false,
  directoryRows,
  candidates,
  substrateUrl,
  env,
  fetchImpl,
  thisHost = hostname()
}) {
  let fleetFindings = null;
  let hostFindings = null;
  if (fleetDir !== null) {
    const repos = [];
    // Which scanned repo SHIPS the fragment. Detected with the same predicate the
    // per-repo `fragment` check already uses, rather than by name — the fleet
    // view had no concept of a source repo and so reported the authoritative tree
    // as drifted.
    // Every scanned repo that SHIPS the fragment. More than one is normal: a
    // worktree or second clone of synoptic matches the same predicate, and keeping
    // only the last one seen let an unplaced worktree displace the real source,
    // which then read as a consumer BEHIND the release.
    const sourceRepos = [];
    // Checkouts with no fragment. Scoped separately below: one the
    // directory places on this host opted in and is a gap; any other never opted
    // in, and nagging it, or counting it as unclaimed, is noise.
    const noFragment = [];
    for (const d of (listOrNull(fleetDir) ?? []).filter((e) => e.isDirectory())) {
      const dir = join(fleetDir, d.name);
      const f = join(dir, '.claude', 'substrate-conventions.md');
      if (!existsSync(f)) {
        noFragment.push(d.name);
        continue;
      }
      if (isFragmentSourceRepo({ cwd: dir, exists: existsSync })) sourceRepos.push(d.name);
      repos.push({
        name: d.name,
        text: readOrNull(f),
        committed: committedFragment(dir)
      });
    }
    // Only repos whose agent runs on THIS host are surveyed. A local
    // copy of a repo worked elsewhere is not the one that matters, and an
    // unreadable directory surveys nothing rather than everything.
    const scope = scopeFleetToHost({
      repoNames: repos.map((r) => r.name),
      thisHost,
      directoryRows
    });
    const here = new Set(scope.here);
    const missing = scopeFleetToHost({
      repoNames: noFragment,
      thisHost,
      directoryRows
    }).here;
    const scoped = repos.filter((r) => here.has(r.name));
    const localSource = sourceRepos.find((name) => here.has(name)) ?? null;
    const bestText =
      [...candidates].sort((a, b) => compareVersions(b.version, a.version))[0]?.text ?? null;
    const digest = (body) => createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 8);
    const bestFragment = bestText === null ? null : readFragment(bestText);
    const surveyed = !scope.placed
      ? []
      : auditFleetFragments({
          repos: scoped,
          best: bestText,
          sourceRepo: localSource,
          sourceGit:
            localSource === null
              ? undefined
              : sourceGitFacts(
                  join(fleetDir, localSource),
                  bestFragment === null ? null : digest(bestFragment.body)
                ),
          digest,
          population: { elsewhere: scope.elsewhere.length, unclaimed: scope.unclaimed.length },
          missing
        }).findings;
    fleetFindings = [...scope.findings, ...surveyed].map((f) =>
      check(f.id, f.state, f.text, f.detail)
    );
  }

  if (fleetDir !== null || hosts) {
    // What every host has INSTALLED, from the rows each host's cold-start
    // writes. Unlike the disk survey above, this covers hosts this machine
    // cannot see.
    let hostRows = null;
    if (substrateUrl !== null) {
      try {
        const key = `${env.SUBSTRATE_NAMESPACE ?? 'cortext'}/HostInstall`;
        const fields = { _metadata: true };
        for (const f of HOST_INSTALL_FIELDS) fields[f] = true;
        const data = await substrateQuery(
          substrateUrl,
          { [key]: { params: { limit: HOST_INSTALL_LIMIT }, fields } },
          { fetchImpl }
        );
        hostRows = Object.hasOwn(data, key) ? data[key] : null;
      } catch {
        hostRows = null;
      }
    }
    hostFindings = auditHosts({
      rows: hostRows,
      directoryRows,
      nowMs: Date.now(),
      compare: compareVersions
    }).map((f) => check(f.id, f.state, f.text, f.detail));
    // A full page means rows may be missing, which would turn into false
    // "never reported" findings.
    if (hostRows !== null && hostRows.length >= HOST_INSTALL_LIMIT) {
      hostFindings.push(
        check(
          'hosts.truncated',
          'unknown',
          `read ${hostRows.length} HostInstall rows, the query limit, so some may be missing`,
          '"never reported" findings above may be false; this audit does not page'
        )
      );
    }
  }
  return { fleetFindings, hostFindings };
}
