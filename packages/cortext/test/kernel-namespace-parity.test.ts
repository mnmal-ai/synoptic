/**
 * Cross-package guard: the namespace this coordinator registers under must be
 * the one the kernel scopes its invariants to.
 *
 * The kernel installs every CHECK constraint and partial index with a
 * `namespace = <literal>` predicate, so rows can hold unrelated namespaces
 * without inheriting cortext's vocabularies. If the coordinator's namespace
 * moves and the kernel literals do not, nothing fails: a constraint scoped to
 * a namespace with no rows passes trivially, and an index no query can
 * satisfy is just a heap scan.
 *
 * The direction matters: the coordinator depends on the kernel (never the
 * reverse), so the assertion lives here and imports the constant, rather than
 * the kernel reaching up to find out who is using it.
 *
 * If this goes red, do NOT edit CORTEXT_NAMESPACE to match. The kernel
 * literal is baked into constraints and indexes on every deployed database,
 * and migrations are recorded once by id and never re-applied — so a rename
 * needs a new migration that re-scopes the existing objects (0006 is the
 * worked example), not a changed constant.
 */

import { describe, expect, it } from 'vitest';
import { CortextBootstrapConfigSchema } from '../src/bootstrap.js';
import { createCortextPlugin } from '../src/index.js';
import {
  ARCHITECTURE_NAMESPACE,
  CORTEXT_COORDINATOR_NAME,
  CORTEXT_NAMESPACE
} from '../src/kernel/index.js';

describe('kernel namespace parity', () => {
  it('the coordinator default namespace matches the kernel scope literal', () => {
    const defaults = CortextBootstrapConfigSchema.parse({});
    expect(defaults.namespace).toBe(CORTEXT_NAMESPACE);
  });

  it('a plugin built from default config registers that namespace', () => {
    // Through the real factory rather than the schema alone: buildClaudeNamespace
    // echoes whatever name it is handed, so the only assertion worth making is
    // that the default config actually reaches it.
    const defaults = CortextBootstrapConfigSchema.parse({});
    const plugin = createCortextPlugin({ ...defaults, autoCompactIntervalMs: undefined });
    expect(plugin.namespaces?.map((n) => n.namespace)).toContain(CORTEXT_NAMESPACE);
  });

  it('the architecture namespace matches its kernel scope literal too', () => {
    // The baseline scopes to `architecture` by the identical mechanism and
    // carries the identical drift risk.
    const defaults = CortextBootstrapConfigSchema.parse({});
    expect(defaults.architectureNamespace).toBe(ARCHITECTURE_NAMESPACE);

    const plugin = createCortextPlugin({ ...defaults, autoCompactIntervalMs: undefined });
    expect(plugin.namespaces?.map((n) => n.namespace)).toContain(ARCHITECTURE_NAMESPACE);
  });

  it('the coordinator registers under the name the kernel targets by', () => {
    // The kernel resolves its target namespace by filtering
    // `coordinatorNamespacesByPlugin` on `plugin === CORTEXT_COORDINATOR_NAME`.
    // A rename of the coordinator that this constant does not follow makes that
    // filter match nothing — and the audit would then report "the cortext
    // coordinator declared no namespace at all", confidently, about a healthy
    // deployment.
    //
    // "Cannot determine the target" is an honest non-answer, whereas
    // "coordinator absent" reads as a finding, so this field gets the same
    // parity guard the namespace literals have.
    const defaults = CortextBootstrapConfigSchema.parse({});
    const plugin = createCortextPlugin({ ...defaults, autoCompactIntervalMs: undefined });
    expect(plugin.name).toBe(CORTEXT_COORDINATOR_NAME);
  });

  it('the two scope literals are distinct', () => {
    // The cross-field "must differ" refinement in the bootstrap schema is
    // unreachable now that both fields are pinned, so this is where that
    // invariant is actually checked. Equal literals would collide every type
    // in one namespace.
    expect(CORTEXT_NAMESPACE).not.toBe(ARCHITECTURE_NAMESPACE);
  });

  it('the kernel scope literal is not the retired pre-relabel namespace', () => {
    // Belt and braces: the two assertions above compare the kernel against
    // the coordinator, so they would both still pass if BOTH regressed to
    // 'claude' together. `claude/*` resolves to unknown_namespace on the live
    // server, so no correct configuration can name it.
    expect(CORTEXT_NAMESPACE).not.toBe('claude');
  });
});
