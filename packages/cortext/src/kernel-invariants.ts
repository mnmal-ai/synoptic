/**
 * Boot-time reporting for the namespaces the kernel cannot follow.
 *
 * The cortext kernel plugin scopes every CHECK constraint and partial index
 * with a `namespace = <literal>` predicate, baked in at authoring time because
 * a migration cannot read config (`KernelMigrationContext` is `{ sql, metric }`).
 * So a deployment that renames a namespace gets NO invariants, silently: a
 * constraint scoped to a namespace with no rows passes trivially, and an index
 * whose predicate no query can satisfy is just a heap scan.
 *
 * This warns rather than refuses. Per-cohort context stores are a designed
 * capability (`bootstrap-config.test.ts` names `codex` as an override target),
 * so the knob keeps working and the consequence is stated at boot.
 *
 * The kernel's own `invariant-audit.ts` reads the catalog too, but answers a
 * different question. HERE (coordinator): "the namespace I am CONFIGURED for
 * is not the one the kernel scopes to"; only the coordinator knows
 * `cfg.namespace`. THERE (kernel): "my scope literal is declared by no
 * coordinator", plus objects dropped, left NOT VALID, or re-scoped.
 *
 * Neither re-scopes automatically; that is the opt-in `./repair.ts`, because a
 * store that ran unscoped may hold rows violating the vocabulary, so
 * `ADD CONSTRAINT` can fail on exactly the databases a repair exists for.
 * Parameterising the literals alone would not help either: migrations are
 * recorded once by `id`, so a later rename never re-scopes existing objects.
 */

import { ARCHITECTURE_NAMESPACE, CORTEXT_NAMESPACE } from './kernel/index.js';

/** One configured namespace the kernel's baked-in literals do not cover. */
export interface UncoveredNamespace {
  /** Config key the operator set. */
  readonly field: 'namespace' | 'architectureNamespace';
  /** What they set it to. */
  readonly configured: string;
  /** The literal the kernel actually scopes its invariants to. */
  readonly scopedTo: string;
}

/**
 * Which configured namespaces the kernel does not cover. Empty is the
 * healthy case.
 *
 * Pure and separately exported so the condition can be tested directly rather
 * than through a lifecycle harness — the reporting below is a thin shell over
 * it.
 */
export function uncoveredNamespaces(cfg: {
  namespace: string;
  architectureNamespace: string;
}): UncoveredNamespace[] {
  const checks = [
    { field: 'namespace', configured: cfg.namespace, scopedTo: CORTEXT_NAMESPACE },
    {
      field: 'architectureNamespace',
      configured: cfg.architectureNamespace,
      scopedTo: ARCHITECTURE_NAMESPACE
    }
  ] as const;
  return checks.filter((c) => c.configured !== c.scopedTo);
}

/** The operator-facing sentence for one uncovered namespace. */
export function uncoveredNamespaceMessage({
  field,
  configured,
  scopedTo
}: UncoveredNamespace): string {
  return (
    `[cortext] ${field} is '${configured}', but the cortext kernel scopes its constraints ` +
    `and indexes to '${scopedTo}'. Every kernel invariant for '${configured}' is therefore ` +
    `INACTIVE — Todo/AgentMessage vocabularies are unenforced, the mailbox inbox index covers ` +
    `no rows, and AgentIdentity.kid uniqueness is NOT held. Writes succeed and queries answer, ` +
    `so nothing else will report this. Use '${scopedTo}', or accept the loss deliberately.`
  );
}

/**
 * Emit the warnings at plugin start. Returns what it reported, so a caller (or
 * a test) can assert on it without capturing the console.
 *
 * Both sinks on purpose: `metric` is the
 * structured channel an operator can alert on, and the console line is what
 * actually appears in the server journal next to substrate's own loader
 * warnings, where someone will see it.
 */
export function reportUncoveredNamespaces(
  cfg: { namespace: string; architectureNamespace: string },
  metric: (name: string, payload?: unknown) => void,
  warn: (message: string) => void = console.warn
): UncoveredNamespace[] {
  const uncovered = uncoveredNamespaces(cfg);
  for (const entry of uncovered) {
    metric('cortext.kernel_invariants_inactive', { ...entry });
    warn(uncoveredNamespaceMessage(entry));
  }
  return uncovered;
}
