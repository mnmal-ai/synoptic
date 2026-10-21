// The installed plugin and its conventions fragment: cache, served root, marker.

import { check } from './check.js';

/**
 * How many cached plugin versions is too many.
 *
 * Not hygiene: every cached directory is a live skill source, and multiple
 * plausible answers to "the plugin's copy" sitting side by side is how a
 * session ends up on a stale copy. The resolver now chooses
 * explicitly, so pruning is belt-and-braces rather than load-bearing — but a
 * resolver bug is survivable only if the set of wrong answers is small.
 *
 * Two: the installed version, plus one to roll back to.
 */
export const CACHE_KEEP = 2;

/**
 * Plugin-cache reconciliation.
 *
 * ## Why each fact carries WHY it is missing
 *
 * As nullable primitives, three inputs here would answer two questions at once
 * with one null: "I could not look" and "I looked, and the answer is bad."
 * Those are different states in this file's own model — `unknown` versus `warn`
 * (see the note at the top) — and collapsing them reports a verified defect as
 * a hole:
 *
 *   installedVersion  null   registry unreadable | no cortext entry | no version field
 *   cacheVersions     []     cache dir unreadable | dir read fine and EMPTY
 *   servedVersion     null   CLAUDE_PLUGIN_ROOT unset | set, but no readable marker
 *
 * The left cause of each pair is a genuine hole. The right one is a verified
 * bad answer — an unregistered plugin, an empty cache, a served root with no
 * fragment — and each was rendering as `????` with a `detail` that ASSERTED the
 * left cause. "cache not readable" is simply false about a cache that read
 * fine and was empty.
 *
 * The caller now says which. `audit-entry.js` built the collapse with
 * `listOrNull(cacheDir) ?? []` and a bare `catch { }` — the same
 * `data[key] ?? []` move the conventions fragment warns about, where the thing
 * destroyed is PRESENCE, not emptiness.
 *
 * All three discriminators default to the unknown-producing value and treat an
 * unrecognised value the same way. A caller that stops passing one degrades to
 * reporting a hole, never to claiming health.
 *
 * @param {{ installedVersion: string|null,
 *           installedRegistry?: 'unreadable'|'no-entry'|'malformed'|'present',
 *           cacheVersions: ReadonlyArray<string>,
 *           cacheDir?: 'unreadable'|'readable',
 *           servedVersion: string|null,
 *           servedRoot?: 'unset'|'set',
 *           compare: (a: string, b: string) => number }} p
 */
export function auditPlugin({
  installedVersion,
  installedRegistry = 'unreadable',
  cacheVersions,
  cacheDir = 'unreadable',
  servedVersion,
  servedRoot = 'unset',
  compare
}) {
  const out = [];
  const sorted = [...cacheVersions].sort(compare);

  if (installedVersion !== null) {
    out.push(check('plugin.installed', 'ok', `installed ${installedVersion}`));
  } else if (installedRegistry === 'no-entry') {
    out.push(
      check(
        'plugin.installed',
        'warn',
        'no cortext@mnmal-ai entry in installed_plugins.json',
        'the registry read fine and does not list this plugin — a hand-dropped copy never meets a package manager, so nothing establishes a downgrade floor and the pin below has nothing to reconcile against'
      )
    );
  } else if (installedRegistry === 'malformed') {
    out.push(
      check(
        'plugin.installed',
        'warn',
        'the cortext@mnmal-ai registry entry carries no version',
        'the entry exists but its `version` is absent — a malformed registry, not a missing install'
      )
    );
  } else {
    out.push(
      check(
        'plugin.installed',
        'unknown',
        'installed version unresolved',
        'installed_plugins.json could not be read or parsed, so whether this plugin is registered is unknown — distinct from reading it and finding no entry'
      )
    );
  }

  if (cacheVersions.length > 0 && cacheVersions.length <= CACHE_KEEP) {
    out.push(check('plugin.cache', 'ok', `cache holds ${cacheVersions.length} version(s)`));
  } else if (cacheVersions.length === 0 && cacheDir === 'readable') {
    out.push(
      check(
        'plugin.cache',
        'warn',
        'the plugin cache is EMPTY',
        'the cache directory read fine and holds no version with a readable fragment — every skill source is missing, which is a broken install rather than an unchecked one'
      )
    );
  } else if (cacheVersions.length === 0) {
    out.push(
      check(
        'plugin.cache',
        'unknown',
        'cache not readable',
        'the plugin cache directory could not be listed, so what it holds is unknown — distinct from listing it and finding it empty'
      )
    );
  } else if (cacheVersions.length > CACHE_KEEP) {
    out.push(
      check(
        'plugin.cache',
        'warn',
        `cache holds ${cacheVersions.length} versions (${sorted[0]} … ${sorted[sorted.length - 1]})`,
        `every one is a live skill source; keep ${CACHE_KEEP} (installed + one rollback) so a ` +
          `resolver bug has fewer wrong answers available. Fix: node "$CLAUDE_PLUGIN_ROOT/bin/prune-cache.mjs" ` +
          '(dry-run; add --apply to delete)'
      )
    );
  }

  // Recognised values only. An unrecognised discriminator must fall through to
  // the unknown branch rather than matching a happier one — see the
  // fails-closed test.
  const rootState = SERVED_ROOT_STATES.has(servedRoot) ? servedRoot : 'unrecognised';

  if (servedVersion === null && (rootState === 'set' || rootState === 'derived-cache')) {
    out.push(
      check(
        'plugin.served',
        'warn',
        rootState === 'set'
          ? 'CLAUDE_PLUGIN_ROOT is set but carries no readable fragment marker'
          : 'the plugin directory this audit is running from carries no readable fragment marker',
        'the serving root was named and looked at, and it has no version to report — a broken or half-written plugin directory, not an unasked question'
      )
    );
  } else if (rootState === 'derived-source') {
    // Running from the source tree says nothing about what served the SESSION.
    // Reporting the working tree's version here would be a true fact about the auditor, printed under a
    // heading the reader takes to be about the session.
    out.push(
      check(
        'plugin.served',
        'unknown',
        'this audit is running from a SOURCE TREE, not a plugin install',
        'so it can report what it is running, but not what served the skill this session is following — those are different trees whenever the source is ahead of the install, which in this repo is most of the time'
      )
    );
  } else if (servedVersion === null) {
    out.push(
      check(
        'plugin.served',
        'unknown',
        'cannot tell which version served this skill',
        'no serving root could be named or derived, so there is nothing to interrogate — distinct from a root that was found and unreadable'
      )
    );
  } else if (installedVersion !== null && compare(servedVersion, installedVersion) < 0) {
    // Not only a session-binding problem: the SKILL TEXT being followed is the retired one, and
    // nothing else reconciles that. The fragment has a resolver that installs
    // over a stale copy and an audit line that reports drift; skill prose has
    // neither, so a session reads a superseded instruction with no signal at
    // all that a newer one exists. Following the served document correctly can
    // then revert a decision the newer one records.
    out.push(
      check(
        'plugin.served',
        'warn',
        `this session was served ${servedVersion}, older than the installed ${installedVersion} — the skill text being followed is RETIRED`,
        `any instruction in it may have been superseded, and nothing reconciles skill prose the way the resolver reconciles the fragment. Re-read the skill from the installed version before acting on it, and restart the session to rebind CLAUDE_PLUGIN_ROOT.`
      )
    );
  } else {
    out.push(check('plugin.served', 'ok', `served ${servedVersion}`));
  }
  return out;
}

/** The serving roots `auditPlugin` recognises. `set` = CLAUDE_PLUGIN_ROOT was
 *  present; `derived-cache` = located from this file's own path inside the
 *  plugin cache; `derived-source` = located, but in a source checkout.
 *  Anything else is a caller error and reports a hole. */
const SERVED_ROOT_STATES = new Set(['set', 'derived-cache', 'derived-source', 'unset']);

/**
 * Fragment state, expressed from a resolver result so the audit and the
 * installer can never disagree about what "current" means.
 */
export function auditFragment(resolution) {
  switch (resolution.action) {
    case 'current':
      return [check('fragment', 'ok', `repo is current (${resolution.chosen.digest})`)];
    case 'install':
      return [
        check(
          'fragment',
          'warn',
          'repo fragment differs from the best available',
          `would install ${resolution.chosen.version}+${resolution.chosen.digest} — run /substrate-setup`
        )
      ];
    case 'skip-source-repo':
      return [check('fragment', 'ok', 'this repo SHIPS the fragment; its tree is authoritative')];
    default:
      return [
        check('fragment', 'unknown', 'could not resolve a fragment to compare', resolution.reason)
      ];
  }
}
