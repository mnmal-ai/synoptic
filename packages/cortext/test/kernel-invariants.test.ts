/**
 * The coordinator must say so when the kernel cannot follow a configured
 * namespace.
 *
 * Kernel invariants scoped to a namespace nothing writes to are not an
 * error, they are a no-op. Writes succeed, queries answer, the suite stays
 * green, and AgentIdentity.kid uniqueness — which the mailbox's recipient-only
 * trust model rests on — quietly is not held.
 *
 * So the assertion that matters is not "a warning function exists" but
 * "configuring a namespace the kernel does not cover produces a signal, and
 * configuring one it does cover produces silence." Both directions, because a
 * reporter that fires always is as useless as one that never fires.
 */

import { describe, expect, it } from 'vitest';
import { CortextBootstrapConfigSchema } from '../src/bootstrap.js';
import { createCortextPlugin } from '../src/index.js';
import { ARCHITECTURE_NAMESPACE, CORTEXT_NAMESPACE } from '../src/kernel/index.js';
import {
  reportUncoveredNamespaces,
  uncoveredNamespaceMessage,
  uncoveredNamespaces
} from '../src/kernel-invariants.js';

const covered = { namespace: CORTEXT_NAMESPACE, architectureNamespace: ARCHITECTURE_NAMESPACE };

describe('uncoveredNamespaces', () => {
  it('reports nothing for the namespaces the kernel scopes to', () => {
    expect(uncoveredNamespaces(covered)).toEqual([]);
  });

  it('reports a renamed context-store namespace', () => {
    expect(uncoveredNamespaces({ ...covered, namespace: 'codex' })).toEqual([
      { field: 'namespace', configured: 'codex', scopedTo: CORTEXT_NAMESPACE }
    ]);
  });

  it('reports a renamed architecture namespace', () => {
    // The baseline scopes `architecture` by the identical mechanism and
    // carries the identical gap.
    expect(uncoveredNamespaces({ ...covered, architectureNamespace: 'findings' })).toEqual([
      { field: 'architectureNamespace', configured: 'findings', scopedTo: ARCHITECTURE_NAMESPACE }
    ]);
  });

  it('reports both when both are renamed', () => {
    expect(
      uncoveredNamespaces({ namespace: 'codex', architectureNamespace: 'findings' })
    ).toHaveLength(2);
  });

  it('the default parsed config is covered — the shipped path is silent', () => {
    // Ties the reporter to the real schema rather than to a hand-written
    // literal, so a change to either default surfaces here.
    const defaults = CortextBootstrapConfigSchema.parse({});
    expect(uncoveredNamespaces(defaults)).toEqual([]);
  });
});

describe('uncoveredNamespaceMessage', () => {
  it('names the specific guarantees that are lost, not just "invariants"', () => {
    // An operator reading a log line needs to know what stopped being true.
    // "kernel invariants inactive" is not actionable; "kid uniqueness is
    // not held" is.
    const [entry] = uncoveredNamespaces({ ...covered, namespace: 'codex' });
    const message = uncoveredNamespaceMessage(entry as never);
    expect(message).toContain('codex');
    expect(message).toContain(CORTEXT_NAMESPACE);
    expect(message).toMatch(/kid uniqueness is NOT held/);
    expect(message).toMatch(/nothing else will report this/);
  });
});

describe('reportUncoveredNamespaces', () => {
  it('emits on both sinks, once per uncovered namespace', () => {
    const metrics: { name: string; payload?: unknown }[] = [];
    const warnings: string[] = [];
    const reported = reportUncoveredNamespaces(
      { namespace: 'codex', architectureNamespace: 'findings' },
      (name, payload) => metrics.push({ name, payload }),
      (m) => warnings.push(m)
    );

    expect(reported).toHaveLength(2);
    expect(warnings).toHaveLength(2);
    expect(metrics.map((m) => m.name)).toEqual([
      'cortext.kernel_invariants_inactive',
      'cortext.kernel_invariants_inactive'
    ]);
    expect(metrics[0]?.payload).toMatchObject({ field: 'namespace', configured: 'codex' });
  });

  it('stays completely silent when every namespace is covered', () => {
    const metrics: string[] = [];
    const warnings: string[] = [];
    const reported = reportUncoveredNamespaces(
      covered,
      (name) => metrics.push(name),
      (m) => warnings.push(m)
    );
    expect(reported).toEqual([]);
    expect(metrics).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('plugin wiring', () => {
  function startPlugin(cfg: { namespace: string; architectureNamespace: string }): string[] {
    const parsed = CortextBootstrapConfigSchema.parse(cfg);
    const plugin = createCortextPlugin({ ...parsed, autoCompactIntervalMs: undefined });
    const metrics: string[] = [];
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      plugin.onStart?.({
        lifecycle: 'coordinator',
        metric: (name: string) => metrics.push(name),
        engine: {} as never
      } as never);
    } finally {
      console.warn = originalWarn;
    }
    return metrics;
  }

  it('onStart reports through the host metric sink for a renamed namespace', () => {
    // The point of wiring it to onStart rather than to config parsing: this is
    // the seam that actually fires inside the running binary, so the line
    // lands in the journal next to substrate's own loader warnings.
    expect(
      startPlugin({ namespace: 'codex', architectureNamespace: ARCHITECTURE_NAMESPACE })
    ).toEqual(['cortext.kernel_invariants_inactive']);
  });

  it('onStart is silent on the default configuration', () => {
    expect(startPlugin(covered)).toEqual([]);
  });

  it('namespace overrides still WORK — this is a warning, not a refusal', () => {
    // Guards the decision, not just the code. Pinning these fields would make
    // this a config-parse error, withdrawing a capability that
    // `bootstrap-config.test.ts` exercises with `codex`. If someone reaches
    // for the pin, this fails and makes them argue for it.
    const parsed = CortextBootstrapConfigSchema.parse({
      namespace: 'codex',
      architectureNamespace: 'findings'
    });
    const plugin = createCortextPlugin({ ...parsed, autoCompactIntervalMs: undefined });
    expect(plugin.namespaces?.map((n) => n.namespace).sort()).toEqual(['codex', 'findings']);
  });
});
