/**
 * Structured-config bootstrap tests for `@mnmal-ai/cortext`.
 *
 * Pins the contract for the `bootstrap(rawConfig)` entry consumed by the
 * `SUBSTRATE_PLUGIN_DIR` loader. The helper-level contract (parse →
 * defaults → validate → invoke) is exercised in
 * `packages/substrate-bootstrap/test/bootstrap.test.ts`; these tests cover the
 * claude-specific contract: which namespaces install, that the cross-field
 * `namespace !== architectureNamespace` invariant fires, and that this
 * plugin's own schema rejects the obvious mis-shapes.
 */

import { BootstrapConfigError } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import { bootstrap, CortextBootstrapConfigSchema } from '../src/bootstrap.js';

describe('bootstrap — namespace install', () => {
  it('builds with cortext + architecture namespaces by default', () => {
    const plugin = bootstrap({});
    expect(plugin.name).toBe('cortext');
    expect(plugin.namespaces.map((n) => n.namespace).sort()).toEqual(['architecture', 'cortext']);
  });

  it('respects operator namespace overrides', () => {
    const plugin = bootstrap({ namespace: 'codex', architectureNamespace: 'arch-findings' });
    expect(plugin.namespaces.map((n) => n.namespace).sort()).toEqual(['arch-findings', 'codex']);
  });

  it('omits the auto-compact schedule when interval is unset', () => {
    const plugin = bootstrap({});
    expect(plugin.schedule).toEqual([]);
  });

  it('installs the auto-compact schedule when interval is set', () => {
    const plugin = bootstrap({ autoCompactIntervalMs: 60_000 });
    expect(plugin.schedule).toHaveLength(1);
    expect(plugin.schedule?.[0]?.intervalMs).toBe(60_000);
  });
});

describe('bootstrap — config validation', () => {
  it('rejects empty namespace', () => {
    expect(() => bootstrap({ namespace: '' })).toThrow(BootstrapConfigError);
  });

  it("rejects namespace containing '/'", () => {
    expect(() => bootstrap({ namespace: 'foo/bar' })).toThrow(BootstrapConfigError);
  });

  it('rejects architectureNamespace equal to namespace', () => {
    expect(() => bootstrap({ namespace: 'shared', architectureNamespace: 'shared' })).toThrow(
      BootstrapConfigError
    );
  });

  it('rejects non-positive compactRetention', () => {
    expect(() => bootstrap({ compactRetention: 0 })).toThrow(BootstrapConfigError);
    expect(() => bootstrap({ compactRetention: -3 })).toThrow(BootstrapConfigError);
  });

  it('rejects non-integer compactRetention', () => {
    expect(() => bootstrap({ compactRetention: 7.5 })).toThrow(BootstrapConfigError);
  });

  it('rejects unknown top-level keys (typo guard via .strict())', () => {
    expect(() => bootstrap({ namespacee: 'typo' })).toThrow(BootstrapConfigError);
  });
});

describe('bootstrap — auth posture', () => {
  it('defaults to reads/writes open, deletes identity-gated (v3.2.3 shipped behaviour)', () => {
    const parsed = CortextBootstrapConfigSchema.parse({});
    expect(parsed.auth).toEqual({ reads: 'open', writes: 'open', deletes: 'identity' });
  });

  it('accepts a partial auth object, defaulting the unspecified knobs', () => {
    const parsed = CortextBootstrapConfigSchema.parse({ auth: { writes: 'identity' } });
    expect(parsed.auth).toEqual({ reads: 'open', writes: 'identity', deletes: 'identity' });
  });

  it('contributes zero plugin policies when fully open', () => {
    const plugin = bootstrap({ auth: { reads: 'open', writes: 'open', deletes: 'open' } });
    expect(plugin.policies ?? []).toHaveLength(0);
  });

  it('contributes one composed plugin policy whenever any surface is gated', () => {
    const plugin = bootstrap({});
    expect(plugin.policies).toHaveLength(1);
  });

  it('rejects gated reads over open writes (non-monotonic posture)', () => {
    expect(() => bootstrap({ auth: { reads: 'identity', writes: 'open' } })).toThrow(
      BootstrapConfigError
    );
  });

  it('rejects gated writes over open deletes (non-monotonic posture)', () => {
    expect(() => bootstrap({ auth: { writes: 'identity', deletes: 'open' } })).toThrow(
      BootstrapConfigError
    );
  });

  it('rejects unknown posture values', () => {
    expect(() => bootstrap({ auth: { reads: 'yes' } })).toThrow(BootstrapConfigError);
  });

  it('rejects unknown auth keys (typo guard via .strict())', () => {
    expect(() => bootstrap({ auth: { read: 'open' } })).toThrow(BootstrapConfigError);
  });
});
