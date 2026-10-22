/**
 * Cold-start detection for a DANGLING `@` import in a repo's `CLAUDE.md`.
 *
 * ## The gap this closes
 *
 * A Claude Code `@path` import that cannot resolve emits nothing. Not a
 * warning, not a line in the transcript — the instructions simply are not
 * there, and the session proceeds as though they never existed.
 *
 * A shared directory-level `CLAUDE.md` can dangle across several repos with
 * nothing saying so: an absence that looks exactly like nothing
 * being wrong, so the only thing that can catch it is something that goes
 * looking on purpose.
 *
 * ## Why a hook step and not a script
 *
 * A shell snippet written INSIDE the shared `CLAUDE.md` — the very file whose
 * absence it detects — would be circular in the one case that matters: when the root file stops
 * resolving, the recipe for noticing goes with it. And in the ordinary case
 * nobody runs a recipe they must first remember exists.
 *
 * So it runs here, beside `fragmentDriftWarning` and `backupWarning`: a
 * local-filesystem fact, computed before the Substrate reads and prepended so it
 * survives the offline return. That ordering is not incidental — a dangling
 * import matters MOST when the rest of the context is already degraded,
 * because the fragment is then the only guidance the agent has.
 *
 * ## What it deliberately does NOT do
 *
 * It checks RESOLUTION, never content. Whether an imported file says the right
 * thing is a different problem and an unbounded one; whether it exists is a
 * `stat`. This runs at every session start in every repo, so it stays at that
 * cost: at most a handful of small reads, one level deep.
 *
 * One level, because an imported file's own imports dangle the same silent way
 * — `<repo>/CLAUDE.md` importing the directory `CLAUDE.md` importing the
 * conventions fragment is the arrangement in use, and a check that stopped at
 * the first hop would miss the directory file entirely. It does not recurse
 * further: depth beyond that is not in use, and an unbounded walk
 * at session start is a cost with no evidence behind it.
 */

/** An `@import` line, as Claude Code recognises it: at the start of a line. */
const IMPORT_LINE = /^@(\S+)\s*$/gm;

/**
 * Extract the `@` import targets from a CLAUDE.md body.
 *
 * Anchored to line starts because that is what Claude Code honours, and
 * because an `@` mid-sentence is ordinary prose — an email address, a kid like
 * `peer-claude@host-a`, an npm scope. Matching those would make the check
 * cry wolf on every document that mentions an agent by name, and a warning
 * that fires on correct files is one people learn to skip.
 */
export function parseImports(text) {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(IMPORT_LINE)].map((m) => m[1]);
}

/**
 * Resolve one import target against the file that declared it.
 *
 * Absolute targets stand alone; relative ones resolve against the DECLARING
 * file's directory, not the cwd. That distinction is the whole reason a
 * one-level walk needs its own resolution step: `@.claude/substrate-conventions.md`
 * inside `/srv/projects/CLAUDE.md` means a file beside THAT one.
 */
export function resolveImport(target, fromFile) {
  if (target.startsWith('/')) return target;
  const dir = fromFile.slice(0, fromFile.lastIndexOf('/'));
  return `${dir}/${target}`;
}

/**
 * Walk the imports of CLAUDE.md and CLAUDE.local.md one level deep and return the ones that do not
 * resolve, each with the file that declared it.
 *
 * Returns `[]` when both root files are absent: a repo with neither
 * is not a consumer, and is a different fact from one whose imports are
 * broken. Saying nothing there is the same call `fragmentDriftWarning` makes
 * about a repo that never onboarded.
 */
export function findDanglingImports({ cwd, readFile }) {
  // CLAUDE.local.md is untracked and is where /substrate-setup puts the
  // fragment import, so a repo's tracked CLAUDE.md never names Cortext.
  const roots = [`${cwd}/CLAUDE.md`, `${cwd}/CLAUDE.local.md`];
  const dangling = [];
  const seen = new Set(roots);

  for (const root of roots) {
    const rootText = readFile(root);
    if (rootText === null) continue;
    for (const target of parseImports(rootText)) {
      const path = resolveImport(target, root);
      if (seen.has(path)) continue;
      seen.add(path);
      const text = readFile(path);
      if (text === null) {
        dangling.push({ target, path, declaredIn: root });
        continue;
      }
      // One level down: a file that resolved may still import something that does not.
      for (const nested of parseImports(text)) {
        const nestedPath = resolveImport(nested, path);
        if (seen.has(nestedPath)) continue;
        seen.add(nestedPath);
        if (readFile(nestedPath) === null) {
          dangling.push({ target: nested, path: nestedPath, declaredIn: path });
        }
      }
    }
  }
  return dangling;
}

/** Render the warning. Empty string when everything resolves. */
export function renderDanglingImports(dangling) {
  if (dangling.length === 0) return '';
  const lines = [
    `> ⚠️  **${dangling.length} CLAUDE.md import${dangling.length === 1 ? '' : 's'} ` +
      `do${dangling.length === 1 ? 'es' : ''} not resolve.** Claude Code emits NOTHING for a ` +
      'dangling `@` import, so those instructions are simply absent from this session — ' +
      'indistinguishable from never having been written.'
  ];
  for (const d of dangling) {
    lines.push(`>   - \`@${d.target}\` in \`${d.declaredIn}\` → \`${d.path}\` not readable`);
  }
  lines.push(
    '> \n> Check the path, or the symlink behind it: a previous instance of this survived ten ' +
      'days across four repos because `ls` showed a healthy-looking link whose target had moved.'
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Read and render. Never throws — a cold-start hook degrades to less context
 * rather than no context, the same contract as `backupWarning` and
 * `fragmentDriftWarning`.
 *
 * @param {{ cwd: string, readFile: (p: string) => string|null }} opts
 */
export function importResolutionWarning({ cwd, readFile }) {
  try {
    return renderDanglingImports(findDanglingImports({ cwd, readFile }));
  } catch {
    return '';
  }
}
