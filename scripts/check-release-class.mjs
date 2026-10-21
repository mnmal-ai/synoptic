#!/usr/bin/env node
// Size a release against what actually changed.
//
//   node scripts/check-release-class.mjs [--from vX.Y.Z] [--to <version>] [--reason "<why>"]
//
//   exit 0  the proposed bump is justified — either it matches what the surface
//           requires, or it exceeds it with a stated reason
//   exit 1  too small: the surface requires more than proposed
//   exit 2  the question could not be answered (no baseline, not a bump)
//   exit 3  larger than the surface can justify, with no reason given
//
// ## Why it compares the surface, not files
//
// A guard that defines the surface as a set of paths approves a breaking change
// when the type moves out of those paths: an empty `git diff` on a stale path
// is indistinguishable from no change.
//
// So this never asks git which FILES changed. It compares two snapshots of the
// surface itself — `packages/cortext/release-surface.json`, derived by calling
// `buildClaudeNamespace()` and kept current by a parity test. A declaration
// moving between files changes nothing here, because nothing here points at a
// file.
//
// ## And it refuses rather than guessing
//
// If the snapshot did not exist at the previous tag, the comparison is
// impossible — not "no changes". It exits 2.
//
// ## WHAT IT CANNOT SEE, AND WHY THAT IS PRINTED RATHER THAN ASSUMED
//
// The surface is a TYPE surface: namespace schema, export names, and a digest
// over the emitted `.d.ts`. Declarations carry signatures, not implementations,
// so a behaviour change inside an exported function CANNOT move it: a
// body-only edit leaves `release-surface.json` byte-identical. The risk is a
// green check sitting beside a hand-sized release and reading as agreement.
//
// So this never prints an unqualified OK. Every success line names the boundary
// it did not cross, and a bump LARGER than the surface requires — which is
// legitimate and common, because behaviour ships without types moving — has to
// be STATED with `--reason`, so the record says a human sized it rather than
// implying the tool did. Same distinction as `applied` against `requested`, and
// as frame presence against emptiness: report what was established, not what
// would have been true if the thing you could not check had gone your way.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SURFACE = 'packages/cortext/release-surface.json';
const PKG = join(ROOT, 'packages/cortext/package.json');

function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}

// What the type surface structurally cannot contain. Printed on every run,
// success included, so a reader does not have to remember it.
const BLIND_SPOT = [
  '  NOT CHECKED — outside a type surface by construction:',
  '    - behaviour inside an exported function (declarations carry signatures,',
  '      not implementations; measured — a body-only edit leaves this identical)',
  '    - hooks, bins, skills and the conventions fragment',
  '    - anything a consumer depends on that is not schema or exported types'
];

function fail(code, message) {
  console.error(`release-class: ${message}`);
  process.exit(code);
}

const flags = parseArgs(process.argv.slice(2));

let from = flags.from ?? null;
if (from === null) {
  try {
    from = git(['describe', '--tags', '--abbrev=0']);
  } catch {
    fail(2, 'no previous tag found and --from not given, so there is nothing to compare against.');
  }
}

const to = flags.to ?? JSON.parse(readFileSync(PKG, 'utf8')).version;

// The previous surface. An absent snapshot means the comparison cannot be made
// — deliberately NOT treated as an empty surface, which would classify every
// existing type as newly added and report a confident, wrong `minor`.
let before = null;
try {
  before = JSON.parse(git(['show', `${from}:${SURFACE}`]));
} catch {
  fail(
    2,
    `no ${SURFACE} at ${from}. The surface cannot be compared, which is NOT the same as ` +
      'unchanged — size this release by hand, and the next one will be checkable.'
  );
}

const after = JSON.parse(readFileSync(join(ROOT, SURFACE), 'utf8'));

// Import the classifier from the built package so the rules live in ONE place,
// beside the builder and its tests, rather than being restated here.
const { classifySurfaceChange, classSatisfies, bumpClass } = await import(
  join(ROOT, 'packages/cortext/dist/index.js')
).catch(() => ({}));

if (typeof classifySurfaceChange !== 'function') {
  fail(2, 'packages/cortext/dist is not built — run `pnpm build` first.');
}

const CLASS_RANK = { patch: 0, minor: 1, major: 2 };
const change = classifySurfaceChange(before, after);
const proposed = bumpClass(from, to);

const out = [];
out.push(`release-class: ${from} -> ${to}`);
out.push('');
out.push(`  surface requires:  ${change.class.toUpperCase()}`);
out.push(`  version proposes:  ${proposed === null ? '(not a bump)' : proposed.toUpperCase()}`);
out.push('');

if (change.breaking.length > 0) {
  out.push('  BREAKING:');
  for (const r of change.breaking) out.push(`    - ${r}`);
}
if (change.additive.length > 0) {
  out.push('  additive:');
  for (const r of change.additive) out.push(`    + ${r}`);
}
// Review items are the least certain findings, so they are the ones most
// needing a human.
if (change.review.length > 0) {
  out.push('  NEEDS A HUMAN:');
  for (const r of change.review) out.push(`    ? ${r}`);
}
if (change.breaking.length === 0 && change.additive.length === 0 && change.review.length === 0) {
  out.push('  the plugin-facing surface is byte-identical.');
  out.push('  That means no consumer holding data or code against the SCHEMA or the');
  out.push('  exported TYPES can be broken by this change. It does NOT mean nothing');
  out.push('  shipped.');
}
out.push('');
out.push(...BLIND_SPOT);
console.log(out.join('\n'));

if (proposed === null) {
  fail(2, `'${to}' is not an increase over '${from}', so there is no bump to check.`);
}
if (!classSatisfies(proposed, change.class)) {
  fail(
    1,
    `a ${proposed} bump is too small — the surface requires ${change.class}. ` +
      'Raise the version, or reconsider the change.'
  );
}

// A bump LARGER than the surface requires is the normal case for a behaviour
// release, and it is exactly where this tool knows least. Requiring the reason
// keeps the record honest about who did the sizing: without it, a green line
// sits beside a hand-sized release and reads as the tool agreeing.
const reason = flags.reason ?? null;
if (CLASS_RANK[proposed] > CLASS_RANK[change.class]) {
  if (reason === null || reason.trim() === '') {
    fail(
      3,
      `a ${proposed} bump EXCEEDS the ${change.class} this surface can justify, which is ` +
        'normal for a behaviour change — but the surface cannot see behaviour, so it cannot ' +
        'agree with you. Say what you are sizing for:\n' +
        `  node scripts/check-release-class.mjs --from ${from} --to ${to} --reason "<why>"\n` +
        'The reason is recorded so the record shows a human sized this, not this tool.'
    );
  }
  console.log(`\n  OK: ${proposed} bump, sized ABOVE the surface by a stated reason.`);
  console.log(`  stated: ${reason.trim()}`);
  console.log('  This tool did not verify that reason and cannot. It confirms only that');
  console.log(`  nothing in the type surface requires MORE than ${proposed}.`);
} else {
  console.log(`\n  OK: a ${proposed} bump covers the ${change.class} the surface requires.`);
  console.log('  Scope: schema + exported types only. See NOT CHECKED above before');
  console.log('  reading this as "the release is safe".');
}
