/**
 * Unit + parity coverage for the boot-time invariant audit.
 *
 * The catalog-reading half lives in `invariant-audit.pg.test.ts`, which runs
 * against a real postgres. This file covers everything that does not need one,
 * plus the parity guard that keeps `INVARIANT_OBJECTS` honest.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CORTEXT_COORDINATOR_NAME, CORTEXT_NAMESPACE } from '../../src/kernel/cortext-namespace.js';
import {
  auditNamespaceCoverage,
  type Finding,
  findingMessage,
  INVARIANT_OBJECTS,
  reportInvariantAudit,
  resolveCortextNamespaces,
  scopedNamespace
} from '../../src/kernel/invariant-audit.js';
import { createCortextKernelPlugin } from '../../src/kernel/plugin.js';
import { VOCAB_CONSTRAINTS } from '../../src/kernel/rescope.js';

describe('namespace coverage', () => {
  it('is silent when a coordinator declares our scope literal', () => {
    expect(auditNamespaceCoverage([CORTEXT_NAMESPACE, 'architecture'])).toEqual([]);
  });

  it('reports when it does not, and preserves what WAS declared', () => {
    // The declared list is the operator's only clue about which namespace
    // replaced ours when the host cannot attribute — so it has to survive into
    // the message rather than being reduced to a boolean.
    const declared = ['codex', 'architecture', 'perf', 'review'];
    const findings = auditNamespaceCoverage(declared);
    expect(findings).toEqual([
      {
        kind: 'namespace_uncovered',
        scopedTo: CORTEXT_NAMESPACE,
        declared,
        reason: 'host_does_not_attribute'
      }
    ]);
    expect(findingMessage(findings[0] as Finding)).toContain('codex');
  });

  it('reports against an empty list rather than treating it as healthy', () => {
    // Empty is indistinguishable from "no coordinators configured", and the
    // no-op reading is the dangerous one: it would look like correct silence.
    expect(auditNamespaceCoverage([])).toHaveLength(1);
    expect(findingMessage(auditNamespaceCoverage([])[0] as Finding)).toContain('none');
  });
});

describe('targeting via coordinatorNamespacesByPlugin', () => {
  /**
   * The host's field is OPTIONAL and deliberately not defaulted to `[]`,
   * because that would make "this host cannot answer" read identically to
   * "answered: no coordinators". These tests hold that distinction on our
   * side of the boundary.
   */
  it('undefined means UNKNOWN, not none', () => {
    expect(resolveCortextNamespaces(undefined)).toBeNull();
  });

  it('an empty list means attributed-and-absent, which is a different answer', () => {
    expect(resolveCortextNamespaces([])).toEqual([]);
  });

  it('the two produce DIFFERENT findings on the same drifted deployment', () => {
    const declared = ['codex', 'architecture'];
    const [old] = auditNamespaceCoverage(declared, undefined) as [
      Extract<Finding, { kind: 'namespace_uncovered' }>
    ];
    const [attributed] = auditNamespaceCoverage(declared, []) as [
      Extract<Finding, { kind: 'namespace_uncovered' }>
    ];
    expect(old.reason).toBe('host_does_not_attribute');
    expect(attributed.reason).toBe('coordinator_absent');
    // And they must not read the same to an operator — one says "upgrade the
    // binary to learn the target", the other says "the coordinator is missing".
    expect(findingMessage(old)).not.toBe(findingMessage(attributed));
    expect(findingMessage(old)).toContain('5.1.0');
    expect(findingMessage(attributed)).toContain('not loaded');
  });

  it('names the configured namespace when the host attributes it', () => {
    const findings = auditNamespaceCoverage(
      ['codex', 'architecture', 'perf'],
      [
        { plugin: 'perf-plugin', namespace: 'perf' },
        { plugin: CORTEXT_COORDINATOR_NAME, namespace: 'codex' },
        { plugin: CORTEXT_COORDINATOR_NAME, namespace: 'architecture' }
      ]
    );
    expect(findings).toEqual([
      { kind: 'namespace_drifted', scopedTo: CORTEXT_NAMESPACE, configured: 'codex' }
    ]);
    // Both sides named — the difference between a finding you can act on and
    // one you have to investigate.
    const message = findingMessage(findings[0] as Finding);
    expect(message).toContain("'codex'");
    expect(message).toContain(`'${CORTEXT_NAMESPACE}'`);
  });

  it('takes the FIRST cortext namespace — the context store, not architecture', () => {
    // Declaration order is contractual: the coordinator builds
    // `namespaces: [claude, architecture]`, and only the first carries catalog
    // objects. Taking the wrong one would name a target that has no invariants.
    expect(
      resolveCortextNamespaces([
        { plugin: CORTEXT_COORDINATOR_NAME, namespace: 'codex' },
        { plugin: CORTEXT_COORDINATOR_NAME, namespace: 'architecture' }
      ])?.[0]
    ).toBe('codex');
  });

  it('ignores namespaces contributed by OTHER coordinators', () => {
    // The whole reason the flat list was insufficient: on the live deployment
    // it reads cortext, architecture, perf, plane, _system_proposals, review —
    // and a rename puts the new name in there with nothing to distinguish it.
    expect(
      resolveCortextNamespaces([
        { plugin: 'substrate-perf-plugin', namespace: 'perf' },
        { plugin: 'substrate-review-plugin', namespace: 'review' }
      ])
    ).toEqual([]);
  });

  it('stays silent when the coordinator uses our literal, attribution or not', () => {
    const healthy = [{ plugin: CORTEXT_COORDINATOR_NAME, namespace: CORTEXT_NAMESPACE }];
    expect(auditNamespaceCoverage([CORTEXT_NAMESPACE], healthy)).toEqual([]);
    expect(auditNamespaceCoverage([CORTEXT_NAMESPACE], undefined)).toEqual([]);
  });
});

describe('scopedNamespace', () => {
  it('reads the namespace out of both rendering forms pg uses', () => {
    expect(scopedNamespace("CHECK ((NOT ((namespace = 'cortext'::text) AND ...)))")).toBe(
      'cortext'
    );
    expect(scopedNamespace("... WHERE (namespace = 'cortext')")).toBe('cortext');
  });

  it('returns null when the predicate names no namespace', () => {
    expect(scopedNamespace('CHECK ((status IS NOT NULL))')).toBeNull();
  });

  it('does not match a namespace that is merely a PREFIX of ours', () => {
    // The reason this captures rather than testing `includes('cortext')`:
    // a substring test cannot tell 'cortex' from 'cortext', and would have
    // reported a correctly-scoped object as drifted (or worse, the reverse).
    expect(scopedNamespace("CHECK ((namespace = 'cortex'::text))")).toBe('cortex');
    expect(scopedNamespace("CHECK ((namespace = 'cortex'::text))")).not.toBe(CORTEXT_NAMESPACE);
  });
});

describe('INVARIANT_OBJECTS parity with the migrations', () => {
  /**
   * The guard the docstring promises. `INVARIANT_OBJECTS` is hand-written —
   * a migration's `apply` is opaque SQL text, so a "derived" list would be a
   * regex agreeing with reality by luck — which means the two can drift.
   *
   * A new migration installing a sixth object and forgetting to list it here
   * is the silent shape: the object exists, nothing audits it, and its
   * absence later is invisible.
   */
  // The invariants are installed by the `rescope*` helpers the baseline calls:
  // the vocabulary CHECKs by name from VOCAB_CONSTRAINTS, the indexes as SQL.
  const rescopeSource = readFileSync(
    fileURLToPath(new URL('../../src/kernel/rescope.ts', import.meta.url)),
    'utf8'
  );

  const installed = new Set([
    ...VOCAB_CONSTRAINTS.map((c) => c.constraint),
    ...[...rescopeSource.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (rows_[a-z_]+)/g)].map(
      (m) => m[1]
    )
  ]);

  it('finds objects to compare against (guards the scanner itself)', () => {
    // Without this a scanner that silently matched nothing makes the next test
    // vacuously green — a check whose pass condition is an absence.
    expect(installed.size).toBeGreaterThan(0);
  });

  it('audits exactly the objects the migrations install', () => {
    expect([...installed].sort()).toEqual(INVARIANT_OBJECTS.map((o) => o.name).sort());
  });

  it('names a real migration file for each object', () => {
    const files = new Set(
      readdirSync(fileURLToPath(new URL('../../src/kernel/migrations', import.meta.url))).map((f) =>
        f.replace(/\.ts$/, '')
      )
    );
    for (const object of INVARIANT_OBJECTS) {
      expect(files.has(object.migration), `${object.name} -> ${object.migration}`).toBe(true);
    }
  });
});

describe('reportInvariantAudit', () => {
  it('emits to both sinks and returns what it reported', () => {
    const metric = vi.fn();
    const warn = vi.fn();
    return reportInvariantAudit({ sql: null, coordinatorNamespaces: ['codex'], metric }, warn).then(
      (findings) => {
        expect(findings).toHaveLength(1);
        expect(metric).toHaveBeenCalledWith(
          'cortext_kernel.invariant_inactive',
          expect.objectContaining({ finding: 'namespace_uncovered' })
        );
        expect(warn).toHaveBeenCalledOnce();
      }
    );
  });

  it('proves it RAN even when it finds nothing', async () => {
    // Every other metric names a failure, so without this a clean audit and
    // an audit that never ran are the same observation. Silence must mean
    // "did not run" — otherwise the check's
    // pass state is indistinguishable from its absence, which is the exact
    // property the pg suite's decoy prerequisite exists to establish.
    const metric = vi.fn();
    const warn = vi.fn();
    await reportInvariantAudit(
      { sql: null, coordinatorNamespaces: [CORTEXT_NAMESPACE], metric },
      warn
    );
    expect(metric).toHaveBeenCalledWith(
      'cortext_kernel.invariant_audit_complete',
      expect.objectContaining({ findings: 0, catalogRead: false })
    );
    expect(warn, 'a per-boot success line on every deployment is noise').not.toHaveBeenCalled();
  });

  it('emits completion ALONGSIDE findings, not instead of them', () => {
    // "The audit ran" and "the audit found something" are separate facts.
    // Emitting completion only on the clean path would leave the same ambiguity
    // for any boot that had findings.
    const metric = vi.fn();
    return reportInvariantAudit(
      { sql: null, coordinatorNamespaces: ['codex'], metric },
      vi.fn()
    ).then(() => {
      const names = metric.mock.calls.map((c) => c[0]);
      expect(names).toContain('cortext_kernel.invariant_inactive');
      expect(names).toContain('cortext_kernel.invariant_audit_complete');
    });
  });

  it('does NOT claim completion when the catalog read failed', async () => {
    // The one path where silence is correct: the audit failed, that is already
    // reported, and claiming completion would assert a check it did not finish.
    const metric = vi.fn();
    await reportInvariantAudit(
      {
        sql: { unsafe: () => Promise.reject(new Error('nope')) },
        coordinatorNamespaces: [CORTEXT_NAMESPACE],
        metric
      },
      vi.fn()
    );
    const names = metric.mock.calls.map((c) => c[0]);
    expect(names).toContain('cortext_kernel.invariant_audit_failed');
    expect(names).not.toContain('cortext_kernel.invariant_audit_complete');
  });

  it('skips the catalog half when sql is null rather than throwing', async () => {
    // null is the in-memory dataset, which is a supported configuration.
    const findings = await reportInvariantAudit(
      { sql: null, coordinatorNamespaces: [CORTEXT_NAMESPACE], metric: vi.fn() },
      vi.fn()
    );
    expect(findings).toEqual([]);
  });

  it('reports a failing catalog read as unknown state, and does not throw', async () => {
    // A kernel plugin that aborts the boot over an OBSERVATION would take
    // the service down for a condition it has been running with for weeks.
    const metric = vi.fn();
    const warn = vi.fn();
    const sql = (): Promise<never> => Promise.reject(new Error('permission denied'));
    await expect(
      reportInvariantAudit({ sql, coordinatorNamespaces: [CORTEXT_NAMESPACE], metric }, warn)
    ).resolves.toEqual([]);
    expect(metric).toHaveBeenCalledWith(
      'cortext_kernel.invariant_audit_failed',
      expect.objectContaining({ error: 'permission denied' })
    );
    expect(warn.mock.calls[0]?.[0]).toContain('NOT the invariants');
  });
});

describe('plugin wiring', () => {
  it('registers the audit as onKernelReady', () => {
    expect(createCortextKernelPlugin().onKernelReady).toBeTypeOf('function');
  });

  it('survives a lifecycle context with no sql, as the memory dataset supplies', async () => {
    const plugin = createCortextKernelPlugin();
    await expect(
      plugin.onKernelReady?.({
        lifecycle: 'kernel',
        sql: null,
        coordinatorNamespaces: [CORTEXT_NAMESPACE],
        metric: vi.fn()
      })
    ).resolves.toBeUndefined();
  });
});

describe('the completion tally is measured, not promised', () => {
  it('emits NO completion metric when the catalog read threw', () => {
    // The catch returns early, so `complete` is unreachable on the throw path.
    // The absence of this metric is load-bearing: "the audit ran" and "the
    // audit failed" are separate facts, and emitting a completion beside a
    // failure would conflate them.
    const metric = vi.fn();
    const sql = (): Promise<never> => Promise.reject(new Error('permission denied'));
    return reportInvariantAudit(
      { sql, coordinatorNamespaces: [CORTEXT_NAMESPACE], metric },
      vi.fn()
    ).then(() => {
      const names = metric.mock.calls.map((c) => c[0]);
      expect(names).toContain('cortext_kernel.invariant_audit_failed');
      expect(names).not.toContain('cortext_kernel.invariant_audit_complete');
    });
  });

  it('reports checked: 0 with catalogRead false when there is no sql handle', () => {
    // The in-memory dataset — a supported configuration, not a fault. The two
    // zeroes must stay distinguishable: catalogRead separates "no catalog to
    // read" from "read it and inspected nothing".
    const metric = vi.fn();
    return reportInvariantAudit(
      { sql: null, coordinatorNamespaces: [CORTEXT_NAMESPACE], metric },
      vi.fn()
    ).then(() => {
      const complete = metric.mock.calls.find(
        (c) => c[0] === 'cortext_kernel.invariant_audit_complete'
      );
      expect(complete?.[1]).toMatchObject({ checked: 0, catalogRead: false });
    });
  });
});

describe('after a repair to a renamed namespace', () => {
  // A catalog where every object exists, valid, scoped to `ns`.
  const catalogScopedTo =
    (ns: string) =>
    (strings: TemplateStringsArray): Promise<unknown> => {
      const q = strings.join('?');
      if (q.includes('to_regclass')) return Promise.resolve([{ ok: true }]);
      return Promise.resolve(
        INVARIANT_OBJECTS.map((o) => ({
          name: o.name,
          definition: `CHECK ((namespace = '${ns}'::text))`,
          validated: true
        }))
      );
    };
  const byPlugin = [{ plugin: CORTEXT_COORDINATOR_NAME, namespace: 'codex' }];

  it('is clean once every object is scoped to the configured namespace', async () => {
    const findings = await reportInvariantAudit(
      {
        sql: catalogScopedTo('codex'),
        coordinatorNamespaces: ['codex'],
        coordinatorNamespacesByPlugin: byPlugin,
        metric: vi.fn()
      },
      vi.fn()
    );
    expect(findings).toEqual([]);
  });

  it('still reports drift, and names the configured namespace, before the repair', async () => {
    const findings = await reportInvariantAudit(
      {
        sql: catalogScopedTo(CORTEXT_NAMESPACE),
        coordinatorNamespaces: ['codex'],
        coordinatorNamespacesByPlugin: byPlugin,
        metric: vi.fn()
      },
      vi.fn()
    );
    expect(findings[0]).toMatchObject({ kind: 'namespace_drifted', configured: 'codex' });
    expect(findings.filter((f) => f.kind === 'object_misscoped')).toHaveLength(
      INVARIANT_OBJECTS.length
    );
    expect(findingMessage(findings[1] as Finding)).toContain("not 'codex'");
  });
});
