/**
 * Relayed mail is stored once per sending server: a unique index on
 * (viaDomain, remoteId) over live AgentMessage rows that carry a `viaDomain`.
 *
 * Only a legacy `rows` table gets it from here; on partitioned and per-type
 * tables the engine builds the declared index. Idempotent, like 0001.
 */

import type { KernelMigration, KernelMigrationContext } from '@mnmal-ai/substrate/sdk';
import type postgres from 'postgres';
import { CORTEXT_NAMESPACE } from '../cortext-namespace.js';
import { hasRowsTable } from '../layout.js';
import { rescopeRelayMessageIndex } from '../rescope.js';

type Sql = ReturnType<typeof postgres>;

export const cortextRelayMessageUniqueMigration: KernelMigration = {
  id: '0003_relay_message_unique',
  apply: async ({ sql, layout }: KernelMigrationContext): Promise<void> => {
    // Widened: the peer range spans hosts whose layout type differs.
    if (sql === null || !hasRowsTable(layout) || (layout as unknown) === 'partitioned') return;
    await rescopeRelayMessageIndex(sql as Sql, CORTEXT_NAMESPACE);
  },
  rollback: async ({ sql, layout }: KernelMigrationContext): Promise<void> => {
    if (sql === null || !hasRowsTable(layout)) return;
    await (sql as Sql).unsafe('DROP INDEX IF EXISTS rows_agent_message_relay_unique');
  }
};
