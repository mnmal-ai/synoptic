// The installed plugin, its cache, the root that served this audit and the
// conventions fragment they resolve to: the same gathering the resolver does.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMarker } from '../fragment-drift.js';
import { isFragmentSourceRepo, resolveFragmentSource } from '../fragment-resolve.js';
import { listOrNull, readOrNull } from '../fs-safe.js';

/**
 * @param {{ pluginsDir: string, cacheDir: string, targetDir: string,
 *           envRoot: string|null, selfRoot: string }} p
 *   `envRoot` is CLAUDE_PLUGIN_ROOT when set; `selfRoot` is the plugin root
 *   this audit is running from.
 */
export function gatherPluginFacts({ pluginsDir, cacheDir, targetDir, envRoot, selfRoot }) {
  // --- plugin + fragment facts (same gathering the resolver does) ---
  // Each of these three facts records WHY it is missing, not just THAT it is.
  // A bare `catch {}` and a `?? []` would make "I could not look" and "I looked
  // and the answer is bad" the same value, and auditPlugin would report the
  // second as a hole. See auditPlugin's own
  // comment for the pairs.
  let installedVersion = null;
  let installedRegistry = 'unreadable';
  try {
    const reg = JSON.parse(readFileSync(join(pluginsDir, 'installed_plugins.json'), 'utf8'));
    const e = reg?.plugins?.['cortext@mnmal-ai'];
    if (!Array.isArray(e) || e.length === 0) {
      // Read and parsed: the registry genuinely does not list this plugin.
      installedRegistry = 'no-entry';
    } else {
      installedVersion = e[0].version ?? null;
      installedRegistry = installedVersion === null ? 'malformed' : 'present';
    }
  } catch {
    // Absent, unreadable or unparseable — the one case that is truly a hole.
    installedRegistry = 'unreadable';
  }

  const cacheListing = listOrNull(cacheDir);
  const cacheDirState = cacheListing === null ? 'unreadable' : 'readable';
  const cacheEntries = cacheListing ?? [];
  const candidates = [];
  for (const d of cacheEntries) {
    if (!d.isDirectory()) continue;
    const text = readOrNull(join(cacheDir, d.name, 'fragments', 'substrate-conventions.md'));
    if (text === null) continue;
    const m = readMarker(text);
    candidates.push({
      version: m?.version ?? d.name,
      digest: m?.digest ?? null,
      origin: `cache/${d.name}`,
      text
    });
  }

  // Which plugin version served the skill this session is following.
  //
  // The env var is authoritative when present, and it usually is NOT: the harness
  // expands `${CLAUDE_PLUGIN_ROOT}` into the hook's COMMAND STRING rather than
  // guaranteeing it in `process.env` — entry.js resolves its own plugin root the
  // same way and for the same reason. Relying on it alone would report
  // `[????] cannot tell which version served this skill` as normal.
  //
  // It is answerable without the variable. The skill invokes this file as
  // `node "<servedRoot>/bin/audit.mjs"`, so THIS FILE IS INSIDE THE TREE THAT
  // SERVED THE SKILL — the served version names itself in the path the audit is
  // running from, and reading it does not depend on an agent noticing it.
  //
  // A derived root is only comparable to the install when it sits under the
  // plugin CACHE. Run from a source checkout it reports the working tree, which
  // is a fact about the auditor and not about the session — reporting it as
  // `served` would substitute the auditor for the session.
  const servedRoot = envRoot ?? selfRoot;
  const servedRootState =
    envRoot !== null
      ? 'set'
      : selfRoot.startsWith(`${cacheDir}/`)
        ? 'derived-cache'
        : 'derived-source';
  const servedVersion =
    readMarker(readOrNull(join(servedRoot, 'fragments', 'substrate-conventions.md')) ?? '')
      ?.version ?? null;

  const repoFragment = readMarker(
    readOrNull(join(targetDir, '.claude', 'substrate-conventions.md')) ?? ''
  );

  const resolution = resolveFragmentSource({
    candidates,
    installedVersion,
    servedVersion,
    installedFragment: repoFragment,
    isSourceRepo: isFragmentSourceRepo({ cwd: targetDir, exists: existsSync })
  });
  return {
    installedVersion,
    installedRegistry,
    cacheDirState,
    candidates,
    servedVersion,
    servedRootState,
    resolution
  };
}
