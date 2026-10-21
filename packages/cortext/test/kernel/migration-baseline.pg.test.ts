/**
 * cortext-kernel's baseline, against a real postgres: it adds the promoted
 * columns and enforces cortext's invariants, it can run twice, and its
 * rollback takes the columns away again.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORTEXT_NAMESPACE } from '../../src/kernel/cortext-namespace.js';
import { cortextBaselineMigration } from '../../src/kernel/migrations/0001_baseline.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const describePg = POSTGRES_URL ? describe : describe.skip;

describePg('cortext baseline migration', () => {
  let sql: ReturnType<typeof postgres>;
  let tx: ReturnType<typeof postgres>;
  let release: () => void;
  let savepoint = 0;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    const reserved = await sql.reserve();
    release = () => reserved.release();
    tx = reserved as unknown as ReturnType<typeof postgres>;
    await reserved.unsafe('BEGIN');
    // The engine's rows table, without any promoted column.
    await tx.unsafe(`
      CREATE TEMP TABLE rows (
        namespace text NOT NULL,
        type text NOT NULL,
        id text NOT NULL,
        body jsonb NOT NULL,
        deleted_at timestamptz,
        PRIMARY KEY (namespace, type, id)
      )
    `);
    const ctx = { sql: tx, metric: (): void => {} };
    await cortextBaselineMigration.apply(ctx as never);
    await cortextBaselineMigration.apply(ctx as never);
  }, 60_000);

  afterAll(async () => {
    await tx?.unsafe('ROLLBACK');
    release?.();
    await sql?.end({ timeout: 5 });
  });

  async function fenced<T>(run: () => Promise<T>): Promise<T> {
    const name = `sp_baseline_${++savepoint}`;
    await tx.unsafe(`SAVEPOINT ${name}`);
    try {
      return await run();
    } finally {
      await tx.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    }
  }

  const insert = (type: string, id: string, cols: string, vals: string, body = '{}') =>
    tx.unsafe(
      `INSERT INTO rows (namespace, type, id, body${cols}) VALUES ('${CORTEXT_NAMESPACE}', '${type}', '${id}', '${body}'${vals})`
    );

  it('adds the promoted columns, archived defaulting to false', async () => {
    await fenced(async () => {
      await insert('Todo', 't1', ', status', ", 'open'");
      const [row] = await tx.unsafe(`SELECT archived, project, status FROM rows WHERE id = 't1'`);
      expect(row).toEqual({ archived: false, project: null, status: 'open' });
    });
  });

  it('refuses a Todo status outside the lifecycle vocabulary', async () => {
    await fenced(async () => {
      await expect(insert('Todo', 't2', ', status', ", 'nonsense'")).rejects.toThrow(
        /rows_todo_status_check/
      );
    });
  });

  it('refuses a second live AgentIdentity with the same kid', async () => {
    await fenced(async () => {
      await insert('AgentIdentity', 'a1', '', '', '{"kid":"k@h"}');
      await expect(insert('AgentIdentity', 'a2', '', '', '{"kid":"k@h"}')).rejects.toThrow(
        /rows_agent_identity_kid_unique/
      );
    });
  });

  it('rolls back to the engine table', async () => {
    await fenced(async () => {
      await cortextBaselineMigration.rollback?.({ sql: tx, metric: () => {} } as never);
      const cols = await tx.unsafe(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'rows' AND table_schema LIKE 'pg_temp%' ORDER BY 1`
      );
      expect(cols.map((c) => c.column_name)).toEqual([
        'body',
        'deleted_at',
        'id',
        'namespace',
        'type'
      ]);
    });
  });
});
