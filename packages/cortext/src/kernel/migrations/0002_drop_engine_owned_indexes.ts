/**
 * Drops the hand-made indexes 0001 used to build on a legacy `rows`, now that
 * the engine serves the same reads: the derived recipient index for the
 * inbox, and the `indexed: true` indexes on project and status.
 *
 * A partitioned `rows` never had them. Idempotent, like 0001: the runner does
 * not wrap `apply` in a transaction.
 */

import type { KernelMigration, KernelMigrationContext } from '@mnmal-ai/substrate/sdk';
import type postgres from 'postgres';

type Sql = ReturnType<typeof postgres>;

export const ENGINE_OWNED_INDEXES = [
  'rows_agent_message_recipient_idx',
  'rows_ns_type_project_idx',
  'rows_ns_type_status_idx',
  'rows_ns_type_priority_idx',
  'rows_cold_start_idx'
] as const;

export const cortextDropEngineOwnedIndexesMigration: KernelMigration = {
  id: '0002_drop_engine_owned_indexes',
  apply: async ({ sql, layout }: KernelMigrationContext): Promise<void> => {
    if (sql === null || layout === 'partitioned') return;
    await (sql as Sql).unsafe(`DROP INDEX IF EXISTS ${ENGINE_OWNED_INDEXES.join(', ')}`);
  },
  // Nothing to restore: the engine's indexes serve the same reads.
  rollback: async (): Promise<void> => {}
};
