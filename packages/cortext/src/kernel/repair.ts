/**
 * OPT-IN repair for drifted kernel invariants.
 *
 * ## Opt-in, and why it is not automatic
 *
 * Repair is DDL — `DROP CONSTRAINT` / `ADD CONSTRAINT`, `DROP INDEX` /
 * `CREATE INDEX` — taking ACCESS EXCLUSIVE on `rows` and briefly blocking
 * writes. Doing that unbidden on every boot, for a condition the deployment has
 * been tolerating for weeks, is disproportionate to the problem: the invariants
 * being inactive is bad, but it is not an outage, and a self-healing pass that
 * surprises an operator mid-incident is.
 *
 * The same reasoning keeps a renamed namespace bootable: per-cohort context
 * stores are a designed capability, so the kernel reports and never refuses.
 *
 * So the audit reports on every boot and this runs only when asked:
 *
 *     SYNOPTIC_CORTEXT_REPAIR=1
 *
 * An ENV VAR rather than a config field, deliberately. A config field persists,
 * which makes repair run on every boot forever — that is "automatic" wearing an
 * opt-in label. An env var is set for one maintenance restart and then removed,
 * which is what opt-in actually means. It also keeps `config.schema.json`
 * unchanged, and that file is compared byte-for-byte by `schema-parity.test.ts`.
 *
 * ## What it will not do
 *
 * Repair needs a TARGET namespace, and it will only use one the host told it:
 * `coordinatorNamespacesByPlugin`, filtered to the cortext
 * coordinator. Against an older host that field is `undefined` and the answer
 * is "cannot target" — so repair declines rather than guessing. Guessing which
 * of `codex, perf, review` replaced our literal is the failure mode this whole
 * lineage exists to remove, and it would be re-scoping a production schema on
 * the strength of it.
 *
 * It also never aborts the boot. A duplicate kid makes the unique index
 * unbuildable; that is reported and skipped, not thrown. An operator who set an
 * env var for one restart should not be able to brick the service with it.
 */

import type postgres from 'postgres';
import { CORTEXT_NAMESPACE } from './cortext-namespace.js';
import { storeLayout } from './layout.js';
import {
  countDuplicateHostInstallKeys,
  countDuplicateKids,
  rescopeHostInstallKeyIndex,
  rescopeKidUniqueIndex,
  rescopeVocabConstraint,
  VOCAB_CONSTRAINTS
} from './rescope.js';

type Sql = ReturnType<typeof postgres>;
type Metric = (name: string, payload?: unknown) => void;

/** The env var that opts a deployment in, for one restart. */
export const REPAIR_ENV_VAR = 'SYNOPTIC_CORTEXT_REPAIR';

/**
 * Whether repair was asked for.
 *
 * Accepts only the affirmative spellings an operator would plausibly type, and
 * treats everything else — including `0` and `false` — as off. Deliberately not
 * a truthiness check on the raw string: `SYNOPTIC_CORTEXT_REPAIR=false` is
 * unambiguously a request NOT to repair, and a bare presence check would read
 * it as a yes and re-scope a production schema.
 */
export function repairRequested(env: Record<string, string | undefined>): boolean {
  const raw = env[REPAIR_ENV_VAR]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export type RepairOutcome =
  /** Every object now scoped to the target and fully validated. */
  | { readonly kind: 'repaired'; readonly object: string }
  /** Re-scoped, but existing rows violate it — enforced for new writes only. */
  | {
      readonly kind: 'repaired_not_validated';
      readonly object: string;
      readonly violations: number;
    }
  /** Could not be rebuilt; the old object is left in place untouched. */
  | { readonly kind: 'skipped'; readonly object: string; readonly reason: string };

/**
 * Re-scope every invariant object to `namespace`.
 *
 * Constraints first, then indexes — the constraints are
 * the correctness-bearing half and should land even if an index cannot.
 */
export async function repairInvariants(
  sql: unknown,
  metric: Metric,
  namespace: string
): Promise<RepairOutcome[]> {
  const s = sql as Sql;
  const outcomes: RepairOutcome[] = [];

  for (const spec of VOCAB_CONSTRAINTS) {
    const violations = await rescopeVocabConstraint(s, metric, spec, namespace);
    outcomes.push(
      violations > 0
        ? { kind: 'repaired_not_validated', object: spec.constraint, violations }
        : { kind: 'repaired', object: spec.constraint }
    );
  }

  // Asked before attempting, because a UNIQUE index has no NOT VALID
  // equivalent: CREATE UNIQUE INDEX either covers the whole predicate or fails.
  // The CHECK constraints above can degrade to "new writes only"; this cannot,
  // so the only alternative to asking first is throwing.
  const duplicates = await countDuplicateKids(s, namespace);
  if (duplicates > 0) {
    outcomes.push({
      kind: 'skipped',
      object: 'rows_agent_identity_kid_unique',
      reason:
        `${duplicates} kid(s) are held by more than one live AgentIdentity in '${namespace}', ` +
        'so a unique index cannot be built. Recipient resolution is ambiguous until an operator ' +
        'decides which row owns each identity — resolve the duplicates, then re-run repair. The ' +
        'existing index is left exactly as it was.'
    });
  } else {
    await rescopeKidUniqueIndex(s, namespace);
    outcomes.push({ kind: 'repaired', object: 'rows_agent_identity_kid_unique' });
  }

  const duplicateKeys = await countDuplicateHostInstallKeys(s, namespace);
  if (duplicateKeys > 0) {
    outcomes.push({
      kind: 'skipped',
      object: 'rows_host_install_key_unique',
      reason:
        `${duplicateKeys} HostInstall key(s) are held by more than one live row in '${namespace}', ` +
        'so a unique index cannot be built. Delete the older row for each key, then re-run repair. ' +
        'The existing index is left exactly as it was.'
    });
  } else {
    await rescopeHostInstallKeyIndex(s, namespace);
    outcomes.push({ kind: 'repaired', object: 'rows_host_install_key_unique' });
  }

  return outcomes;
}

/** The operator-facing sentence for one outcome. */
export function repairOutcomeMessage(outcome: RepairOutcome, namespace: string): string {
  const head = '[cortext-kernel]';
  switch (outcome.kind) {
    case 'repaired':
      return `${head} re-scoped '${outcome.object}' to namespace '${namespace}'.`;
    case 'repaired_not_validated':
      return (
        `${head} re-scoped '${outcome.object}' to '${namespace}', but left it NOT VALID: ` +
        `${outcome.violations} existing row(s) violate it. New writes ARE enforced; the existing ` +
        'rows are not, and will not be until they are corrected and the constraint validated.'
      );
    case 'skipped':
      return `${head} could NOT repair '${outcome.object}'. ${outcome.reason}`;
  }
}

/**
 * Run repair if asked, and report. Returns null when it did not run, so a
 * caller can tell "declined" from "ran and found nothing to do".
 *
 * Never throws, for the same reason the audit does not: this is invoked during
 * boot, and a failure here must degrade to a report rather than take down a
 * service that was running fine — badly, but fine — a moment earlier.
 */
export async function repairIfRequested(
  ctx: {
    readonly sql: unknown;
    readonly namespace: string | null;
    readonly env: Record<string, string | undefined>;
    metric(name: string, payload?: unknown): void;
  },
  warn: (message: string) => void = console.warn
): Promise<RepairOutcome[] | null> {
  if (!repairRequested(ctx.env)) return null;

  if (ctx.sql === null || ctx.sql === undefined) {
    warn(
      `[cortext-kernel] ${REPAIR_ENV_VAR} is set, but this binary has no SQL handle ` +
        '(in-memory dataset). Nothing to repair.'
    );
    return null;
  }

  if (ctx.namespace === null) {
    // The honest non-answer. Repairing to CORTEXT_NAMESPACE here would be
    // guessing that nothing drifted, which is precisely the case where repair
    // was not needed — and if something HAS drifted it would re-scope a
    // production schema to the wrong target.
    warn(
      `[cortext-kernel] ${REPAIR_ENV_VAR} is set, but the target namespace cannot be ` +
        'determined: this substrate does not attribute namespaces to their plugin (added in 5.1.0), ' +
        'or the cortext coordinator is not loaded. Repair DECLINED — it will not guess which ' +
        'namespace to re-scope to. Upgrade the binary, or run against a host that reports ' +
        'coordinatorNamespacesByPlugin.'
    );
    ctx.metric('cortext_kernel.repair_declined', { reason: 'target_unknown' });
    return null;
  }

  if ((await storeLayout(ctx.sql).catch(() => 'legacy')) === 'partitioned') {
    warn(
      `[cortext-kernel] ${REPAIR_ENV_VAR} is set, but rows is partitioned: the engine owns ` +
        "cortext's indexes there and there are no parent-level objects to repair. Nothing to do."
    );
    ctx.metric('cortext_kernel.repair_declined', { reason: 'partitioned' });
    return null;
  }

  warn(
    `[cortext-kernel] ${REPAIR_ENV_VAR} is set — re-scoping kernel invariants to ` +
      `'${ctx.namespace}'. This takes ACCESS EXCLUSIVE on rows and briefly blocks writes.` +
      (ctx.namespace === CORTEXT_NAMESPACE
        ? ' Target matches the built-in scope literal, so this is a no-op rebuild.'
        : '')
  );

  try {
    const outcomes = await repairInvariants(ctx.sql, ctx.metric, ctx.namespace);
    for (const outcome of outcomes) {
      ctx.metric('cortext_kernel.repair_outcome', {
        outcome: outcome.kind,
        object: outcome.object,
        namespace: ctx.namespace
      });
      warn(repairOutcomeMessage(outcome, ctx.namespace));
    }
    warn(
      `[cortext-kernel] repair complete. Unset ${REPAIR_ENV_VAR} — leaving it set re-runs ` +
        'this DDL on every boot, which is the automatic behaviour opt-in exists to avoid.'
    );
    return outcomes;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.metric('cortext_kernel.repair_failed', { error: message, namespace: ctx.namespace });
    warn(
      `[cortext-kernel] repair FAILED: ${message}. Some objects may have been re-scoped and ` +
        'others not — re-run the audit (restart without the env var) to see the current state.'
    );
    return null;
  }
}
