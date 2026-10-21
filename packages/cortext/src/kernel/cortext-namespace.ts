/**
 * The namespace the kernel invariants are scoped to.
 *
 * Every CHECK constraint and partial index this plugin installs carries a
 * `namespace = <literal>` predicate, so that a kernel-wide table
 * (`rows`) can hold rows for unrelated namespaces without inheriting
 * cortext's controlled vocabularies. That literal has to live in exactly one
 * place, because getting it wrong fails SILENTLY: a constraint scoped to a
 * namespace with no rows is not an error, it is a constraint that passes
 * trivially, and an index whose predicate no query can satisfy is not an
 * error either — it is a heap scan.
 *
 * Tests that seed rows under the namespace the migrations name cannot catch a
 * mismatch with the one production uses, so this constant is the one copy.
 *
 * THE CONFIGURABILITY GAP, and what is actually done about it.
 *
 * The coordinator's namespaces are operator-configurable, while
 * KernelMigrationContext exposes only `sql` and `metric` — a migration
 * cannot read config. So these constants track the DEFAULTS, and a deployment
 * that renames a namespace would get no kernel invariants at all.
 *
 * Parameterising the literals does not fix that. Migrations are recorded once
 * by `id` in migrations and `apply` runs only when the id is absent, so
 * a later rename can never retroactively re-scope objects already created. It
 * would produce correct FRESH installs and silently-wrong RENAMED ones, which
 * is worse than today because it reads as solved.
 *
 * The fix is reconciliation against the configured namespace. `onKernelReady`
 * carries a `sql` handle and plugin-attributed coordinator namespaces, so it
 * is possible, but it is opt-in (`./repair.ts`): a store that ran unscoped may
 * hold rows violating the vocabulary, so `ADD CONSTRAINT` can fail on exactly
 * the databases a repair exists for.
 *
 * So what ships is REPORTING, not reconciliation, in two places that answer
 * different questions: the kernel's `./invariant-audit.ts` reads the catalog
 * at boot (objects absent, misscoped, or NOT VALID), and the coordinator's
 * `onStart` compares the CONFIGURED namespaces against these constants. See
 * `packages/cortext/src/kernel-invariants.ts`.
 *
 * It warns rather than REFUSES. Per-cohort context stores are a designed
 * capability that `bootstrap-config.test.ts` exercises with `codex`, so the
 * override keeps working; only the silence goes.
 */

export const CORTEXT_NAMESPACE = 'cortext';

/**
 * The namespace the architecture-findings surface registers under, and which
 * migration 0002 scopes its body normalization to.
 *
 * Separate from CORTEXT_NAMESPACE because the two have separate operator
 * knobs and diverging lifecycle policies (compaction, retention, audit) — but
 * subject to exactly the same gap, which is why it is stated here rather than
 * left as a bare literal inside 0002.
 */
export const ARCHITECTURE_NAMESPACE = 'architecture';

/**
 * The `name` the cortext COORDINATOR plugin registers itself under.
 *
 * Lives here, beside the namespace literals, because it is load-bearing for
 * exactly the same reason they are. The kernel resolves
 * which namespace to target by filtering
 * `KernelLifecycleContext.coordinatorNamespacesByPlugin` on
 * `plugin === CORTEXT_COORDINATOR_NAME` — so if the coordinator is ever
 * renamed and this literal is not, the filter matches nothing and the audit
 * reports "cortext declares no namespace" on a perfectly healthy deployment.
 *
 * A predicate that silently matches nothing is not an error, and a confidently wrong answer is
 * worse here than no answer, because "coordinator absent" reads as a real
 * finding rather than as a broken check.
 *
 * `kernel-namespace-parity.test.ts` asserts the coordinator's actual
 * `plugin.name` equals this. Do not inline the string on either side.
 */
export const CORTEXT_COORDINATOR_NAME = 'cortext';

/**
 * Body keys cortext's namespaces mirror into `rows` columns, so the
 * cold-start and status filters hit an index. `0001_baseline` creates them.
 */
export const CORTEXT_PROMOTED_COLUMNS = {
  archived: { column: 'archived', kind: 'boolean' },
  project: { column: 'project', kind: 'text' },
  status: { column: 'status', kind: 'text' },
  priority: { column: 'priority', kind: 'text' }
} as const;
