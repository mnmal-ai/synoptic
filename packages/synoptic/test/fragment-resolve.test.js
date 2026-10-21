// The skill must never install a fragment older than the one this
// machine has, and must never install over the repo that ships it.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  compareVersions,
  isFragmentSourceRepo,
  parseVersion,
  renderResolution,
  resolveFragmentSource
} from '../src/fragment-resolve.js';

const c = (version, digest, origin = `cache/${version}`) => ({
  version,
  digest,
  path: `/cache/${version}/fragments/substrate-conventions.md`,
  origin
});

// ---- version comparison ----

test('parseVersion accepts x.y.z and rejects anything else', () => {
  assert.deepEqual(parseVersion('1.9.0'), [1, 9, 0]);
  assert.equal(parseVersion('1.9'), null);
  assert.equal(parseVersion('unknown'), null);
  assert.equal(parseVersion(null), null);
  assert.deepEqual(parseVersion('1.0.0-alpha.3'), [1, 0, 0, 'alpha', 3]);
  assert.equal(parseVersion('1.0.0-'), null);
});

test('compareVersions follows semver prerelease precedence', () => {
  const order = [
    '1.0.0-alpha.1',
    '1.0.0-alpha.2',
    '1.0.0-alpha.10',
    '1.0.0-beta',
    '1.0.0',
    '1.0.1-alpha.0'
  ];
  for (let i = 1; i < order.length; i++)
    assert.ok(compareVersions(order[i - 1], order[i]) < 0, `${order[i - 1]} < ${order[i]}`);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.0') < 0);
  assert.equal(compareVersions('1.0.0-alpha.0', '1.0.0-alpha.0'), 0);
});

test('compareVersions orders numerically, not lexically', () => {
  // The trap a string sort walks into: '1.10.0' < '1.9.0' lexically.
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.9.0', '1.10.0') < 0);
  assert.equal(compareVersions('1.9.0', '1.9.0'), 0);
});

test('compareVersions sorts an unparseable version below everything', () => {
  // A malformed cache directory must never win a "highest available" contest.
  assert.ok(compareVersions('unknown', '0.0.1') < 0);
});

// ---- source-repo detection ----

test('isFragmentSourceRepo detects the repo that ships the fragment', () => {
  const exists = (p) => p.endsWith('packages/cortext-plugin/fragments/substrate-conventions.md');
  assert.equal(isFragmentSourceRepo({ cwd: '/repo', exists }), true);
  assert.equal(isFragmentSourceRepo({ cwd: '/repo', exists: () => false }), false);
});

test('the source repo is skipped, never overwritten', () => {
  // CLAUDE.md: when the repo and a plugin cache disagree, the repo wins. Its
  // working tree may legitimately be ahead of the last release.
  const r = resolveFragmentSource({
    candidates: [c('1.9.0', 'e25b9217')],
    installedVersion: '1.9.0',
    installedFragment: { version: '1.9.0', digest: 'aaaaaaaa' },
    isSourceRepo: true
  });
  assert.equal(r.action, 'skip-source-repo');
  assert.equal(r.chosen, null);
  assert.match(r.reason, /SHIPS the fragment/);
});

// ---- served older than installed ----

test('REFUSES to install a version below the installed one', () => {
  // Served 1.7.1 while installed_plugins.json says 1.9.0, and the repo already
  // holds 1.9.0. BOTH guards apply here — so assert the invariant (nothing is
  // written) rather than which message wins; the remedy is identical.
  const r = resolveFragmentSource({
    candidates: [c('1.7.1', '09c3e55b')],
    installedVersion: '1.9.0',
    servedVersion: '1.7.1',
    installedFragment: { version: '1.9.0', digest: 'e25b9217' }
  });
  assert.equal(r.action, 'refuse');
  assert.equal(r.chosen, null);
});

test('guard 2 in isolation: cache below the registry, repo not yet a consumer', () => {
  // installedFragment null means only the stale-cache guard can fire.
  const r = resolveFragmentSource({
    candidates: [c('1.7.1', '09c3e55b')],
    installedVersion: '1.9.0',
    installedFragment: null
  });
  assert.equal(r.action, 'refuse');
  assert.match(r.reason, /BELOW the installed/);
});

test('the refusal explains why "do not gate on newer" does not permit a downgrade', () => {
  const r = resolveFragmentSource({
    candidates: [c('1.6.0', '09c3e55b')],
    installedVersion: '1.9.0',
    installedFragment: null
  });
  assert.match(r.reason, /about digests within a version/);
});

test('the report names the stale served version as the cause', () => {
  const r = resolveFragmentSource({
    candidates: [c('1.9.0', 'e25b9217')],
    installedVersion: '1.9.0',
    servedVersion: '1.7.1',
    installedFragment: null
  });
  const text = r.report.join('\n');
  assert.match(text, /served skill: {3}1\.7\.1.*STALE/s);
});

// ---- normal resolution ----

test('prefers the INSTALLED version over a newer cache directory', () => {
  // published != pinned != live. installed_plugins.json is the only one of the
  // three that says what this machine actually resolved.
  const r = resolveFragmentSource({
    candidates: [c('1.9.0', 'e25b9217'), c('2.0.0', 'ffffffff')],
    installedVersion: '1.9.0',
    installedFragment: null
  });
  assert.equal(r.action, 'install');
  assert.equal(r.chosen.version, '1.9.0');
});

test('falls back to the newest available when the installed version is absent from cache', () => {
  const r = resolveFragmentSource({
    candidates: [c('1.8.0', '1fab2d85'), c('1.7.1', '09c3e55b')],
    installedVersion: '1.8.0',
    installedFragment: null
  });
  assert.equal(r.chosen.version, '1.8.0');
});

test('reports, but does not silently prefer, a cache that has run ahead of the install', () => {
  const r = resolveFragmentSource({
    candidates: [c('2.0.0', 'ffffffff')],
    installedVersion: '1.9.0',
    installedFragment: null
  });
  assert.equal(r.action, 'install');
  assert.match(r.report.join('\n'), /cache is AHEAD of the install/);
});

test('same version + different digest is an INSTALL, not "current"', () => {
  // The whole point of the digest half of the marker: a content fix can ship
  // without a version bump.
  const r = resolveFragmentSource({
    candidates: [c('1.9.0', 'e25b9217')],
    installedVersion: '1.9.0',
    installedFragment: { version: '1.9.0', digest: '09c3e55b' }
  });
  assert.equal(r.action, 'install');
});

test('a byte-identical body is CURRENT even when the version differs', () => {
  const r = resolveFragmentSource({
    candidates: [c('1.7.1', '09c3e55b')],
    installedVersion: '1.7.1',
    installedFragment: { version: '1.5.0', digest: '09c3e55b' }
  });
  assert.equal(r.action, 'current');
});

test('an undigested installed marker is treated as needing an install', () => {
  const r = resolveFragmentSource({
    candidates: [c('1.9.0', 'e25b9217')],
    installedVersion: '1.9.0',
    installedFragment: { version: '0.1.0', digest: null }
  });
  assert.equal(r.action, 'install');
});

test('no candidates at all is a refusal, not a silent no-op', () => {
  const r = resolveFragmentSource({
    candidates: [],
    installedVersion: '1.9.0',
    installedFragment: { version: '1.7.1', digest: '09c3e55b' }
  });
  assert.equal(r.action, 'refuse');
  assert.match(r.reason, /no fragment found/);
});

test('an unknown installed version still resolves rather than refusing', () => {
  // A machine with no installed_plugins entry can still onboard.
  const r = resolveFragmentSource({
    candidates: [c('1.9.0', 'e25b9217')],
    installedVersion: null,
    installedFragment: null
  });
  assert.equal(r.action, 'install');
  assert.equal(r.chosen.version, '1.9.0');
});

// ---- reporting ----

test('renderResolution prints the reconciliation even on success', () => {
  // The cluster's recurring failure is an operation reporting success while the
  // meaning was elsewhere, so the resolved value has to be visible when nothing
  // is wrong too.
  const r = resolveFragmentSource({
    candidates: [c('1.9.0', 'e25b9217')],
    installedVersion: '1.9.0',
    servedVersion: '1.9.0',
    installedFragment: { version: '1.9.0', digest: 'e25b9217' }
  });
  const out = renderResolution(r);
  // The label says only what it checks. The marketplace pin is a different
  // fact this function never reads.
  assert.match(out, /installed: {6}1\.9\.0/);
  assert.ok(!out.includes('pin/installed'), 'must not claim to know the pin');
  assert.match(out, /-> CURRENT/);
});

test('renderResolution surfaces a refusal with its reason', () => {
  const r = resolveFragmentSource({
    candidates: [c('1.6.0', '09c3e55b')],
    installedVersion: '1.9.0',
    installedFragment: null
  });
  assert.match(renderResolution(r), /-> REFUSED:.*BELOW the installed/s);
});

// ---- a repo marker newer than the cache ----

test('REFUSES when the REPO is ahead of the best available', () => {
  // Fake the repo marker newer than the cache; none of the three may overwrite it.
  for (const repoVersion of ['9.9.9', '1.11.0', '2.0.0']) {
    const r = resolveFragmentSource({
      candidates: [c('1.10.0', 'c6ea5fdc')],
      installedVersion: '1.10.0',
      installedFragment: { version: repoVersion, digest: 'ffffffff' }
    });
    assert.equal(r.action, 'refuse', `repo ${repoVersion} must refuse`);
    assert.equal(r.chosen, null);
    assert.match(r.reason, /NEWER than the best available/);
  }
});

test('the repo-ahead refusal is DISTINCT from the stale-cache refusal', () => {
  // Two different faults with two different remedies. The first cut had only
  // the second, which is why the first went unnoticed.
  const repoAhead = resolveFragmentSource({
    candidates: [c('1.10.0', 'c6ea5fdc')],
    installedVersion: '1.10.0',
    installedFragment: { version: '1.11.0', digest: 'ffffffff' }
  });
  const staleCache = resolveFragmentSource({
    candidates: [c('1.7.1', '09c3e55b')],
    installedVersion: '1.10.0',
    installedFragment: null
  });
  assert.match(repoAhead.reason, /refresh it rather than overwriting/);
  assert.match(staleCache.reason, /BELOW the installed/);
});

test('the refusal names the escape hatch that already exists', () => {
  const r = resolveFragmentSource({
    candidates: [c('1.10.0', 'c6ea5fdc')],
    installedVersion: '1.10.0',
    installedFragment: { version: '2.0.0', digest: 'ffffffff' }
  });
  // No --force flag: deleting the file leaves nothing to downgrade.
  assert.match(r.reason, /delete the file and re-run/);
});

test('EQUAL versions with differing digests still INSTALL', () => {
  // The guard must be strictly-lower. Conflating equal with lower would break
  // the digest half of the marker, which is the whole "do not gate on newer" point.
  const r = resolveFragmentSource({
    candidates: [c('1.10.0', 'c6ea5fdc')],
    installedVersion: '1.10.0',
    installedFragment: { version: '1.10.0', digest: 'deadbeef' }
  });
  assert.equal(r.action, 'install');
});

test('a repo BEHIND the cache still installs', () => {
  const r = resolveFragmentSource({
    candidates: [c('1.10.0', 'c6ea5fdc')],
    installedVersion: '1.10.0',
    installedFragment: { version: '1.9.0', digest: 'aaaaaaaa' }
  });
  assert.equal(r.action, 'install');
});

test('an unparseable repo marker version does not block the install', () => {
  // A broken marker should be replaced, not treated as infinitely new.
  const r = resolveFragmentSource({
    candidates: [c('1.10.0', 'c6ea5fdc')],
    installedVersion: '1.10.0',
    installedFragment: { version: 'garbage', digest: 'ffffffff' }
  });
  assert.equal(r.action, 'install');
});
