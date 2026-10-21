#!/usr/bin/env node
/**
 * Stamp `package.json`'s version into the two places that must track it but have
 * no other reason to change together: the conventions-fragment marker (line 1 of
 * `fragments/substrate-conventions.md`), the plugin manifest (`.claude-plugin/
 * plugin.json`) and the repo marketplace's tag ref. The marker is the fragment's entire refresh mechanism —
 * `/substrate-setup` re-installs a consumer's copy when the marker DIFFERS, so a
 * marker that fails to move silently never propagates.
 *
 * The marker therefore carries a content digest as well as the version:
 *
 *     <!-- substrate-conventions vsynoptic-3.13.0+1a2b3c4d — plugin-owned; ... -->
 *
 * The `+<sha8>` half is a sha256 of the fragment BODY (everything after the
 * marker line), so ANY content edit moves the marker even when the version is
 * unchanged: an edit without a version bump would otherwise leave every
 * installed plugin serving the old text. Content alone drives propagation.
 *
 * Runs automatically on `pnpm version` via the `version` lifecycle hook, and is
 * available standalone as `pnpm sync-version`. Idempotent: a no-op when already
 * in sync, exits non-zero only on a structurally-broken file.
 * `test/fragment-version.test.js` remains the backstop for the manual-edit path
 * — it recomputes the digest and fails if the marker was not re-stamped.
 *
 * Edits are surgical regex replacements (not re-serialisation) so file
 * formatting, key order, and surrounding marker text are preserved byte-for-byte.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMarkerLine, splitFragment } from './fragment-marker.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Replace `pattern` in the file at `path`; returns true if the bytes changed. */
function stamp(relPath, pattern, replacement, label) {
  const path = join(root, relPath);
  const before = readFileSync(path, 'utf8');
  if (!pattern.test(before)) {
    console.error(`sync-fragment-version: ${relPath} has no ${label} to stamp`);
    process.exit(1);
  }
  const after = before.replace(pattern, replacement);
  if (after !== before) writeFileSync(path, after);
  return after !== before;
}

/**
 * Restamp the fragment marker with `version` + a freshly-computed body digest.
 * Not routed through `stamp()` because the replacement depends on the file's
 * own body, which the generic helper has no way to see.
 */
function stampFragment(relPath) {
  const path = join(root, relPath);
  const before = readFileSync(path, 'utf8');
  const parts = splitFragment(before);
  if (parts === null) {
    console.error(`sync-fragment-version: ${relPath} has no vsynoptic-X.Y.Z marker to stamp`);
    process.exit(1);
  }
  const after = `${buildMarkerLine(parts.markerLine, version, parts.body)}\n${parts.body}`;
  if (after !== before) writeFileSync(path, after);
  return after !== before;
}

const fragChanged = stampFragment('fragments/substrate-conventions.md');

/**
 * The OpenCode skin ships the SOURCE body under its own marker line.
 * Its marker wording is kept; the body is copied from the source and the
 * version and digest restamped from it. Restamping from its own body instead
 * would leave a stale body with a digest that matches it, which
 * instructions-sync.test.ts catches only after the fact.
 */
function syncOpencodeCopy(relPath) {
  const path = join(root, relPath);
  const before = readFileSync(path, 'utf8');
  const own = splitFragment(before);
  const source = splitFragment(
    readFileSync(join(root, 'fragments/substrate-conventions.md'), 'utf8')
  );
  if (own === null || source === null) {
    console.error(`sync-fragment-version: ${relPath} has no vsynoptic-X.Y.Z marker to stamp`);
    process.exit(1);
  }
  const after = `${buildMarkerLine(own.markerLine, version, source.body)}\n${source.body}`;
  if (after !== before) writeFileSync(path, after);
  return after !== before;
}

const opencodeChanged = syncOpencodeCopy(
  '../cortext-opencode/instructions/substrate-conventions.md'
);

/**
 * This repo is the fragment's source AND a consumer of it, and
 * /substrate-setup's resolver skips a source repo, so the installed copy moves only
 * here. Copied whole, not restamped: it must equal the source byte for byte,
 * which release-alignment.test.js asserts.
 */
function syncInstalledCopy(relPath) {
  const path = join(root, relPath);
  if (!existsSync(path)) return false;
  const source = readFileSync(join(root, 'fragments/substrate-conventions.md'), 'utf8');
  if (readFileSync(path, 'utf8') === source) return false;
  writeFileSync(path, source);
  return true;
}

const installedChanged = syncInstalledCopy('../../.claude/substrate-conventions.md');

const manifestChanged = stamp(
  '.claude-plugin/plugin.json',
  /("version":\s*")\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(")/,
  `$1${version}$2`,
  '"version" field'
);

// The marketplace pins the tag this release is about to create, so the release
// PR carries its own repin and a box only ever installs released code.
const marketplaceChanged = stamp(
  '../../.claude-plugin/marketplace.json',
  /("ref":\s*"v)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(")/,
  `$1${version}$2`,
  '"ref" field'
);

console.log(
  fragChanged || opencodeChanged || installedChanged || manifestChanged || marketplaceChanged
    ? `sync-fragment-version: stamped ${version}`
    : `sync-fragment-version: already ${version}`
);
