/**
 * cortext's kernel plugin — kernel-tier sibling of the
 * `@mnmal-ai/cortext` coordinator.
 *
 * Owns the kernel-level schema/body invariants for the cortext
 * coordination namespaces (`cortext/*` + `architecture/*`: vocabulary CHECK
 * constraints, one-time body normalisations) so the generic
 * pg dataset in substrate stays plugin-agnostic.
 *
 * Migration order is the array order below. See `./cortext-namespace.ts` for
 * why the namespace literal has exactly one home.
 *
 * The plugin contributes `migrations` and one `onKernelReady` handler. No
 * filter operators, no kernel routes, no MCP tools — if a future schema-level
 * need arises (e.g. column promotion for a new controlled vocabulary), it
 * lands as another `KernelMigration` in the `migrations` array.
 *
 * `onKernelReady` AUDITS on every boot and REPAIRS only when asked.
 * Migrations run once and are recorded by id, so nothing re-examines
 * what they installed; the handler reads the catalog and reports objects that
 * are absent, scoped to a namespace no coordinator declares, or left NOT VALID.
 *
 * The `sql` handle makes the audit possible, and plugin-attributed namespaces
 * make repair targetable. Repair is gated on `SYNOPTIC_CORTEXT_REPAIR` rather than
 * automatic — see `./repair.ts` for why, and for why it declines rather than
 * guessing when the target namespace is unknown.
 */

import type { KernelPlugin } from '@mnmal-ai/substrate/sdk';
import { reportInvariantAudit, resolveCortextNamespaces } from './invariant-audit.js';
import { cortextBaselineMigration } from './migrations/0001_baseline.js';
import { repairIfRequested } from './repair.js';
import { SUBSTRATE_CONTRACT_RANGE } from './substrate-contract.js';

export function createCortextKernelPlugin(): KernelPlugin {
  return {
    name: 'cortext-kernel',
    contractVersion: SUBSTRATE_CONTRACT_RANGE,
    onKernelReady: async (ctx): Promise<void> => {
      // Audit ALWAYS, repair only when asked. Neither can reject — an
      // observation must not be able to take down a service that has been
      // running with the condition it observes, and nor should a maintenance
      // env var.
      await reportInvariantAudit(ctx);
      await repairIfRequested({
        sql: ctx.sql,
        // Only a host-supplied target, never a guess. null here means the
        // binary predates coordinatorNamespacesByPlugin or
        // cortext is not loaded; repair declines in both cases.
        namespace: resolveCortextNamespaces(ctx.coordinatorNamespacesByPlugin)?.[0] ?? null,
        env: process.env,
        metric: ctx.metric
      });
    },
    migrations: [cortextBaselineMigration]
  };
}
