#!/usr/bin/env node
// Executable entry for cortext plugin-cache pruning. Bundled to
// `bin/prune-cache.mjs` like the hooks, the resolver and the audit.
//
//   node bin/prune-cache.mjs [--plugins-dir DIR] [--keep N] [--apply]
//
// **Dry-run by default.** It prints the plan and deletes nothing unless
// `--apply` is passed, because this is the only tool in the set that removes
// anything from disk and an irreversible default is the wrong default.
//
// Exit 0 on a completed plan (including "nothing to prune"), 1 on a refusal.
//
// It refuses rather than guessing when it cannot establish what to protect —
// same posture as the resolver refusing a downgrade. See src/cache-prune.js for
// why this is a correctness control rather than housekeeping.

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCachePrune, renderPrunePlan } from './cache-prune.js';
import { readMarker } from './fragment-drift.js';
import { compareVersions } from './fragment-resolve.js';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    flags[name] = name === 'apply' ? true : argv[++i];
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const pluginsDir = flags['plugins-dir'] ?? join(homedir(), '.claude', 'plugins');
const cacheDir = join(pluginsDir, 'cache', 'mnmal-ai', 'cortext');
const keep = Number(flags.keep ?? 2);

let versions = [];
try {
  versions = readdirSync(cacheDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
} catch {
  console.log('cortext plugin cache — prune plan\n\n  REFUSED: cache directory not readable.');
  process.exit(1);
}

let installedVersion = null;
try {
  const reg = JSON.parse(readFileSync(join(pluginsDir, 'installed_plugins.json'), 'utf8'));
  const e = reg?.plugins?.['cortext@mnmal-ai'];
  if (Array.isArray(e) && e.length > 0) installedVersion = e[0].version ?? null;
} catch {
  /* stays null -> the plan refuses, which is the point */
}

// The version serving THIS session.
//
// `CLAUDE_PLUGIN_ROOT` is NOT reliable here: the harness expands it into a
// hook's COMMAND STRING and does not guarantee it in `process.env` — see
// entry.js, which derives its plugin root the same way for the same reason.
// Measured: a plain shell has no such variable, so trusting it alone would
// leave the serving directory unprotected exactly when it matters.
//
// So the primary source is THIS FILE'S OWN LOCATION. The bin is bundled to
// `<cache>/<version>/bin/prune-cache.mjs`, which makes the property
// self-enforcing: **a prune can never delete the directory it is running from.**
// That is stronger than protecting a version someone told us about, because it
// holds even when every other signal is missing or wrong.
function selfRoot() {
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return null;
  }
}

const servedRoot = selfRoot() ?? process.env.CLAUDE_PLUGIN_ROOT ?? null;
let servedVersion = null;
if (servedRoot !== null) {
  try {
    const text = readFileSync(join(servedRoot, 'fragments', 'substrate-conventions.md'), 'utf8');
    servedVersion = readMarker(text)?.version ?? null;
  } catch {
    servedVersion = null;
  }
  // Fall back to the directory name so a session served from a cache dir is
  // still protected even when its fragment is unreadable.
  if (servedVersion === null) {
    const base = servedRoot.replace(/\/+$/, '').split('/').pop();
    if (versions.includes(base)) servedVersion = base;
  }
}

const plan = planCachePrune({
  versions,
  installedVersion,
  servedVersion,
  keep,
  compare: compareVersions
});

if (plan.refusal !== null) {
  console.log(renderPrunePlan(plan, { apply: false }));
  process.exit(1);
}

if (flags.apply === true) {
  for (const v of plan.remove) {
    // Bounded by construction: every path is cacheDir + a directory name this
    // program listed from cacheDir itself, never user-supplied.
    rmSync(join(cacheDir, v), { recursive: true, force: true });
  }
}

console.log(renderPrunePlan(plan, { apply: flags.apply === true }));
process.exit(0);
