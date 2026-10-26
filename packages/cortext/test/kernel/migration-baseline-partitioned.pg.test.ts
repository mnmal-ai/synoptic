/**
 * cortext-kernel on a partitioned `rows` (LIST namespace -> LIST type): the
 * baseline adds the promoted columns and plants nothing else on the parent,
 * the audit does not report the engine-owned indexes as missing, and repair
 * declines.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORTEXT_NAMESPACE } from '../../src/kernel/cortext-namespace.js';
import { reportInvariantAudit } from '../../src/kernel/invariant-audit.js';
import { storeLayout } from '../../src/kernel/layout.js';
import { cortextBaselineMigration } from '../../src/kernel/migrations/0001_baseline.js';
import { REPAIR_ENV_VAR, repairIfRequested } from '../../src/kernel/repair.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const describePg = POSTGRES_URL ? describe : describe.skip;

describePg('cortext baseline migration on a partitioned rows', () => {
  let sql: ReturnType<typeof postgres>;
  let tx: ReturnType<typeof postgres>;
  let release: () => void;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    const reserved = await sql.reserve();
    release = () => reserved.release();
    tx = reserved as unknown as ReturnType<typeof postgres>;
    await reserved.unsafe('BEGIN');
    await tx.unsafe(`
      CREATE TEMP TABLE rows (
        namespace text NOT NULL,
        type text NOT NULL,
        id text NOT NULL,
        body jsonb NOT NULL,
        deleted_at timestamptz,
        PRIMARY KEY (namespace, type, id)
      ) PARTITION BY LIST (namespace)
    `);
    await tx.unsafe(
      `CREATE TEMP TABLE rows_cortext PARTITION OF rows FOR VALUES IN ('${CORTEXT_NAMESPACE}') PARTITION BY LIST (type)`
    );
    for (const type of ['AgentIdentity', 'Todo']) {
      await tx.unsafe(
        `CREATE TEMP TABLE rows_cortext_${type.toLowerCase()} PARTITION OF rows_cortext FOR VALUES IN ('${type}')`
      );
    }
    // No ctx.layout, as on hosts that predate it: the catalog decides.
    const ctx = { sql: tx, metric: (): void => {} };
    await cortextBaselineMigration.apply(ctx as never);
    await cortextBaselineMigration.apply(ctx as never);
  }, 60_000);

  afterAll(async () => {
    await tx?.unsafe('ROLLBACK');
    release?.();
    await sql?.end({ timeout: 5 });
  });

  it('reads the layout from the catalog, and prefers a reported one', async () => {
    expect(await storeLayout(tx)).toBe('partitioned');
    expect(await storeLayout(tx, 'legacy')).toBe('legacy');
  });

  it('adds the promoted columns', async () => {
    await tx.unsafe(
      `INSERT INTO rows (namespace, type, id, body, status) VALUES ('${CORTEXT_NAMESPACE}', 'Todo', 't1', '{}', 'open')`
    );
    const [row] = await tx.unsafe(`SELECT archived, project, status FROM rows WHERE id = 't1'`);
    expect(row).toEqual({ archived: false, project: null, status: 'open' });
  });

  it('plants no index or CHECK on the parent beyond the primary key', async () => {
    const indexes = await tx.unsafe(`
      SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'rows'::regclass AND NOT i.indisprimary
    `);
    const checks = await tx.unsafe(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'rows'::regclass AND contype = 'c'`
    );
    expect(indexes).toEqual([]);
    expect(checks).toEqual([]);
  });

  it('audits without reporting the engine-owned objects as missing', async () => {
    const metrics: Array<[string, unknown]> = [];
    const findings = await reportInvariantAudit(
      {
        sql: tx,
        coordinatorNamespaces: [CORTEXT_NAMESPACE],
        metric: (name, payload) => metrics.push([name, payload])
      },
      () => {}
    );
    expect(findings).toEqual([]);
    expect(metrics).toContainEqual([
      'cortext_kernel.invariant_audit_complete',
      { checked: 0, findings: 0, catalogRead: true, layout: 'partitioned' }
    ]);
  });

  it('declines repair', async () => {
    const metrics: string[] = [];
    const outcomes = await repairIfRequested(
      {
        sql: tx,
        namespace: CORTEXT_NAMESPACE,
        env: { [REPAIR_ENV_VAR]: '1' },
        metric: (name, payload) => metrics.push(`${name}:${JSON.stringify(payload)}`)
      },
      () => {}
    );
    expect(outcomes).toBeNull();
    expect(metrics).toEqual(['cortext_kernel.repair_declined:{"reason":"partitioned"}']);
  });
});
