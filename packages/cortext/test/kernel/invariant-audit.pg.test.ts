/**
 * Pg-gated coverage for the boot-time invariant audit.
 *
 * Runs the REAL migrations against a TEMP `rows`, then breaks each
 * invariant in turn — dropped, re-scoped, left NOT VALID — and asserts the
 * audit names it. Testing against the shipped migrations rather than
 * hand-built objects is the point: an audit that agrees with a fixture but not
 * with what the migrations actually install is worth nothing.
 *
 * ## The decoys, and why they are the load-bearing part
 *
 * Two objects with our exact names are created on OTHER relations before the
 * audit runs:
 *
 *   - a CHECK constraint named `rows_todo_status_check` on a second temp
 *     table (constraint names are unique per RELATION, so this is legal);
 *   - a unique index named `rows_agent_identity_kid_unique` in a separate
 *     schema (index names are unique per SCHEMA, so it cannot go in pg_temp).
 *
 * Both are deliberately given the WRONG scope, so a by-name lookup that read
 * them instead of ours would report drift on a healthy database — a loud
 * failure rather than a silent one, which is the only reason this test can
 * catch it at all.
 *
 * An unqualified `pg_constraint` lookup stays green whenever the other schema
 * happens to be empty, so this file bakes in the state where a false negative
 * would show.
 *
 * Isolation: one transaction, rolled back at the end. `rows` is TEMP —
 * pg resolves an unqualified name to pg_temp ahead of public, so the
 * migrations' own SQL lands there unchanged and nothing shared is touched. The
 * decoy schema is dropped explicitly, since a schema is not transactional in
 * the way a temp table is... it is, but the DROP is kept anyway so a failed run
 * that somehow commits cannot leave it behind.
 *
 * Skipped when POSTGRES_URL is unset; _setup.ts refuses non-_test/_dev DBs and
 * any superuser.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORTEXT_NAMESPACE } from '../../src/kernel/cortext-namespace.js';
import { auditObjects, type Finding, INVARIANT_OBJECTS } from '../../src/kernel/invariant-audit.js';
import { cortextBaselineMigration } from '../../src/kernel/migrations/0001_baseline.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const describePg = POSTGRES_URL ? describe : describe.skip;

const DECOY_SCHEMA = 'cortext_audit_decoy';

describePg('invariant audit against a real catalog', () => {
  let sql: ReturnType<typeof postgres>;
  let tx: ReturnType<typeof postgres>;
  let release: () => void;
  let savepoint = 0;

  beforeAll(async () => {
    // reserve() + explicit BEGIN/ROLLBACK, matching the other pg suites in this
    // package. The `sql.begin(callback)` form leaves a promise nobody awaits,
    // and when a query inside the transaction errors — which the expected-
    // rejection tests below do on purpose — it surfaces as an UNHANDLED
    // rejection. That showed as 80 green tests with the runner still exiting 1.
    sql = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    const reserved = await sql.reserve();
    release = () => reserved.release();
    tx = reserved as unknown as ReturnType<typeof postgres>;
    await reserved.unsafe('BEGIN');

    await tx.unsafe(`
      CREATE TEMP TABLE rows (
        id text PRIMARY KEY,
        namespace text NOT NULL,
        type text NOT NULL,
        body jsonb,
        priority text,
        status text,
        archived boolean DEFAULT false,
        -- 0003's partial index predicates on both of these; omitting either
        -- fails the migration rather than the audit.
        deleted_at timestamptz
      )
    `);

    const ctx = { sql: tx, metric: (): void => {} };
    await cortextBaselineMigration.apply(ctx as never);

    // --- the decoys ---
    await tx.unsafe(`
      CREATE TEMP TABLE rows_decoy (
        namespace text,
        type text,
        status text,
        CONSTRAINT rows_todo_status_check
          CHECK (NOT (namespace = 'wrong_namespace' AND type = 'Todo') OR status IS NULL)
      )
    `);
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${DECOY_SCHEMA}`);
    await tx.unsafe(`CREATE TABLE ${DECOY_SCHEMA}.identities (kid text, namespace text)`);
    await tx.unsafe(`
      CREATE UNIQUE INDEX rows_agent_identity_kid_unique
        ON ${DECOY_SCHEMA}.identities (kid)
        WHERE namespace = 'wrong_namespace'
    `);
  }, 60_000);

  afterAll(async () => {
    if (tx) await tx.unsafe(`DROP SCHEMA IF EXISTS ${DECOY_SCHEMA} CASCADE`).catch(() => {});
    await tx?.unsafe('ROLLBACK');
    release?.();
    await sql?.end({ timeout: 5 });
  });

  async function withBreakage<T>(ddl: string, assertion: () => Promise<T>): Promise<T> {
    // A failed statement aborts the whole transaction and a full ROLLBACK would
    // take the TEMP table with it, so every mutation is fenced by a SAVEPOINT.
    const name = `sp_audit_${++savepoint}`;
    await tx.unsafe(`SAVEPOINT ${name}`);
    try {
      await tx.unsafe(ddl);
      return await assertion();
    } finally {
      await tx.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    }
  }

  it('PROVES both decoys planted — without this the file measures nothing', async () => {
    // The check on the check. A decoy name whose REAL object is absent from
    // the test path is the only object carrying it, and every scoped
    // assertion below would pass trivially.
    //
    // So the collision is asserted as a MEASUREMENT rather than assumed from
    // the DDL not throwing: an unscoped lookup must see TWO of each name. If
    // this is 1, the decoy is not doing its job and nothing below is evidence.
    const [constraints] = (await tx.unsafe(`
      SELECT count(*)::int AS count FROM pg_constraint
       WHERE conname = 'rows_todo_status_check'
    `)) as unknown as [{ count: number }];
    expect(constraints.count, 'decoy constraint did not collide with the real one').toBe(2);

    const [indexes] = (await tx.unsafe(`
      SELECT count(*)::int AS count FROM pg_class c
        JOIN pg_index i ON c.oid = i.indexrelid
       WHERE c.relname = 'rows_agent_identity_kid_unique'
    `)) as unknown as [{ count: number }];
    expect(indexes.count, 'decoy index did not collide with the real one').toBe(2);
  });

  it('reports nothing on a correctly-migrated table, decoys notwithstanding', async () => {
    // The load-bearing assertion, and it is only evidence because the test
    // above proves the decoys are actually there. Both carry our exact object
    // names with a WRONG scope, so a by-name lookup surfaces them and fails.
    expect((await auditObjects(tx)).findings).toEqual([]);
  });

  it('finds every object the migrations installed', async () => {
    const definitions = (await tx.unsafe(`
      SELECT conname AS name FROM pg_constraint WHERE conrelid = 'rows'::regclass
      UNION ALL
      SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'rows'::regclass
    `)) as unknown as { name: string }[];
    const present = new Set(definitions.map((d) => d.name));
    for (const object of INVARIANT_OBJECTS) {
      expect(present.has(object.name), `${object.name} missing from the migrated table`).toBe(true);
    }
  });

  it('reports a dropped constraint as missing', async () => {
    await withBreakage('ALTER TABLE rows DROP CONSTRAINT rows_todo_status_check', async () => {
      const { findings } = await auditObjects(tx);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ kind: 'object_missing' });
      expect((findings[0] as Extract<Finding, { kind: 'object_missing' }>).object.name).toBe(
        'rows_todo_status_check'
      );
    });
  });

  it('reports a dropped index as missing', async () => {
    await withBreakage('DROP INDEX rows_agent_identity_kid_unique', async () => {
      const { findings } = await auditObjects(tx);
      expect(findings.map((f) => f.kind)).toEqual(['object_missing']);
    });
  });

  it('reports a re-scoped constraint, and names the namespace it actually found', async () => {
    // The object still exists, so nothing errors and
    // no query fails — it simply matches no rows.
    await withBreakage(
      `ALTER TABLE rows DROP CONSTRAINT rows_agent_message_status_check;
       ALTER TABLE rows ADD CONSTRAINT rows_agent_message_status_check
         CHECK (NOT (namespace = 'codex' AND type = 'AgentMessage') OR status IS NULL)`,
      async () => {
        const { findings } = await auditObjects(tx);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ kind: 'object_misscoped', scopedTo: 'codex' });
      }
    );
  });

  it('reports a constraint left NOT VALID', async () => {
    await withBreakage(
      `ALTER TABLE rows DROP CONSTRAINT rows_todo_priority_check;
       ALTER TABLE rows ADD CONSTRAINT rows_todo_priority_check
         CHECK (NOT (namespace = '${CORTEXT_NAMESPACE}' AND type = 'Todo')
                OR priority IS NULL OR priority IN ('low')) NOT VALID`,
      async () => {
        const { findings } = await auditObjects(tx);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ kind: 'object_not_validated' });
      }
    );
  });

  it('returns no findings when rows does not exist at all', async () => {
    // A binary that has never run the dataset migrations. `to_regclass` returns
    // NULL rather than throwing, which is why the guard uses it — a bare
    // `'rows'::regclass` would raise and the audit would report itself
    // broken on a legitimately empty database.
    await withBreakage('DROP TABLE rows CASCADE', async () => {
      const { findings } = await auditObjects(tx);
      expect(findings.map((f) => f.kind)).toEqual(
        INVARIANT_OBJECTS.map(() => 'object_missing' as const)
      );
    });
  });
});
