// Pruning the cortext plugin cache.
//
// ## Why this is a correctness control, not hygiene
//
// The disk cost is irrelevant. What matters is that **every cached directory is
// a live skill source**, and multiple plausible answers to "the plugin's copy"
// sitting side by side let a slash command be served from an older version
// than `installed_plugins.json` names.
//
// The resolver now chooses explicitly, so pruning is belt-and-braces rather
// than load-bearing. Both are worth having: **the resolver is the guarantee,
// pruning is what makes a resolver bug survivable.**
//
// ## Two directories are never candidates, for different reasons
//
//   - the INSTALLED version, because it is what the machine is meant to run;
//   - the SERVING version (`CLAUDE_PLUGIN_ROOT`), because a session is reading
//     from it RIGHT NOW. Deleting the directory out from under a running
//     session is a way to turn a tidy-up into an outage, and the two are
//     routinely different.
//
// ## And it refuses rather than guessing
//
// With no `installed_plugins.json` entry there is no floor, and "keep the
// highest N" would happily delete the version in use on a box whose registry is
// unreadable. A prune that cannot establish what to protect must not proceed —
// same posture as the resolver refusing a downgrade rather than picking
// something plausible.

/**
 * Decide what to delete.
 *
 * Pure: no filesystem access, so the whole policy is testable without a cache.
 *
 * @param {object} p
 * @param {ReadonlyArray<string>} p.versions Directory names in the cache.
 * @param {string|null} p.installedVersion From `installed_plugins.json`.
 * @param {string|null} p.servedVersion The version serving this session.
 * @param {number} [p.keep=2] How many to retain: installed plus rollbacks.
 * @param {(a: string, b: string) => number} p.compare
 * @returns {{ keep: Array<string>, remove: Array<string>, refusal: string|null,
 *             protectedReason: Record<string, string> }}
 */
export function planCachePrune({ versions, installedVersion, servedVersion, keep = 2, compare }) {
  const protectedReason = {};

  if (installedVersion === null || installedVersion === undefined) {
    return {
      keep: [...versions],
      remove: [],
      refusal:
        'no installed version could be determined, so there is no floor to protect. ' +
        'Refusing to prune — "keep the highest N" would happily delete the version in ' +
        'use on a box whose registry is unreadable.',
      protectedReason
    };
  }

  if (!versions.includes(installedVersion)) {
    return {
      keep: [...versions],
      remove: [],
      refusal:
        `the installed version (${installedVersion}) is not present in the cache. That is a ` +
        'broken install, not a pruning opportunity — deleting anything here would remove a ' +
        'fallback while the thing it falls back to is already missing.',
      protectedReason
    };
  }

  // Newest first. Unparseable names sort last and are therefore prune
  // candidates, which is correct: a directory whose name is not a version is
  // not something the resolver can choose deliberately.
  const ordered = [...versions].sort((a, b) => compare(b, a));

  const keepSet = new Set();
  keepSet.add(installedVersion);
  protectedReason[installedVersion] = 'installed';

  if (servedVersion !== null && servedVersion !== undefined && versions.includes(servedVersion)) {
    if (!keepSet.has(servedVersion)) {
      keepSet.add(servedVersion);
      protectedReason[servedVersion] = 'serving this session';
    }
  }

  // Fill the remaining budget with the newest versions BELOW the installed one,
  // so the rollback target is the previous release. A version sorting above the
  // installed one is from a retired line after a version-line reset, never a rollback.
  for (const v of ordered) {
    if (keepSet.size >= Math.max(keep, keepSet.size === 0 ? 1 : keepSet.size)) break;
    if (!keepSet.has(v) && compare(v, installedVersion) < 0) {
      keepSet.add(v);
      protectedReason[v] = 'rollback';
    }
  }

  const remove = ordered.filter((v) => !keepSet.has(v));
  return {
    keep: ordered.filter((v) => keepSet.has(v)),
    remove,
    refusal: null,
    protectedReason
  };
}

/** Human-readable plan. Rendered before anything is deleted, always. */
export function renderPrunePlan(plan, { apply = false } = {}) {
  const lines = ['cortext plugin cache — prune plan', ''];
  if (plan.refusal !== null) {
    lines.push(`  REFUSED: ${plan.refusal}`);
    lines.push('');
    lines.push('  Nothing was deleted.');
    return lines.join('\n');
  }
  const width = Math.max(0, ...plan.keep.map((v) => v.length));
  for (const v of plan.keep) {
    lines.push(`  KEEP    ${v.padEnd(width)} (${plan.protectedReason[v] ?? 'kept'})`);
  }
  for (const v of plan.remove) {
    lines.push(`  ${apply ? 'DELETE ' : 'would  '} ${v}`);
  }
  lines.push('');
  if (plan.remove.length === 0) {
    lines.push('  Nothing to prune.');
  } else if (apply) {
    lines.push(`  Deleted ${plan.remove.length} cached version(s).`);
  } else {
    lines.push(
      `  ${plan.remove.length} cached version(s) would be removed. ` +
        'Re-run with --apply to delete them.'
    );
  }
  return lines.join('\n');
}
