/**
 * cortext-kernel's schema on `rows`: the columns cortext promotes out of the
 * body (see `CORTEXT_PROMOTED_COLUMNS`), their indexes, and the invariants
 * on cortext's own types.
 *
 * The kernel runner does not wrap `apply` in a transaction, so each statement
 * commits on its own and a run that dies part-way re-applies cleanly: every
 * statement is idempotent.
 */

import type { KernelMigration, KernelMigrationContext } from '@mnmal-ai/substrate/sdk';
import type postgres from 'postgres';
import { CORTEXT_NAMESPACE } from '../cortext-namespace.js';
import { reportedLayout, storeLayout } from '../layout.js';
import {
  rescopeHostInstallKeyIndex,
  rescopeKidUniqueIndex,
  rescopeRecipientIndex,
  rescopeVocabConstraint,
  VOCAB_CONSTRAINTS
} from '../rescope.js';

type Sql = ReturnType<typeof postgres>;

export const cortextBaselineMigration: KernelMigration = {
  id: '0001_baseline',
  apply: async (ctx: KernelMigrationContext): Promise<void> => {
    const { sql, metric } = ctx;
    if (sql === null) return;
    const s = sql as Sql;

    await s.unsafe(`
      ALTER TABLE rows
        ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS project  text    NULL,
        ADD COLUMN IF NOT EXISTS status   text    NULL,
        ADD COLUMN IF NOT EXISTS priority text    NULL
    `);
    // Partitioned: the engine builds the declared and indexed:true indexes per
    // partition; parent-level DDL would fail (unique) or fan out (the rest).
    if ((await storeLayout(s, reportedLayout(ctx))) === 'partitioned') return;
    for (const column of ['archived', 'project', 'status', 'priority']) {
      await s.unsafe(`
        CREATE INDEX IF NOT EXISTS rows_ns_type_${column}_idx
          ON rows (namespace, type, ${column}) WHERE deleted_at IS NULL
      `);
    }
    // The cold-start read: live rows of a type in a project.
    await s.unsafe(`
      CREATE INDEX IF NOT EXISTS rows_cold_start_idx
        ON rows (namespace, type, project)
        WHERE deleted_at IS NULL AND archived IS NOT TRUE
    `);

    for (const spec of VOCAB_CONSTRAINTS) {
      await rescopeVocabConstraint(s, metric, spec, CORTEXT_NAMESPACE);
    }
    await rescopeRecipientIndex(s, CORTEXT_NAMESPACE);
    await rescopeKidUniqueIndex(s, CORTEXT_NAMESPACE);
    await rescopeHostInstallKeyIndex(s, CORTEXT_NAMESPACE);
  },
  rollback: async ({ sql }: KernelMigrationContext): Promise<void> => {
    if (sql === null) return;
    const s = sql as Sql;
    for (const { constraint } of VOCAB_CONSTRAINTS) {
      await s.unsafe(`ALTER TABLE rows DROP CONSTRAINT IF EXISTS ${constraint}`);
    }
    // Dropping the columns drops every index on them; the body indexes go by name.
    await s.unsafe(
      'DROP INDEX IF EXISTS rows_agent_identity_kid_unique, rows_host_install_key_unique'
    );
    await s.unsafe(
      'ALTER TABLE rows DROP COLUMN IF EXISTS archived, DROP COLUMN IF EXISTS project, ' +
        'DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS priority'
    );
  }
};
