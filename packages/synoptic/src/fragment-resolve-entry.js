#!/usr/bin/env node
// Executable entry for fragment resolution. Bundled into the
// plugin as `bin/resolve-fragment.mjs` exactly as the hooks are, so it is
// self-contained and has no import-resolution surface.
//
//   node bin/resolve-fragment.mjs [--target-dir DIR] [--plugins-dir DIR] [--apply]
//
// Dry-run by default. Exit codes are the contract /substrate-setup Step 3 reads:
//
//   0  installed (--apply), would install (dry run), or already current
//   1  REFUSED — a downgrade, or no source found. Nothing written.
//   2  SKIPPED — this repo ships the fragment
//
// ## Why a stale copy of THIS is still safe
//
// The skill invokes it through `${CLAUDE_PLUGIN_ROOT}`, which is the very value
// that can be stale. That is fine, and deliberately so: this program's
// decision depends on `installed_plugins.json` and the cache directory, never on
// where it was itself loaded from. A v1.9.0 copy resolving for a v1.12.0 install
// still reads the registry and still refuses the downgrade. The logic is
// location-independent, which is precisely what the paragraph it replaces was not.
//
// Arg-wiring only; the decision table lives in the tested pure module.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readMarker } from './fragment-drift.js';
import {
  isFragmentSourceRepo,
  renderResolution,
  resolveFragmentSource
} from './fragment-resolve.js';
import { readOrNull } from './fs-safe.js';

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
const targetDir = flags['target-dir'] ?? process.cwd();
const pluginsDir = flags['plugins-dir'] ?? join(homedir(), '.claude', 'plugins');
const cacheDir = join(pluginsDir, 'cache', 'mnmal-ai', 'cortext');

// 1. What this machine says it installed. An absent registry is a valid state
//    (a hand-dropped plugin never meets one), so it degrades to "unknown"
//    rather than failing — but then there is no downgrade floor to enforce.
let installedVersion = null;
try {
  const reg = JSON.parse(readFileSync(join(pluginsDir, 'installed_plugins.json'), 'utf8'));
  const entries = reg?.plugins?.['cortext@mnmal-ai'];
  if (Array.isArray(entries) && entries.length > 0) installedVersion = entries[0].version ?? null;
} catch {
  /* resolve on what is on disk */
}

// 2. Every fragment on disk. The MARKER is the truth, not the directory name:
//    a plugin whose dist was swapped in place makes the two disagree, and only
//    the marker describes what a reader would actually get.
const candidates = [];
let cacheVersions = [];
try {
  cacheVersions = readdirSync(cacheDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
} catch {
  /* no cache directory yet */
}
for (const v of cacheVersions) {
  const path = join(cacheDir, v, 'fragments', 'substrate-conventions.md');
  const text = readOrNull(path);
  if (text === null) continue;
  const marker = readMarker(text);
  candidates.push({
    version: marker?.version ?? v,
    digest: marker?.digest ?? null,
    path,
    origin: `cache/${v}`,
    text
  });
}

// 3. What served the running skill — reported so a stale serving root is visible even
//    when it did not change the outcome.
const servedRoot = process.env.CLAUDE_PLUGIN_ROOT ?? null;
let servedVersion = null;
if (servedRoot !== null) {
  const text = readOrNull(join(servedRoot, 'fragments', 'substrate-conventions.md'));
  servedVersion = text === null ? null : (readMarker(text)?.version ?? null);
}

// 4. What the consumer repo currently has.
const installedText = readOrNull(join(targetDir, '.claude', 'substrate-conventions.md'));
const installedFragment = installedText === null ? null : readMarker(installedText);

const result = resolveFragmentSource({
  candidates,
  installedVersion,
  servedVersion,
  installedFragment,
  isSourceRepo: isFragmentSourceRepo({ cwd: targetDir, exists: existsSync })
});

console.log(renderResolution(result));

if (result.action === 'skip-source-repo') process.exit(2);
if (result.action === 'refuse') process.exit(1);

if (result.action === 'install' && flags.apply === true) {
  const dest = join(targetDir, '.claude', 'substrate-conventions.md');
  writeFileSync(dest, result.chosen.text, 'utf8');
  console.log(`  -> wrote ${dest}`);
} else if (result.action === 'install') {
  console.log('  (dry run — pass --apply to write)');
}
process.exit(0);
