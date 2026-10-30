/**
 * Release-surface parity + classification.
 *
 * The committed `release-surface.json` is what `scripts/check-release-class.mjs`
 * diffs at release time, so it has to be current. Same pattern as
 * `schema-parity.test.ts` and for the same reason: a generated artifact that
 * nothing locks is an artifact that silently stops describing its source.
 *
 * To regenerate after a deliberate schema change:
 *
 *   UPDATE_SURFACE=1 pnpm --filter @mnmal-ai/cortext test
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildApiSurface,
  buildReleaseSurface,
  bumpClass,
  classifySurfaceChange,
  classSatisfies,
  parseDtsExports,
  type ReleaseSurface,
  resolveSurfaceEntries,
  SURFACE_FORMAT
} from '../src/release-surface.js';

const here = dirname(fileURLToPath(import.meta.url));
const surfacePath = resolve(here, '..', 'release-surface.json');
const repoRoot = resolve(here, '..', '..', '..');

/** The published packages, per the membership rule: published AND exporting a
 *  type implemented or constructed outside its own repo. */
const PUBLISHED = ['cortext'];

const sha8 = (input: string): string =>
  createHash('sha256').update(input).digest('hex').slice(0, 8);

function collectApi(): Record<string, ReturnType<typeof buildApiSurface>[string]> | null {
  const entries = [];
  for (const pkg of PUBLISHED) {
    const pkgDir = join(repoRoot, 'packages', pkg);
    const dist = join(pkgDir, 'dist');
    if (!existsSync(join(dist, 'index.d.ts'))) return null; // not built
    // EVERY published subpath, not just the root. `./bootstrap` exports
    // names a root-only read would miss.
    const exportsMap = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).exports;
    const resolved = resolveSurfaceEntries(exportsMap, (rel) => existsSync(join(pkgDir, rel)));
    const allDts = (readdirSync(dist, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.d.ts'))
      .map((f) => readFileSync(join(dist, f), 'utf8'));
    entries.push({
      name: pkg,
      entries: resolved.map((r) => ({
        subpath: r.subpath,
        dts: readFileSync(join(pkgDir, r.dtsPath), 'utf8')
      })),
      allDts
    });
  }
  return buildApiSurface(entries, sha8);
}

describe('release-surface.json parity', () => {
  it('committed JSON matches the built namespace', () => {
    const api = collectApi();
    // A missing dist means the API half CANNOT be compared. Carrying the
    // committed value forward is the honest move — regenerating it as absent
    // would silently delete the surface on any unbuilt run, which is the
    // silent-success shape this whole guard exists to prevent.
    const committed = existsSync(surfacePath)
      ? JSON.parse(readFileSync(surfacePath, 'utf8'))
      : null;
    const built = {
      ...buildReleaseSurface('cortext'),
      api: api ?? committed?.api,
      surfaceFormat: SURFACE_FORMAT
    };
    const serialised = `${JSON.stringify(built, null, 2)}\n`;
    if (process.env.UPDATE_SURFACE === '1') {
      writeFileSync(surfacePath, serialised);
    }
    expect(readFileSync(surfacePath, 'utf8')).toBe(serialised);
  });

  it('is stable across builds — an unstable snapshot is diff noise', () => {
    expect(JSON.stringify(buildReleaseSurface('cortext'))).toBe(
      JSON.stringify(buildReleaseSurface('cortext'))
    );
  });

  it('captures the write contract, not merely the field list', () => {
    const todo = buildReleaseSurface('cortext').types.Todo!;
    // Todo.title is required; Todo.notes is nullable and therefore not.
    expect(todo.title!.required).toBe(true);
    expect(todo.notes!.required).toBe(false);
    expect(todo.status!.enum).toContain('open');
    expect(todo.implementsDecision!.kind).toBe('crossRef');
    expect(todo.implementsDecision!.target).toBe('Decision');
  });

  it('carries the substrate contract range, since moving it is a break', () => {
    expect(buildReleaseSurface('cortext').contractVersion).toMatch(/^>=/);
  });
});

const base = (): ReleaseSurface => ({
  contractVersion: '>=4.1.0 <6.0.0',
  types: {
    Todo: {
      title: {
        kind: 'scalar',
        type: 'string',
        nullable: false,
        hasDefault: false,
        readonly: false,
        serverSet: false,
        indexed: true,
        required: true
      },
      notes: {
        kind: 'scalar',
        type: 'string',
        nullable: true,
        hasDefault: false,
        readonly: false,
        serverSet: false,
        indexed: false,
        required: false
      },
      status: {
        kind: 'scalar',
        type: 'string',
        nullable: false,
        hasDefault: true,
        readonly: false,
        serverSet: false,
        indexed: true,
        required: false,
        enum: ['done', 'open']
      }
    }
  }
});

const withTodo = (mutate: (t: ReleaseSurface) => void): ReleaseSurface => {
  const s = base();
  mutate(s);
  return s;
};

describe('classifySurfaceChange — breaking', () => {
  it('no change is a patch', () => {
    const r = classifySurfaceChange(base(), base());
    expect(r.class).toBe('patch');
    expect(r.breaking).toEqual([]);
  });

  it('a removed type is major', () => {
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        delete s.types.Todo;
      })
    );
    expect(r.class).toBe('major');
    expect(r.breaking[0]).toMatch(/type removed: Todo/);
  });

  it('a removed field is major', () => {
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        delete s.types.Todo!['notes'];
      })
    );
    expect(r.class).toBe('major');
  });

  it('optional -> REQUIRED is major, because it breaks every existing writer', () => {
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        s.types.Todo!.notes!.nullable = false;
        s.types.Todo!.notes!.required = true;
      })
    );
    expect(r.class).toBe('major');
    expect(r.breaking.join()).toMatch(/became REQUIRED/);
  });

  it('nullable -> non-nullable is major, because it breaks every existing ROW', () => {
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        s.types.Todo!.notes!.nullable = false;
      })
    );
    expect(r.breaking.join()).toMatch(/no longer nullable/);
  });

  it('a NEW required field is major, not additive', () => {
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        s.types.Todo!.owner = {
          kind: 'scalar',
          type: 'string',
          nullable: false,
          hasDefault: false,
          readonly: false,
          serverSet: false,
          indexed: true,
          required: true
        };
      })
    );
    expect(r.class).toBe('major');
    expect(r.breaking.join()).toMatch(/added as REQUIRED/);
  });

  it('narrowing an enum is major — it rejects values already stored', () => {
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        s.types.Todo!.status!.enum = ['open'];
      })
    );
    expect(r.class).toBe('major');
    expect(r.breaking.join()).toMatch(/enum narrowed.*lost done/);
  });

  it('un-indexing is a review item, not a break — the filter still works, as a scan', () => {
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        s.types.Todo!.title!.indexed = false;
      })
    );
    expect(r.breaking).toEqual([]);
    expect(r.review.join()).toMatch(/no longer indexed/);
  });

  it('moving the substrate contract range is major', () => {
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        s.contractVersion = '>=5.0.0 <7.0.0';
      })
    );
    expect(r.class).toBe('major');
    expect(r.breaking[0]).toMatch(/contract range moved/);
  });

  it('reports EVERY reason, not just the first', () => {
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        delete s.types.Todo!['notes'];
        s.types.Todo!.status!.enum = ['open'];
      })
    );
    expect(r.breaking.length).toBe(2);
  });
});

describe('classifySurfaceChange — additive', () => {
  it('a new type is minor', () => {
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        s.types.Initiative = {};
      })
    );
    expect(r.class).toBe('minor');
  });

  it('a new OPTIONAL field is minor', () => {
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        s.types.Todo!.gate = {
          kind: 'scalar',
          type: 'string',
          nullable: true,
          hasDefault: false,
          readonly: false,
          serverSet: false,
          indexed: false,
          required: false
        };
      })
    );
    expect(r.class).toBe('minor');
    expect(r.breaking).toEqual([]);
  });

  it('widening an enum is minor', () => {
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        s.types.Todo!.status!.enum = ['blocked', 'done', 'open'];
      })
    );
    expect(r.class).toBe('minor');
  });

  it('this repo already did one: enum -> defaulted string is ADDITIVE', () => {
    // cortext/Decision.status dropped its enum for a defaulted string; this
    // asserts the guard sizes that as additive rather than crying major.
    const r = classifySurfaceChange(
      base(),
      withTodo((s) => {
        delete s.types.Todo!.status!.enum;
      })
    );
    expect(r.class).toBe('minor');
    expect(r.additive.join()).toMatch(/enum constraint dropped/);
  });
});

describe('bumpClass and classSatisfies', () => {
  it('reads the class out of a version pair', () => {
    expect(bumpClass('1.10.0', '2.0.0')).toBe('major');
    expect(bumpClass('1.10.0', '1.11.0')).toBe('minor');
    expect(bumpClass('1.10.0', '1.10.1')).toBe('patch');
  });

  it('is numeric, so 1.9.0 -> 1.10.0 is a MINOR not a patch', () => {
    expect(bumpClass('1.9.0', '1.10.0')).toBe('minor');
  });

  it('tolerates a v prefix and rejects a non-bump', () => {
    expect(bumpClass('v1.10.0', 'v1.10.1')).toBe('patch');
    expect(bumpClass('1.10.0', '1.10.0')).toBeNull();
    expect(bumpClass('1.10.0', '1.9.0')).toBeNull();
  });

  it('a larger bump satisfies a smaller requirement, never the reverse', () => {
    expect(classSatisfies('major', 'minor')).toBe(true);
    expect(classSatisfies('minor', 'minor')).toBe(true);
    expect(classSatisfies('patch', 'minor')).toBe(false);
  });
});

describe('published API surface', () => {
  it('parses re-export lists, type modifiers and aliases', () => {
    const dts = `export { auditObjects, type Finding, scopedNamespace } from './invariant-audit.js';
export { SUBSTRATE_CONTRACT_RANGE } from './substrate-contract.js';
export declare function createCortextKernelPlugin(): unknown;
export type ReleaseClass = 'major';`;
    expect(parseDtsExports(dts)).toEqual(
      [
        'SUBSTRATE_CONTRACT_RANGE',
        'ReleaseClass',
        'auditObjects',
        'createCortextKernelPlugin',
        'scopedNamespace',
        'type Finding'.replace('type ', '')
      ].sort()
    );
  });

  it('a removed export is BREAKING, an added one additive', () => {
    const b = {
      contractVersion: 'x',
      types: {},
      api: { p: { exports: ['a', 'b'], dtsDigest: '1' } }
    };
    const a = {
      contractVersion: 'x',
      types: {},
      api: { p: { exports: ['b', 'c'], dtsDigest: '1' } }
    };
    const r = classifySurfaceChange(b, a);
    expect(r.breaking).toEqual(['export removed: p#a']);
    expect(r.additive).toEqual(['export added: p#c']);
    expect(r.class).toBe('major');
  });

  it('a SIGNATURE change with no name change raises the floor to minor and asks a human', () => {
    // The live miss this was built for: auditObjects kept its name and changed
    // its return type from Finding[] to { findings, checked }. Names alone see
    // nothing; a schema-only surface sees nothing.
    const b = {
      contractVersion: 'x',
      types: {},
      api: { p: { exports: ['a'], dtsDigest: 'aaaa' } }
    };
    const a = {
      contractVersion: 'x',
      types: {},
      api: { p: { exports: ['a'], dtsDigest: 'bbbb' } }
    };
    const r = classifySurfaceChange(b, a);
    expect(r.breaking).toEqual([]);
    expect(r.class).toBe('minor');
    expect(r.review.join()).toMatch(/declarations changed \(aaaa -> bbbb\)/);
  });

  it('never auto-majors a digest change — it cannot tell widening from narrowing', () => {
    const b = {
      contractVersion: 'x',
      types: {},
      api: { p: { exports: ['a'], dtsDigest: 'aaaa' } }
    };
    const a = {
      contractVersion: 'x',
      types: {},
      api: { p: { exports: ['a'], dtsDigest: 'bbbb' } }
    };
    expect(classifySurfaceChange(b, a).class).not.toBe('major');
  });

  it('an absent api section is NOT COMPARED rather than treated as empty', () => {
    // Treating it as empty would report every export as newly added — a
    // confident, wrong minor on the first snapshot after this shipped.
    const b = { contractVersion: 'x', types: {} };
    const a = { contractVersion: 'x', types: {}, api: { p: { exports: ['a'], dtsDigest: '1' } } };
    const r = classifySurfaceChange(b, a);
    expect(r.additive).toEqual([]);
    expect(r.class).toBe('patch');
  });
});

// ---------------------------------------------------------------------------
// Subpath exports. A guard that read only `dist/index.d.ts` would leave every
// name published from `./bootstrap` outside the surface entirely.
// ---------------------------------------------------------------------------

/** A minimal surface carrying only an `api` section, at the current format. */
const apiOnly = (exports: string[]): ReleaseSurface => ({
  contractVersion: 'x',
  types: {},
  api: { cortext: { exports, dtsDigest: 'aaaa' } },
  surfaceFormat: SURFACE_FORMAT
});

describe('subpath exports', () => {
  it('a removal from ./bootstrap is MAJOR — the measured under-sizing', () => {
    // Before the fix this classified MINOR: the name was never in `exports`, so
    // only the dtsDigest moved, and a review item floors at minor. Wrong in one
    // direction only, which is the hard kind to notice.
    const r = classifySurfaceChange(
      apiOnly(['.:buildReleaseSurface', './bootstrap:bootstrap']),
      apiOnly(['.:buildReleaseSurface'])
    );
    expect(r.class).toBe('major');
    expect(r.breaking[0]).toMatch(/export removed: cortext#\.\/bootstrap:bootstrap/);
  });

  it('a MOVE between subpaths is major — which a bare union cannot see', () => {
    // The reason exports are qualified rather than unioned. Relocating a name
    // from "." to "./bootstrap" breaks every existing importer while leaving a
    // union byte-identical.
    const r = classifySurfaceChange(apiOnly(['.:bootstrap']), apiOnly(['./bootstrap:bootstrap']));
    expect(r.class).toBe('major');
    expect(r.breaking[0]).toMatch(/export removed: cortext#\.:bootstrap/);
    expect(r.additive[0]).toMatch(/export added: cortext#\.\/bootstrap:bootstrap/);
  });

  it('an addition to ./bootstrap is minor, not major', () => {
    const r = classifySurfaceChange(
      apiOnly(['.:a']),
      apiOnly(['.:a', './bootstrap:CortextBootstrapConfig'])
    );
    expect(r.class).toBe('minor');
  });

  it('a FORMAT change is not compared, and says so instead of faking a major', () => {
    // Format 1 named exports bare; format 2 qualifies them. Diffed across the
    // change, every export reads as removed and re-added — a MAJOR generated by
    // a tooling edit that touched no published API. Not compared, and stated.
    const before: ReleaseSurface = {
      contractVersion: 'x',
      types: {},
      api: { cortext: { exports: ['bootstrap'], dtsDigest: 'aaaa' } }
      // no surfaceFormat -> format 1
    };
    const r = classifySurfaceChange(before, apiOnly(['./bootstrap:bootstrap']));
    expect(r.breaking).toEqual([]);
    expect(r.review.join(' ')).toMatch(/comparison SKIPPED: surface format 1 -> 2/);
    // Minor, not patch: something moved and a patch asserts nothing did.
    expect(r.class).toBe('minor');
  });
});

describe('resolveSurfaceEntries', () => {
  const map = {
    '.': { import: './dist/index.js', types: './dist/index.d.ts' },
    './bootstrap': { import: './dist/bootstrap.js', types: './dist/bootstrap.d.ts' }
  };

  it('resolves every subpath that publishes types', () => {
    expect(resolveSurfaceEntries(map, () => true)).toEqual([
      { subpath: '.', dtsPath: 'dist/index.d.ts' },
      { subpath: './bootstrap', dtsPath: 'dist/bootstrap.d.ts' }
    ]);
  });

  it('THROWS on a declared subpath whose file is missing, rather than skipping it', () => {
    // The whole point. Silently dropping a subpath whose layout does not match
    // the assumption recreates the blind spot this function removes — an unread
    // surface reporting clean.
    expect(() => resolveSurfaceEntries(map, (rel) => rel !== 'dist/bootstrap.d.ts')).toThrow(
      /publishes 'dist\/bootstrap.d.ts', which does not exist/
    );
  });

  it('skips a subpath that publishes no types condition', () => {
    // Not every export is code — a package may map a subpath at a config file,
    // and handing that to a .d.ts parser produces nonsense rather than an error.
    const withJson = { ...map, './biome': './biome.json' };
    expect(resolveSurfaceEntries(withJson, () => true).map((e) => e.subpath)).toEqual([
      '.',
      './bootstrap'
    ]);
  });

  it('falls back to the conventional single entry with no exports map', () => {
    expect(resolveSurfaceEntries(undefined, () => true)).toEqual([
      { subpath: '.', dtsPath: 'dist/index.d.ts' }
    ]);
    expect(resolveSurfaceEntries(undefined, () => false)).toEqual([]);
  });
});
