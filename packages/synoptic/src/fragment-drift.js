/**
 * Cold-start detection for a stale installed conventions fragment.
 *
 * ## The gap this closes
 *
 * `fragments/substrate-conventions.md` is plugin-owned and installed into each
 * consumer's `.claude/`. The marker on line 1 carries a version AND a content
 * digest, and `/substrate-setup` reinstalls when the marker differs — but NOTHING
 * INITIATES THAT INSTALL. A copy goes stale the moment the plugin ships and
 * stays stale until someone happens to re-run onboarding.
 *
 * A stale copy can keep teaching retired frame keys — every cold start handing
 * the agent keys that fail on first use — with no check reporting it.
 *
 * ## Why it compares the DIGEST and not the version
 *
 * The marker is `vsynoptic-<version>+<sha8-of-body>`, and the two halves fail
 * differently:
 *
 *   - digest differs  -> the CONTENT differs. The agent is being taught
 *     something other than what the plugin ships. Substantive.
 *   - digest matches, version differs -> the content is byte-identical and only
 *     the stamp moved. Cosmetic.
 *
 * A copy two minor versions behind with an identical body is the worked
 * example. A check keyed on version would cry wolf there while saying
 * nothing useful, and a warning that fires on a correct install is a warning
 * people learn to skip. So version-only drift is recorded and NOT rendered.
 *
 * ## Why an unreadable plugin copy is louder than a stale one
 *
 * If the plugin's own fragment cannot be read, this check cannot run — and a
 * check that silently cannot run is the defect it exists to catch. Cortext
 * shipped exactly that bug one release earlier: the kernel audit emitted
 * only failure metrics, so a clean audit and an audit that never executed were
 * the same observation. Here, "I could not compare" is therefore REPORTED,
 * where "they match" is silent. Silence means compared-and-equal, and nothing
 * else.
 */

import { compareVersions } from './fragment-resolve.js';

/** `<!-- substrate-conventions vsynoptic-1.4.1+446ab494 — ... -->` */
const MARKER_RE =
  /^<!-- substrate-conventions vsynoptic-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+([0-9a-f]{8}))?/;

/**
 * Parse line 1's marker.
 *
 * `digest: null` is a real and distinct answer, not a missing value: markers
 * predating the digest suffix (`vsynoptic-0.1.0`) carry a version and nothing to compare content with.
 *
 * @param {string} text
 * @returns {{ version: string, digest: string|null }|null}
 */
export function readMarker(text) {
  const match = MARKER_RE.exec(String(text ?? '').split('\n', 1)[0] ?? '');
  if (!match) return null;
  return { version: match[1], digest: match[2] ?? null };
}

/**
 * Compare an installed fragment against the plugin's own.
 *
 * Returns a state rather than a boolean so the caller — and the tests — can
 * tell the five outcomes apart. Collapsing them to stale/not-stale makes a
 * cosmetic stamp lag indistinguishable from a content drift, and they need
 * different things done to them.
 *
 * @param {{ installed: string|null, plugin: string|null }} texts
 */
export function compareFragments({ installed, plugin }) {
  // The repo does not consume the fragment. Not every checkout is onboarded,
  // and nagging one that never opted in is noise.
  if (installed === null || installed === undefined) return { state: 'absent' };

  const pluginMarker = plugin === null || plugin === undefined ? null : readMarker(plugin);
  if (pluginMarker === null || pluginMarker.digest === null) {
    return { state: 'uncomparable', reason: 'the plugin fragment is missing or carries no digest' };
  }

  const installedMarker = readMarker(installed);
  if (installedMarker === null) {
    return {
      state: 'uncomparable',
      reason: 'the installed fragment has no plugin marker on line 1'
    };
  }
  if (installedMarker.digest === null) {
    return { state: 'undigested', installed: installedMarker, plugin: pluginMarker };
  }
  if (installedMarker.digest !== pluginMarker.digest) {
    return { state: 'stale', installed: installedMarker, plugin: pluginMarker };
  }
  // Byte-identical body. A differing version here is cosmetic by construction.
  return {
    state: 'current',
    versionDrift: installedMarker.version !== pluginMarker.version,
    installed: installedMarker,
    plugin: pluginMarker
  };
}

/**
 * How far an installed version trails the plugin's, as words, or null when the
 * lag is recent.
 *
 * A digest difference always warns; this only decides how loudly. The fleet sat
 * seven releases behind under the same line a one-release lag got, so the line
 * stopped being read. Escalation starts at three minors, or at any major. A
 * lead, or an unparseable version, is never called behind.
 *
 * @param {string} installed
 * @param {string} plugin
 * @returns {string|null}
 */
export function releasesBehind(installed, plugin) {
  const parse = (v) => String(v).split('.').map(Number);
  const [iMaj, iMin] = parse(installed);
  const [pMaj, pMin] = parse(plugin);
  if (![iMaj, iMin, pMaj, pMin].every(Number.isInteger)) return null;
  if (pMaj > iMaj) return 'a major release behind';
  if (pMaj === iMaj && pMin - iMin >= 3) return `${pMin - iMin} minor releases behind`;
  return null;
}

/**
 * The operator-facing block for one comparison, or '' when nothing needs saying.
 *
 * ## Why it names a command rather than the skill
 *
 * "Re-run `/substrate-setup`" is a nine-step onboarding flow, of which a
 * re-onboarded repo needs exactly one step. **A warning whose remedy is expensive
 * has a predictable steady state**, and it is not the one you wanted: a tired
 * reader defers it, and the deferral is invisible.
 *
 * The resolver bin IS the update mode — resolve the newest, compare
 * digests, install if different, report — so the warning can now close its own
 * loop with a single safe command that refuses a downgrade on its own.
 */
export function renderFragmentDrift(result) {
  switch (result.state) {
    case 'missing':
      return (
        '> ⚠️  **This repo has an agent identity but no conventions fragment.** ' +
        '`.claude/substrate-conventions.md` is absent, so the conventions every other onboarded repo ' +
        'reads are not in your context. Run `/substrate-setup` to install it and its `CLAUDE.local.md` import.\n'
      );
    case 'stale': {
      const behind = releasesBehind(result.installed.version, result.plugin.version);
      const headline =
        behind === null
          ? '> ⚠️  **Conventions fragment is STALE.**'
          : `> 🛑  **Conventions fragment is STALE — ${behind}.** This warning has a steady state ` +
            'where it is read past every session; the distance is the reason not to.';
      return (
        `${headline} \`.claude/substrate-conventions.md\` is ` +
        `\`v${result.installed.version}+${result.installed.digest}\`; the plugin ships ` +
        `\`v${result.plugin.version}+${result.plugin.digest}\`. **The content differs** — the ` +
        'conventions in your context are not the ones this plugin defines, and a stale copy has ' +
        'previously taught retired frame keys that fail on first use.\n> \n> Fix it in one ' +
        'command — this is the whole of what a re-run would do for you:\n> \n' +
        '>     node "$CLAUDE_PLUGIN_ROOT/bin/resolve-fragment.mjs" --target-dir "$PWD" --apply\n'
      );
    }
    case 'undigested':
      return (
        `> ⚠️  **Conventions fragment cannot be verified.** \`.claude/substrate-conventions.md\` is ` +
        `\`v${result.installed.version}\`, whose marker predates the content digest, so there is ` +
        'nothing to compare against the shipped ' +
        `\`v${result.plugin.version}+${result.plugin.digest}\`. It is old enough that it probably ` +
        'differs, but this cannot say so.\n> \n' +
        '>     node "$CLAUDE_PLUGIN_ROOT/bin/resolve-fragment.mjs" --target-dir "$PWD" --apply\n'
      );
    case 'uncomparable':
      // Louder than a stale copy, because this is the CHECK failing rather than
      // the fragment. Silence has to mean compared-and-equal; if this were
      // swallowed, an inoperative check would look exactly like a clean one.
      return (
        `> ⚠️  **Conventions-fragment drift check did not run** — ${result.reason}. The installed ` +
        'fragment may or may not be current; this is the check failing, not the fragment.\n'
      );
    default:
      // 'current' (including cosmetic version drift), 'source' and 'absent'.
      return '';
  }
}

/**
 * The comparison behind the warning, for callers that record it rather than
 * render it. Never throws — a cold-start hook must degrade to less context
 * rather than no context, exactly as `backupWarning` does; null means the
 * check could not run.
 *
 * `source` is the repo that SHIPS the fragment. It is not a consumer, and its
 * working tree is legitimately ahead of the last release while a fragment
 * change is being authored, so comparing it would call an unreleased edit
 * STALE and advise a command that reverts it. It is decided first, so it holds
 * whether or not the repo carries an installed copy.
 *
 * With no installed copy the repo is not a consumer (`absent`) — unless it has
 * onboarded: a repo carrying an agent identity opted in, and a missing fragment
 * there is a gap the session should hear about (`missing`).
 *
 * @param {{ cwd: string, pluginRoot: string|null, readFile: (p: string) => string|null }} opts
 */
export function fragmentDriftCheck({
  cwd,
  pluginRoot,
  readFile,
  listDir = null,
  cacheDir = null,
  onboarded = false
}) {
  try {
    const installed = readFile(`${cwd}/.claude/substrate-conventions.md`);
    if (readFile(`${cwd}/packages/cortext-plugin/fragments/substrate-conventions.md`) !== null) {
      const marker = installed === null ? null : readMarker(installed);
      return marker === null ? { state: 'source' } : { state: 'source', installed: marker };
    }
    if (installed === null) return { state: onboarded ? 'missing' : 'absent' };
    const plugin = bestAvailableFragment({ pluginRoot, readFile, listDir, cacheDir });
    return compareFragments({ installed, plugin });
  } catch {
    return null;
  }
}

/**
 * Read both copies and render. Never throws.
 *
 * @param {{ cwd: string, pluginRoot: string|null, readFile: (p: string) => string|null }} opts
 */
export function fragmentDriftWarning(opts) {
  const result = fragmentDriftCheck(opts);
  return result === null ? '' : renderFragmentDrift(result);
}

/**
 * The best fragment on this machine, not merely the one this session was
 * served.
 *
 * ## Why not the served copy
 *
 * `${pluginRoot}/fragments/…` is the same value Step 3 uses, and
 * `CLAUDE_PLUGIN_ROOT` is bound at
 * session start, so a session running when the plugin updated compares against
 * a stale reference and reports **current** while corrections are still
 * missing.
 *
 * A detector that inherits the installer's wrong source is not an independent
 * check. So this scans the cache the way the resolver does and takes the
 * highest version, falling back to the served copy when the cache cannot be
 * listed — which is the pre-existing behaviour, not a regression.
 *
 * Kept deliberately small rather than importing the resolver: this runs inside
 * a hook with a 5s budget that must never throw, and it needs one fact (the
 * best text) rather than the resolver's full decision table.
 */
function bestAvailableFragment({ pluginRoot, readFile, listDir, cacheDir }) {
  const served =
    pluginRoot === null || pluginRoot === undefined
      ? null
      : readFile(`${pluginRoot}/fragments/substrate-conventions.md`);
  if (listDir === null || cacheDir === null) return served;

  let best = served;
  let bestMarker = served === null ? null : readMarker(served);
  for (const name of listDir(cacheDir) ?? []) {
    const text = readFile(`${cacheDir}/${name}/fragments/substrate-conventions.md`);
    if (text === null) continue;
    const marker = readMarker(text);
    if (marker === null) continue;
    if (bestMarker === null || compareVersions(marker.version, bestMarker.version) > 0) {
      best = text;
      bestMarker = marker;
    }
  }
  return best;
}
