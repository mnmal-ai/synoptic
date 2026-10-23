/**
 * Pg-gated coverage for opt-in repair.
 *
 * Builds the state repair exists for, which is the only state that tests it:
 * a store whose objects are scoped to one namespace while the rows live in
 * another, INCLUDING rows that violate the vocabulary. That combination is the
 * whole reason repair could not be a plain `ADD CONSTRAINT` — a store that ran
 * unscoped accumulates exactly the rows that make validation fail, so the naive
 * implementation breaks on precisely the databases it is meant to fix.
 *
 * Isolation: TEMP `rows` in one transaction, rolled back. Skipped when
 * POSTGRES_URL is unset; _setup.ts refuses non-_test/_dev DBs and any superuser.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditObjects, INVARIANT_OBJECTS } from '../../src/kernel/invariant-audit.js';
import { cortextBaselineMigration } from '../../src/kernel/migrations/0001_baseline.js';
import { repairInvariants } from '../../src/kernel/repair.js';
import { countDuplicateHostInstallKeys, countDuplicateKids } from '../../src/kernel/rescope.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const describePg = POSTGRES_URL ? describe : describe.skip;

/** The namespace an operator renamed their context store to. */
const DRIFTED = 'codex';

describePg('opt-in repair against a drifted store', () => {
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
        deleted_at timestamptz
      )
    `);

    const ctx = { sql: tx, metric: (): void => {} };
    await cortextBaselineMigration.apply(ctx as never);
  }, 60_000);

  afterAll(async () => {
    await tx?.unsafe('ROLLBACK');
    release?.();
    await sql?.end({ timeout: 5 });
  });

  async function fenced<T>(run: () => Promise<T>): Promise<T> {
    const name = `sp_repair_${++savepoint}`;
    await tx.unsafe(`SAVEPOINT ${name}`);
    try {
      return await run();
    } finally {
      await tx.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    }
  }

  const insertTodo = (id: string, ns: string, status: string): string =>
    `INSERT INTO rows (id, namespace, type, body, status)
       VALUES ('${id}', '${ns}', 'Todo', '{}'::jsonb, '${status}')`;

  const insertIdentity = (id: string, ns: string, kid: string): string =>
    `INSERT INTO rows (id, namespace, type, body)
       VALUES ('${id}', '${ns}', 'AgentIdentity', '{"kid":"${kid}"}'::jsonb)`;

  const insertHostInstall = (id: string, ns: string, key: string): string =>
    `INSERT INTO rows (id, namespace, type, body)
       VALUES ('${id}', '${ns}', 'HostInstall', '{"key":"${key}"}'::jsonb)`;

  it('re-scopes every object to the configured namespace', async () => {
    await fenced(async () => {
      const outcomes = await repairInvariants(tx, () => {}, DRIFTED);
      expect(outcomes.every((o) => o.kind === 'repaired')).toBe(true);

      // The audit is scoped to CORTEXT_NAMESPACE, so after re-scoping to
      // `codex` it should now report every object as misscoped — which is the
      // proof the DDL actually moved them, from the other direction.
      const { findings } = await auditObjects(tx);
      expect(findings).toHaveLength(INVARIANT_OBJECTS.length);
      expect(findings.every((f) => f.kind === 'object_misscoped')).toBe(true);
      // And against the configured namespace, which is what the boot audit
      // now compares with, they are all correct.
      expect((await auditObjects(tx, 'codex')).findings).toEqual([]);
    });
  });

  it('accepts rows that were legal under the old scope but violate the new one', async () => {
    // THE case the naive implementation dies on. A store that ran unscoped
    // accumulated an out-of-vocabulary status; a plain ADD CONSTRAINT validates
    // immediately and throws. NOT VALID + validate-in-handler downgrades it to
    // "enforced for new writes" instead.
    await fenced(async () => {
      await tx.unsafe(insertTodo('t-bad', DRIFTED, 'not_a_real_status'));

      const outcomes = await repairInvariants(tx, () => {}, DRIFTED);
      const status = outcomes.find((o) => o.object === 'rows_todo_status_check');
      expect(status).toMatchObject({ kind: 'repaired_not_validated', violations: 1 });

      // Enforced going forward even though the old row survives. Caught
      // explicitly rather than with `.rejects`: postgres.js surfaces the error
      // on the connection as well as on the query promise, and the matcher form
      // left it unhandled — 80 green tests with the runner still exiting 1.
      await tx.unsafe(`SAVEPOINT sp_write`);
      let rejection: unknown;
      try {
        await tx.unsafe(insertTodo('t-new', DRIFTED, 'also_bogus'));
      } catch (error) {
        rejection = error;
      }
      expect(String(rejection)).toMatch(/violates check constraint/);
      await tx.unsafe(`ROLLBACK TO SAVEPOINT sp_write`);
    });
  });

  it('does not abort the boot on duplicate kids — it skips and explains', async () => {
    // A UNIQUE index has no NOT VALID equivalent, so this is the one object
    // that genuinely cannot be repaired in place. It must degrade, not throw:
    // an operator who set an env var for one restart should not be able to
    // brick the service.
    await fenced(async () => {
      await tx.unsafe(insertIdentity('i-1', DRIFTED, 'kid-collide'));
      await tx.unsafe(insertIdentity('i-2', DRIFTED, 'kid-collide'));
      expect(await countDuplicateKids(tx, DRIFTED)).toBe(1);

      const outcomes = await repairInvariants(tx, () => {}, DRIFTED);
      const kid = outcomes.find((o) => o.object === 'rows_agent_identity_kid_unique');
      expect(kid).toMatchObject({ kind: 'skipped' });
      expect((kid as { reason: string }).reason).toContain('more than one live AgentIdentity');

      // And the constraints still landed — they are the correctness-bearing
      // half and must not be held hostage to an index that cannot build.
      expect(outcomes.filter((o) => o.kind === 'repaired').length).toBeGreaterThan(0);
    });
  });

  it('skips the HostInstall key index on duplicate keys, and still repairs the rest', async () => {
    await fenced(async () => {
      await tx.unsafe(insertHostInstall('h-1', DRIFTED, 'host/p'));
      await tx.unsafe(insertHostInstall('h-2', DRIFTED, 'host/p'));
      expect(await countDuplicateHostInstallKeys(tx, DRIFTED)).toBe(1);

      const outcomes = await repairInvariants(tx, () => {}, DRIFTED);
      const key = outcomes.find((o) => o.object === 'rows_host_install_key_unique');
      expect(key).toMatchObject({ kind: 'skipped' });
      expect((key as { reason: string }).reason).toContain('more than one live row');
      expect(outcomes.find((o) => o.object === 'rows_agent_identity_kid_unique')).toMatchObject({
        kind: 'repaired'
      });
    });
  });

  it('leaves the existing index untouched when it skips', async () => {
    await fenced(async () => {
      const before = (await tx.unsafe(`
        SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = 'rows'::regclass
           AND c.relname = 'rows_agent_identity_kid_unique'
      `)) as unknown as { def: string }[];

      await tx.unsafe(insertIdentity('i-3', DRIFTED, 'dupe'));
      await tx.unsafe(insertIdentity('i-4', DRIFTED, 'dupe'));
      await repairInvariants(tx, () => {}, DRIFTED);

      const after = (await tx.unsafe(`
        SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = 'rows'::regclass
           AND c.relname = 'rows_agent_identity_kid_unique'
      `)) as unknown as { def: string }[];

      // "Skipped" has to mean the old object survives. A DROP followed by a
      // failed CREATE would leave the deployment with NO uniqueness at all —
      // strictly worse than the drift being repaired.
      expect(after[0]?.def).toBe(before[0]?.def);
    });
  });

  it('is idempotent — repairing twice is a no-op rebuild', async () => {
    await fenced(async () => {
      await repairInvariants(tx, () => {}, DRIFTED);
      const second = await repairInvariants(tx, () => {}, DRIFTED);
      expect(second.every((o) => o.kind === 'repaired')).toBe(true);
    });
  });

  it('restores a healthy audit when repaired back to the built-in literal', async () => {
    // The round trip: drift away, repair back, audit clean. Proves repair
    // targets whatever it is given rather than any hardcoded value.
    await fenced(async () => {
      await repairInvariants(tx, () => {}, DRIFTED);
      expect((await auditObjects(tx)).findings).toHaveLength(INVARIANT_OBJECTS.length);

      await repairInvariants(tx, () => {}, 'cortext');
      expect((await auditObjects(tx)).findings).toEqual([]);
    });
  });
});
