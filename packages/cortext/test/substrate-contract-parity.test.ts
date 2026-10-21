/**
 * Guard for the substrate compatibility contract, which lives in artifacts a
 * reader would assume move together and which nothing else forces to:
 *
 *   - `contractVersion` on both plugin objects   (loader checks it at boot)
 *   - the `@mnmal-ai/substrate` peer range        (package manager checks at install)
 *   - `deps.neverBundle` in the tsdown config     (bundler honours it at build)
 *
 * The defect this exists for: a package imported from `src` for its values
 * while declared in neither `dependencies` nor `peerDependencies` is INLINED
 * by the bundler, silently: private copies of the packages the peer range
 * exists to keep single. Reading `dist` cannot catch it, since an inlined package leaves no
 * specifier, so the check runs from the import graph towards the manifest.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CortextBootstrapConfigSchema } from '../src/bootstrap.js';
import { createCortextPlugin } from '../src/index.js';
import { createCortextKernelPlugin, SUBSTRATE_CONTRACT_RANGE } from '../src/kernel/index.js';
import tsdown from '../tsdown.config.js';

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, unknown>;
}

const pkg: Manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
);
const neverBundle =
  (tsdown as { deps?: { neverBundle?: (string | RegExp)[] } }).deps?.neverBundle ?? [];
const workspace = readFileSync(
  fileURLToPath(new URL('../../../pnpm-workspace.yaml', import.meta.url)),
  'utf8'
);
const catalogVersion = workspace.match(/^\s+"@mnmal-ai\/substrate":\s*"([^"]+)"/m)?.[1];

/** The package each `@mnmal-ai/*` value import names, from a regex over `src`. */
function runtimeImports(): { pkgName: string; specifier: string; file: string }[] {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const found: { pkgName: string; specifier: string; file: string }[] = [];
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    if (!rel.endsWith('.ts')) continue;
    const text = readFileSync(join(root, rel), 'utf8');
    for (const m of text.matchAll(
      /^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s*'(@mnmal-ai\/[^']+)'/gm
    )) {
      const [, isType, specifier] = m;
      if (isType || specifier === undefined) continue;
      found.push({ pkgName: specifier.split('/').slice(0, 2).join('/'), specifier, file: rel });
    }
  }
  return found;
}

describe('substrate contract', () => {
  it('peers @mnmal-ai/substrate alone, at the shared range', () => {
    expect(pkg.peerDependencies).toEqual({ '@mnmal-ai/substrate': SUBSTRATE_CONTRACT_RANGE });
    expect(pkg.peerDependenciesMeta ?? {}).toEqual({});
  });

  it('names no substrate package in dependencies', () => {
    // In both lists it resolves as a normal dependency: a private copy, and the
    // peer range becomes decoration.
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.filter((d) => d.startsWith('@mnmal-ai/substrate'))).toEqual([]);
  });

  it('develops against the range floor from the catalog', () => {
    expect(pkg.devDependencies?.['@mnmal-ai/substrate']).toBe('catalog:');
    expect(catalogVersion).toBe(SUBSTRATE_CONTRACT_RANGE.match(/^>=(\S+) /)?.[1]);
  });

  it('externalises every substrate subpath it imports', () => {
    for (const { specifier, file } of runtimeImports()) {
      const external = neverBundle.some((e) =>
        typeof e === 'string' ? e === specifier : e.test(specifier)
      );
      expect(external, `${file} imports ${specifier}, which tsdown would bundle`).toBe(true);
    }
  });

  it('declares every package it imports for values', () => {
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {})
    ]);
    const imports = runtimeImports();
    // Guards the scanner: one that matched nothing would make this vacuous.
    expect(imports.length).toBeGreaterThan(0);
    for (const { pkgName, specifier, file } of imports) {
      expect(
        declared.has(pkgName),
        `${file} imports ${specifier}, declared nowhere: the bundler will INLINE it`
      ).toBe(true);
    }
  });
});

describe('contractVersion', () => {
  it('is the shared range on both plugins', () => {
    const defaults = CortextBootstrapConfigSchema.parse({});
    const coordinator = createCortextPlugin({ ...defaults, autoCompactIntervalMs: undefined });
    expect(coordinator.contractVersion).toBe(SUBSTRATE_CONTRACT_RANGE);
    expect(createCortextKernelPlugin().contractVersion).toBe(SUBSTRATE_CONTRACT_RANGE);
  });
});
