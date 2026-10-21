// Reading the marketplace pin.
//
// ## The defect
//
// Both the audit and the resolver treated the local install as the pin. The
// resolver's report line was literally labelled `pin/installed:` — asserting a
// fact neither tool ever checked.
//
// The two diverge: a marketplace clone a few commits behind still reads an
// old `ref:` while the actual pin has moved, and both tools report healthy.
//
// ## Why the three-state design did not save it
//
// It rendered `[ok]`, not `[????]`, because nothing knew the check was
// incomplete. `[????]` surfaces a check that COULD NOT RUN; this was a check
// that was never conceived. An unknown-unknown.
//
// The fix converts it into a known-unknown, which is the most this can honestly
// be without network access: the pin is read from the local clone, and the
// clone's own freshness is reported as UNVERIFIED unless someone opts into a
// fetch. That is not a hedge — a local clone genuinely cannot know whether it
// is behind its remote, and claiming otherwise is how this defect happened in
// the first place.
//
// ## published != pinned != live, in one place at last
//
// This repo's CLAUDE.md names those three states as the thing that keeps
// biting. The tool built to reconcile them collapsed two into one label. Now:
//
//     pin (marketplace)  v1.10.0
//     installed          1.10.0
//     serving            1.10.0

/** `v1.10.0` -> `1.10.0`; anything else unchanged. */
export function stripRefPrefix(ref) {
  const s = String(ref ?? '').trim();
  return s.startsWith('v') ? s.slice(1) : s;
}

/**
 * Compare the installed OpenCode skin with the release the marketplace serves.
 * The OpenCode skin publishes on the same release as the Claude plugin, so the
 * plugin version the marketplace serves is the version the skin should be.
 * A null pin is the pin group's hole, so it is not reported again here.
 *
 * @returns {Array<{ id: string, state: 'ok'|'warn'|'unknown', text: string, detail?: string }>}
 */
export function auditSkin({ pinVersion, opencodeInstalledVersion, compare }) {
  if (pinVersion === null || pinVersion === undefined) return [];
  if (opencodeInstalledVersion === null || opencodeInstalledVersion === undefined) {
    return [
      {
        id: 'skin.installed',
        state: 'unknown',
        text: 'no opencode skin in the local npm cache, so it cannot be compared to the release',
        detail: 'no @mnmal-ai/cortext-opencode under ~/.cache/opencode (node_modules/ or npm/)'
      }
    ];
  }
  const delta = compare(opencodeInstalledVersion, pinVersion);
  if (delta < 0) {
    return [
      {
        id: 'skin.installed',
        state: 'warn',
        text: `opencode skin ${opencodeInstalledVersion} is BEHIND the release ${pinVersion}`,
        detail: 'update the plugin entry to the release, then restart opencode (config loads once)'
      }
    ];
  }
  if (delta > 0) {
    return [
      {
        id: 'skin.installed',
        state: 'warn',
        text: `opencode skin ${opencodeInstalledVersion} is AHEAD of the release ${pinVersion}`,
        detail: 'either the marketplace clone is stale, or the install came from outside a release'
      }
    ];
  }
  return [
    { id: 'skin.installed', state: 'ok', text: `opencode skin ${opencodeInstalledVersion} matches` }
  ];
}

/**
 * The newest cortext-opencode version in OpenCode's package cache, or null.
 *
 * Two layouts, both measured. OpenCode 1.x kept one copy at
 * `<cache>/node_modules/@mnmal-ai/cortext-opencode`. OpenCode 2.x keeps one
 * per pinned version at `<cache>/npm/@mnmal-ai/cortext-opencode@<v>/<ts>/
 * node_modules/@mnmal-ai/cortext-opencode` (measured on OpenCode 2.0.25), and the audit read only
 * the first, so every 2.x install reported "no opencode skin". The newest is
 * reported because each repo pins its own version; HostInstall rows carry
 * what each repo actually loaded.
 *
 * @param {{ cacheRoot: string, listDir: (d: string) => string[],
 *   readFile: (p: string) => string|null, compare: (a: string, b: string) => number }} p
 * @returns {string|null}
 */
export function newestOpencodeSkin({ cacheRoot, listDir, readFile, compare }) {
  const PKG = ['node_modules', '@mnmal-ai', 'cortext-opencode', 'package.json'];
  const join = (...parts) => parts.join('/');
  const versionAt = (path) => {
    try {
      const v = JSON.parse(readFile(path) ?? 'null')?.version;
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  };
  const found = [versionAt(join(cacheRoot, ...PKG))];
  const scope = join(cacheRoot, 'npm', '@mnmal-ai');
  for (const dir of listDir(scope)) {
    if (!dir.startsWith('cortext-opencode@')) continue;
    for (const ts of listDir(join(scope, dir))) found.push(versionAt(join(scope, dir, ts, ...PKG)));
  }
  const versions = found.filter((v) => v !== null);
  if (versions.length === 0) return null;
  return versions.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
}

/**
 * Find the cortext pin across every marketplace clone on this machine.
 *
 * Scans rather than hardcoding `mnmal-ai`, because the marketplace directory is
 * named for its owner and a machine may carry several. Returns the first entry
 * naming this plugin.
 *
 * @param {object} p
 * @param {string} p.marketplacesDir
 * @param {(dir: string) => Array<string>|null} p.listDir
 * @param {(path: string) => string|null} p.readFile
 * @param {string} [p.pluginName='cortext']
 * @returns {{ version: string, ref: string, marketplace: string }|null}
 */
export function readMarketplacePin({ marketplacesDir, listDir, readFile, pluginName = 'cortext' }) {
  for (const owner of listDir(marketplacesDir) ?? []) {
    const raw = readFile(`${marketplacesDir}/${owner}/.claude-plugin/marketplace.json`);
    if (raw === null) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A marketplace file that does not parse is indistinguishable from one
      // that names nothing — skip it rather than claiming a pin we cannot read.
      continue;
    }
    const entry = (parsed?.plugins ?? []).find((p) => p?.name === pluginName);
    if (entry === undefined || entry === null) continue;
    const ref = entry?.source?.ref ?? null;
    if (ref === null) continue;
    return { version: stripRefPrefix(ref), ref, marketplace: owner };
  }
  return null;
}

/**
 * Reconcile the pin against what this machine installed.
 *
 * `cloneFreshness` says what was learned about the local marketplace clone
 * relative to its remote. It is THREE-valued on purpose:
 *
 *   'unchecked'  no network was spent, so the pin reading is a hole
 *   'current'    checked, and the clone has everything the remote has
 *   'behind'     checked, and the clone is MISSING commits — the pin is stale
 *   'ahead'      checked, and the clone carries commits the remote does not
 *
 * ## Why not a boolean
 *
 * A `cloneVerified` boolean is false both when nothing was checked AND when a
 * check ran and found the clone behind — so the one condition worth catching
 * rendered as "not checked against its remote … re-run with --fetch", telling
 * the reader to re-run the command that had just produced that line. Same
 * shape as the defect in the comment
 * below — a check that cannot distinguish "I did not look" from "I looked and
 * it is bad" reports the second as the first, which reads as merely untidy.
 *
 * Unrecognised values fall through to 'unchecked' rather than to 'current': a
 * caller that stops passing this, or passes a typo, must degrade to reporting a
 * hole, never to claiming health.
 *
 * @returns {Array<{ id: string, state: 'ok'|'warn'|'unknown', text: string, detail?: string }>}
 */
export function auditPin({
  pin,
  installedVersion,
  cloneFreshness = 'unchecked',
  cloneDetail = null,
  compare
}) {
  const out = [];

  if (pin === null || pin === undefined) {
    out.push({
      id: 'pin.read',
      state: 'unknown',
      text: 'no marketplace pin found',
      detail:
        'no marketplace clone on this machine names the cortext plugin, so there is nothing ' +
        'to compare the install against — "am I current?" cannot be answered locally'
    });
    return out;
  }

  out.push({
    id: 'pin.read',
    state: 'ok',
    text: `pin ${pin.ref} (marketplace ${pin.marketplace})`
  });

  if (cloneFreshness === 'behind') {
    // WARN, not unknown: this was verified, and the answer is bad. The pin line
    // above is not wrong about what the clone says — it is wrong about what the
    // marketplace publishes, and everything downstream of it inherits that.
    out.push({
      id: 'pin.freshness',
      state: 'warn',
      text: `the marketplace clone is BEHIND its remote — pin ${pin.ref} is STALE`,
      detail:
        `${cloneDetail === null ? '' : `${cloneDetail}. `}The pin above is what this clone last ` +
        'fetched, not what the marketplace publishes, so "installed matches the pin" below can ' +
        'be true and still leave this box a release behind. Update the marketplace clone FIRST, ' +
        'then the plugin — a plugin update resolves against the stale pin and correctly does ' +
        'nothing.'
    });
  } else if (cloneFreshness === 'ahead') {
    out.push({
      id: 'pin.freshness',
      state: 'warn',
      text: 'the marketplace clone is AHEAD of its remote',
      detail:
        `${cloneDetail === null ? '' : `${cloneDetail}. `}A managed clone carrying unpushed ` +
        'commits means the pin being served here is not the one anyone else resolves.'
    });
  } else if (cloneFreshness !== 'current') {
    out.push({
      id: 'pin.freshness',
      state: 'unknown',
      text: 'the marketplace clone itself was not checked against its remote',
      detail:
        'the pin above is whatever this local clone last fetched. A clone two commits behind ' +
        'reports a stale pin as authoritative — which is how a box sat a full release behind ' +
        'while every check said healthy. Re-run with --fetch to verify.'
    });
  }

  if (installedVersion === null || installedVersion === undefined) {
    out.push({
      id: 'pin.installed',
      state: 'unknown',
      text: 'installed version unknown, so it cannot be compared to the pin',
      detail: 'no cortext@mnmal-ai entry in installed_plugins.json'
    });
    return out;
  }

  const delta = compare(installedVersion, pin.version);
  if (delta < 0) {
    out.push({
      id: 'pin.installed',
      state: 'warn',
      text: `installed ${installedVersion} is BEHIND the pin ${pin.version}`,
      detail:
        'the marketplace pin does not update an already-installed plugin — update the plugin, ' +
        'then re-run so the fragment check compares against the right version'
    });
  } else if (delta > 0) {
    out.push({
      id: 'pin.installed',
      state: 'warn',
      text: `installed ${installedVersion} is AHEAD of the pin ${pin.version}`,
      detail:
        'either this clone is stale, or the install came from somewhere other than the ' +
        'marketplace. Both are worth knowing; neither is silently fine'
    });
  } else {
    out.push({ id: 'pin.installed', state: 'ok', text: `installed ${installedVersion} matches` });
  }
  return out;
}
