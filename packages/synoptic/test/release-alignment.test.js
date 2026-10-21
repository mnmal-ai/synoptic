// "Three skins ride one tag" is a release-process claim — this test is the
// machine that keeps it true. Every package version, both Claude plugin
// manifests, and both conventions markers must name the same version, or a
// release ships skins that disagree about what tag they belong to (and the
// audit's `skins` group compares the OpenCode skin against a fiction).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MARKER_RE } from '../../cortext-plugin/scripts/fragment-marker.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const pkg = (name) =>
  JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8')).version;

const manifest = (name) =>
  JSON.parse(readFileSync(join(ROOT, 'packages', name, '.claude-plugin', 'plugin.json'), 'utf8'))
    .version;

const markerVersion = (rel) => {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const m = MARKER_RE.exec(text.split('\n', 1)[0] ?? '');
  if (m?.[1] === undefined) throw new Error(`${rel} carries no version marker on line 1`);
  return m[1];
};

describe('one tag across the release set', () => {
  const versions = Object.fromEntries(
    ['synoptic', 'cortext', 'cortext-plugin', 'cortext-opencode', 'cortext-codex'].map((p) => [
      p,
      pkg(p)
    ])
  );

  it('every workspace package shares one version', () => {
    const distinct = new Set(Object.values(versions));
    expect([...distinct], `versions diverge: ${JSON.stringify(versions)}`).toHaveLength(1);
  });

  it('the Claude plugin manifest is stamped to the package version', () => {
    expect(manifest('cortext-plugin')).toBe(versions['cortext-plugin']);
  });

  it('the repo marketplace pins the tag of this version', () => {
    const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
    const entry = market.plugins.find((p) => p.name === 'cortext');
    expect(entry.source.ref).toBe(`v${versions['cortext-plugin']}`);
  });

  it('the local Codex manifest is stamped to the package version', () => {
    const codexManifest = JSON.parse(
      readFileSync(join(ROOT, 'packages/cortext-codex/.codex-plugin/plugin.json'), 'utf8')
    );
    expect(codexManifest.version).toBe(versions['cortext-codex']);
  });

  it('both conventions markers name the package version', () => {
    expect(markerVersion('packages/cortext-plugin/fragments/substrate-conventions.md')).toBe(
      versions['cortext-plugin']
    );
    expect(markerVersion('packages/cortext-opencode/instructions/substrate-conventions.md')).toBe(
      versions['cortext-opencode']
    );
  });

  // This repo is the fragment's source AND a consumer of it, and
  // /substrate-setup skips a source repo (resolver exit 2), so nothing but the
  // version script keeps the installed copy current. A stale marker here makes
  // the newer-version check fire on a repo that is actually current.
  it("this repo's installed fragment is byte-identical to the source", () => {
    const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
    expect(read('.claude/substrate-conventions.md')).toBe(
      read('packages/cortext-plugin/fragments/substrate-conventions.md')
    );
  });
});
