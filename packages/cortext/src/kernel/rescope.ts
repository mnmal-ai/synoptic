/**
 * The re-scoping primitives, parameterised by target namespace.
 *
 * The baseline migration calls these with `CORTEXT_NAMESPACE`; the opt-in
 * repair path (`./repair.ts`) calls them with the namespace the coordinator is
 * actually configured for.
 *
 * One copy is the point. A repair path that re-declared
 * this DDL would be a SECOND source of truth for what these objects are, and
 * the two would drift the moment a vocabulary changed — reinstalling the exact
 * class of bug that the repair exists to fix, one layer up. The
 * vocabularies themselves come from the kernel vocab constants rather than
 * being restated here, for the same reason.
 *
 * Everything here is idempotent DROP-then-CREATE. None of it decides POLICY:
 * whether a duplicate kid should abort the migration or be skipped
 * and reported (repair's) is the caller's call, which is why the duplicate
 * count is exposed separately rather than being handled in here.
 */

import type postgres from 'postgres';
import {
  AGENT_MESSAGE_STATUS_VOCAB,
  TODO_LIFECYCLE_VOCAB,
  TODO_PRIORITY_VOCAB
} from './todo-vocab.js';

type Sql = ReturnType<typeof postgres>;
type Metric = (name: string, payload?: unknown) => void;

const literal = (vocab: readonly string[]): string => vocab.map((v) => `'${v}'`).join(',');

export interface VocabConstraint {
  readonly constraint: string;
  readonly type: string;
  readonly column: 'status' | 'priority';
  readonly vocab: readonly string[];
}

export const VOCAB_CONSTRAINTS: readonly VocabConstraint[] = [
  {
    constraint: 'rows_todo_priority_check',
    type: 'Todo',
    column: 'priority',
    vocab: TODO_PRIORITY_VOCAB
  },
  {
    constraint: 'rows_todo_status_check',
    type: 'Todo',
    column: 'status',
    // `done` / `not_started` are aliases the schema canonicalises.
    vocab: TODO_LIFECYCLE_VOCAB
  },
  {
    constraint: 'rows_agent_message_status_check',
    type: 'AgentMessage',
    column: 'status',
    vocab: AGENT_MESSAGE_STATUS_VOCAB
  }
];

/**
 * Re-scope one vocabulary CHECK to `namespace`.
 *
 * Returns the number of existing rows that violate it — 0 means VALIDATE
 * succeeded and the constraint is fully enforced; >0 means it was left NOT
 * VALID (enforcing new writes only) and an operator has rows to reconcile.
 *
 * The NOT VALID -> validate-inside-a-handler shape is what makes this safe to
 * run against a store that has been writing UNCONSTRAINED. A plain
 * `ADD CONSTRAINT ... CHECK` validates immediately and therefore fails on
 * exactly the databases a repair exists for — the ones that drifted long
 * enough to accumulate bad rows.
 */
export async function rescopeVocabConstraint(
  s: Sql,
  metric: Metric,
  { constraint, type, column, vocab }: VocabConstraint,
  namespace: string
): Promise<number> {
  const values = literal(vocab);

  // Count first: VALIDATE reports only the first offending row, which is not
  // enough for an operator to size the problem. Counted before the ADD so the
  // number describes the corpus, not what survived a partial write.
  const [violation] = await s.unsafe(`
    SELECT count(*)::int AS count FROM rows
     WHERE namespace = '${namespace}'
       AND type = '${type}'
       AND ${column} IS NOT NULL
       AND ${column} NOT IN (${values})
  `);
  const violations = (violation as unknown as { count: number } | undefined)?.count ?? 0;

  await s.unsafe(`ALTER TABLE rows DROP CONSTRAINT IF EXISTS ${constraint}`);
  await s.unsafe(`
    ALTER TABLE rows
      ADD CONSTRAINT ${constraint}
        CHECK (
          NOT (namespace = '${namespace}' AND type = '${type}')
          OR ${column} IS NULL
          OR ${column} IN (${values})
        ) NOT VALID
  `);

  // Guarded on convalidated so a half-applied re-run completes rather than
  // erroring, and wrapped so pre-existing bad rows downgrade this to
  // "enforced for new writes" instead of aborting.
  await s.unsafe(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = '${constraint}'
          AND conrelid = 'rows'::regclass AND NOT convalidated
      ) THEN
        BEGIN
          ALTER TABLE rows VALIDATE CONSTRAINT ${constraint};
        EXCEPTION WHEN check_violation THEN
          RAISE WARNING 'cortext-kernel: % left NOT VALID — existing rows violate it; new writes are still enforced', '${constraint}';
        END;
      END IF;
    END $$
  `);

  if (violations > 0) {
    metric('cortext_kernel.rescope.constraint_not_validated', {
      constraint,
      type,
      column,
      namespace,
      violations
    });
  }
  return violations;
}

/**
 * How many kids would collide if the unique index were scoped to `namespace`.
 *
 * Exposed separately because a UNIQUE index has no `NOT VALID` equivalent —
 * there is no "enforce for new writes only" state for an index. `CREATE UNIQUE
 * INDEX` either succeeds over the whole predicate or fails outright, so the
 * only way to avoid failing is to ask first. That asymmetry with the CHECK
 * constraints is why repair treats the two differently.
 *
 * The predicate matches `rescopeKidUniqueIndex`'s exactly, including the
 * tombstone exemption — an archived duplicate is still a conflict, and hard-
 * deleting a retired identity frees its kid.
 */
export async function countDuplicateKids(s: Sql, namespace: string): Promise<number> {
  const [row] = await s.unsafe(`
    SELECT count(*)::int AS count FROM (
      SELECT body->>'kid' AS kid
        FROM rows
       WHERE namespace = '${namespace}'
         AND type = 'AgentIdentity'
         AND deleted_at IS NULL
       GROUP BY body->>'kid'
      HAVING count(*) > 1
    ) dupes
  `);
  return (row as unknown as { count: number } | undefined)?.count ?? 0;
}

/**
 * Re-scope the AgentIdentity.kid unique index (0004) to `namespace`.
 *
 * THROWS on duplicate kids, and that is deliberate — it preserves 0004's
 * fail-loud stance, because recipient resolution and the mailbox's
 * recipient-only enforcement are both ambiguous until an operator decides
 * which row owns the identity. Callers that must not abort should call
 * `countDuplicateKids` first; the repair path does.
 */
export async function rescopeKidUniqueIndex(s: Sql, namespace: string): Promise<void> {
  await s.unsafe('DROP INDEX IF EXISTS rows_agent_identity_kid_unique');
  await s.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS rows_agent_identity_kid_unique
      ON rows ((body->>'kid'))
      WHERE namespace = '${namespace}'
        AND type = 'AgentIdentity'
        AND deleted_at IS NULL
  `);
}

/**
 * How many HostInstall keys would collide if the unique index were scoped to
 * `namespace`. Asked first for the same reason as `countDuplicateKids`.
 */
export async function countDuplicateHostInstallKeys(s: Sql, namespace: string): Promise<number> {
  const [row] = await s.unsafe(`
    SELECT count(*)::int AS count FROM (
      SELECT body->>'key' AS key
        FROM rows
       WHERE namespace = '${namespace}'
         AND type = 'HostInstall'
         AND deleted_at IS NULL
       GROUP BY body->>'key'
      HAVING count(*) > 1
    ) dupes
  `);
  return (row as unknown as { count: number } | undefined)?.count ?? 0;
}

/**
 * Re-scope the HostInstall.key unique index (0008) to `namespace`. Throws on
 * duplicate keys; callers that must not abort call
 * `countDuplicateHostInstallKeys` first.
 */
export async function rescopeHostInstallKeyIndex(s: Sql, namespace: string): Promise<void> {
  await s.unsafe('DROP INDEX IF EXISTS rows_host_install_key_unique');
  await s.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS rows_host_install_key_unique
      ON rows ((body->>'key'))
      WHERE namespace = '${namespace}'
        AND type = 'HostInstall'
        AND deleted_at IS NULL
  `);
}
