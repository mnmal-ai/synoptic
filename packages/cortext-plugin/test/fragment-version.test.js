import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { digestOf, MARKER_RE, splitFragment } from '../scripts/fragment-marker.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The fragment's marker is the entire refresh mechanism: /substrate-setup replaces a
// consumer repo's installed copy when the plugin's marker DIFFERS from theirs.
//
// The version half alone is not enough: a content edit without a version bump
// would leave every installed plugin serving the old text, and nothing would
// fail. So the marker also carries a digest of the fragment body. These guards pin
// both halves: the version tracks the package, the digest tracks the actual
// bytes. Editing the fragment without re-running `pnpm sync-version` now fails
// here instead of shipping silently.
describe('conventions fragment version marker', () => {
  const fragment = readFileSync(join(root, 'fragments/substrate-conventions.md'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  it('starts with a structurally valid marker', () => {
    expect(
      splitFragment(fragment),
      'fragment line 1 must be a `<!-- substrate-conventions vsynoptic-X.Y.Z+<sha8> ... -->` comment'
    ).not.toBeNull();
  });

  it('matches the package version', () => {
    const marker = fragment.match(MARKER_RE);
    expect(marker, 'fragment must start with a vsynoptic-X.Y.Z marker comment').not.toBeNull();
    expect(marker[1]).toBe(pkg.version);
  });

  it('carries a digest of the current fragment body', () => {
    const marker = fragment.match(MARKER_RE);
    expect(
      marker[2],
      'marker is missing its +<sha8> digest — run `pnpm sync-version`'
    ).toBeDefined();
    expect(
      marker[2],
      'fragment body changed without re-stamping the marker. A content edit that ships ' +
        'with an unchanged marker never reaches already-onboarded repos — run `pnpm sync-version`.'
    ).toBe(digestOf(splitFragment(fragment).body));
  });

  it('matches the plugin manifest version', () => {
    const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'));
    expect(manifest.version).toBe(pkg.version);
  });
});

// synoptic is the SOURCE of the fragment and also one of its CONSUMERS: the
// repo's own `.claude/substrate-conventions.md` is an installed copy, the same
// artifact /substrate-setup writes into every consumer repo. `fragment-drift`
// and `fleet-fragments` in packages/synoptic test the drift LOGIC from string
// fixtures and say nothing about this repo's state, so this checks the two
// copies agree.
describe('installed fragment copy at the repo root', () => {
  const repoRoot = join(root, '../..');
  const source = readFileSync(join(root, 'fragments/substrate-conventions.md'), 'utf8');
  const installedPath = join(repoRoot, '.claude/substrate-conventions.md');

  // The copy is untracked, so a fresh clone or CI has none to compare.
  it.skipIf(!existsSync(installedPath))('is byte-identical to the plugin-owned source', () => {
    const installed = readFileSync(installedPath, 'utf8');
    expect(
      installed,
      "this repo's .claude/substrate-conventions.md has drifted from " +
        'packages/cortext-plugin/fragments/substrate-conventions.md — copy the source over it. ' +
        'The installed copy is what THIS repo reads at cold-start, so a stale one means ' +
        'synoptic is the only repo in the fleet not following its own conventions.'
    ).toBe(source);
  });
});
