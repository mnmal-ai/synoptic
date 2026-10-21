// Resolving WHICH conventions fragment to install.
//
// ## The defect
//
// `/substrate-setup` Step 3 said: copy `${CLAUDE_PLUGIN_ROOT}/fragments/…`.
// `CLAUDE_PLUGIN_ROOT` points at the plugin cache directory that SERVED the
// slash command, and that is bound at session start — so a plugin updated
// mid-session leaves every running session pointing at the old directory.
//
// Shortly after a release, `installed_plugins.json` can name the new version
// while running sessions are still served from versions several behind. The
// skill would then install a stale body and report success, because Step 3's
// success criterion — "the markers differ, so overwrite" — is satisfied just
// as well by a stale copy as by a current one.
//
// ## Why this is code and not a better paragraph
//
// A careful paragraph followed literally still does the wrong thing when the
// value it names is wrong. The same shape recurs — a settings file that parsed as
// nothing, a label that applied and was not counted, an HTTP 200 with an empty
// `data` — so the remedy is the same: reconcile the sources explicitly, print
// what was resolved, and make the mismatch loud. A resolution that is computed
// and reported cannot be "followed loosely".
//
// ## Why the INSTALLED version is the contract, not the newest cache directory
//
// Three states are separate and easy to conflate: **published** (registry has
// it) ≠ **pinned** (marketplace points at the tag) ≠ **live** (this machine
// installed it). `installed_plugins.json` is the only one of the three that
// says what THIS machine actually resolved, so it is the authority. A cache
// directory holding something newer is a cache that has run ahead of the
// install — worth reporting, never worth silently preferring, because nothing
// has validated it as the version this machine is meant to run.
//
// Corollary that bites: a source BELOW the installed version is a downgrade,
// and Step 3's "do not gate on the version being newer" rule — correct in
// spirit, since a content fix can ship without a version bump — actively
// permits it. Both halves are needed: same version + different digest is an
// install; lower version is a refusal.

/**
 * Parse `1.9.0` or `1.0.0-alpha.3` into `[major, minor, patch, ...prerelease]`,
 * numeric prerelease identifiers as numbers. Returns null for anything else.
 */
export function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
    String(text ?? '').trim()
  );
  if (m === null) return null;
  const pre =
    m[4] === undefined ? [] : m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return [Number(m[1]), Number(m[2]), Number(m[3]), ...pre];
}

/**
 * Compare two version strings. Unparseable sorts below everything, so a
 * malformed directory name can never win a "highest available" contest.
 *
 * @returns {number} negative if a < b, 0 if equal, positive if a > b.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return -1;
  if (pb === null) return 1;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  // Semver precedence: a release outranks its prereleases; identifiers compare
  // numerically when both are numbers, numbers below text, then by length.
  if (pa.length === 3 || pb.length === 3) return pb.length - pa.length;
  for (let i = 3; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

/**
 * Is this repo the SOURCE of the fragment rather than a consumer of it?
 *
 * synoptic ships `packages/cortext-plugin/fragments/substrate-conventions.md` and
 * CLAUDE.md is explicit that when the repo and a plugin cache disagree, the
 * repo wins. Installing over it from a cache would discard whatever the working
 * tree has that the last release does not — which is exactly the state a repo
 * is in while authoring a fragment change.
 *
 * Detected by the file's presence rather than by repo name, so a fork or a
 * rename cannot silently turn the source into a consumer.
 *
 * @param {{ cwd: string, exists: (p: string) => boolean }} opts
 */
export function isFragmentSourceRepo({ cwd, exists }) {
  return exists(`${cwd}/packages/cortext-plugin/fragments/substrate-conventions.md`);
}

/**
 * Decide which fragment to install, or refuse and say why.
 *
 * Pure: every filesystem fact is passed in, so the whole decision table is
 * testable without a plugin cache on disk.
 *
 * @param {object} opts
 * @param {ReadonlyArray<{version: string, path: string, origin: string}>} opts.candidates
 *   Every fragment this machine could install, already read off disk.
 * @param {string|null} opts.installedVersion From `installed_plugins.json`.
 * @param {string|null} opts.servedVersion The version that served the skill
 *   (`CLAUDE_PLUGIN_ROOT`), for reporting a stale serving root.
 * @param {{version: string, digest: string|null}|null} opts.installedFragment
 *   The marker currently in the consumer repo, or null when absent.
 * @param {boolean} [opts.isSourceRepo=false]
 * @returns {{
 *   action: 'install'|'current'|'refuse'|'skip-source-repo',
 *   chosen: object|null,
 *   reason: string|null,
 *   report: Array<string>
 * }}
 */
export function resolveFragmentSource(opts) {
  const {
    candidates = [],
    installedVersion = null,
    servedVersion = null,
    installedFragment = null,
    isSourceRepo = false
  } = opts;

  const report = [];
  const newest = [...candidates].sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;

  // NOT "pin/installed". This is what THIS MACHINE installed; the
  // marketplace pin is a different fact that this function never reads, and
  // labelling them as one asserted something neither tool checked. On a box
  // whose marketplace clone was two commits stale, that label read as healthy
  // while the machine sat a full release behind. `--audit` reports the pin.
  report.push(`installed:      ${installedVersion ?? '(unknown)'}`);
  report.push(
    `served skill:   ${servedVersion ?? '(unknown)'}` +
      (servedVersion !== null &&
      installedVersion !== null &&
      compareVersions(servedVersion, installedVersion) < 0
        ? '   <- STALE: bound at session start, before the install'
        : '')
  );
  report.push(
    `cache holds:    ${candidates.length} version(s)` +
      (candidates.length > 0
        ? ` (newest ${newest.version}, oldest ${
            [...candidates].sort((a, b) => compareVersions(a.version, b.version))[0].version
          })`
        : '')
  );
  report.push(
    `repo has:       ${
      installedFragment === null
        ? '(none — not yet a consumer)'
        : `v${installedFragment.version}+${installedFragment.digest ?? '(no digest)'}`
    }`
  );

  // The source repo is never a consumer of its own artifact.
  if (isSourceRepo) {
    return {
      action: 'skip-source-repo',
      chosen: null,
      reason:
        'this repo SHIPS the fragment (packages/cortext-plugin/fragments/) — its working ' +
        'tree is the authority and may legitimately be ahead of the last release. ' +
        'Installing over it from a plugin cache would discard unreleased edits.',
      report
    };
  }

  if (newest === null) {
    return {
      action: 'refuse',
      chosen: null,
      reason:
        'no fragment found in any plugin directory. Nothing was written — a missing ' +
        'source is a broken install, not a reason to leave the repo untouched silently.',
      report
    };
  }

  // Prefer the installed version when this machine has it: that is the version
  // this box actually resolved, as opposed to one that merely sits in the cache.
  const atInstalled =
    installedVersion === null
      ? null
      : (candidates.find((c) => compareVersions(c.version, installedVersion) === 0) ?? null);
  const chosen = atInstalled ?? newest;

  // GUARD 1 — the repo is AHEAD of anything this machine can offer.
  //
  // The real downgrade case: the check below compares against
  // `installed_plugins.json`, which catches a stale CACHE but says nothing about
  // a repo that already holds something newer (a marker of 9.9.9, say).
  //
  // The path that makes it real: a consumer COMMITS `.claude/substrate-conventions.md`,
  // a teammate on a newer plugin updates it, and a machine whose cache has not
  // caught up silently reverts their work on the next run.
  //
  // Strictly lower only. Equal versions with differing digests must still
  // install — that is the whole point of the digest half of the marker, and
  // conflating the two is what "do not gate on newer" was warning about.
  if (
    installedFragment !== null &&
    compareVersions(chosen.version, installedFragment.version) < 0
  ) {
    return {
      action: 'refuse',
      chosen: null,
      reason:
        `the repo already holds v${installedFragment.version}, NEWER than the best available ` +
        `v${chosen.version}. Installing would revert it. This machine's plugin cache is behind ` +
        'whatever produced the repo copy — refresh it rather than overwriting. (If the repo ' +
        'marker is genuinely wrong, delete the file and re-run; an absent copy has nothing to ' +
        'downgrade.)',
      report
    };
  }

  // GUARD 2 — the best source is older than what this machine says it installed,
  // i.e. a cache that has not refreshed. Distinct from guard 1 and both are real.
  if (installedVersion !== null && compareVersions(chosen.version, installedVersion) < 0) {
    return {
      action: 'refuse',
      chosen: null,
      reason:
        `the best available fragment is v${chosen.version}, BELOW the installed ` +
        `v${installedVersion}. Installing it would be a downgrade — Step 3's "do not gate on ` +
        'the version being newer" rule is about digests within a version, and must not be ' +
        'read as permission to go backwards. Refresh the plugin cache and re-run.',
      report
    };
  }

  if (
    installedVersion !== null &&
    atInstalled === null &&
    compareVersions(newest.version, installedVersion) > 0
  ) {
    report.push(
      `note:           cache is AHEAD of the install (${newest.version} > ${installedVersion}); ` +
        'using it, but nothing has validated it as this machine’s version'
    );
  }

  // Same version, different digest is still an install — a content fix can ship
  // without a version bump, which is the whole reason the marker carries a
  // digest. Only a byte-identical body is "current".
  if (installedFragment !== null && installedFragment.digest === chosen.digest) {
    return {
      action: 'current',
      chosen,
      reason: null,
      report
    };
  }

  return { action: 'install', chosen, reason: null, report };
}

/**
 * Render the reconciliation a human reads before anything is written.
 *
 * Printed unconditionally, including on success. The cluster's recurring
 * failure is an operation that reported success while the meaning was
 * elsewhere, so "what did you actually resolve" has to be visible when nothing
 * is wrong too — otherwise the first time anyone reads it is the first time it
 * is already too late.
 */
export function renderResolution(result) {
  const lines = [
    'substrate-conventions fragment — resolution',
    ...result.report.map((r) => `  ${r}`)
  ];
  if (result.chosen !== null) {
    lines.push(
      `  -> chose ${result.chosen.version}+${result.chosen.digest ?? '(no digest)'} ` +
        `from ${result.chosen.origin}`
    );
  }
  switch (result.action) {
    case 'install':
      lines.push('  -> INSTALL');
      break;
    case 'current':
      lines.push('  -> CURRENT (byte-identical body; nothing to do)');
      break;
    case 'refuse':
      lines.push(`  -> REFUSED: ${result.reason}`);
      break;
    case 'skip-source-repo':
      lines.push(`  -> SKIPPED: ${result.reason}`);
      break;
  }
  return lines.join('\n');
}
