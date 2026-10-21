/**
 * Boot-time audit of the kernel invariants this plugin installs.
 *
 * ## What this is, and what it deliberately is not
 *
 * It VERIFIES. It does not repair. Every migration here installs a CHECK
 * constraint or a partial index carrying a `namespace = <literal>` predicate,
 * and a migration is recorded once by `id` — `apply` runs only when that id is
 * absent — so nothing re-examines those objects after the first boot that
 * created them. Between then and now they can be dropped by hand, left NOT
 * VALID by a failed validation, or point at a namespace no coordinator uses.
 * All three fail the same way: writes succeed, queries answer, and the
 * guarantee is simply gone.
 *
 * AgentIdentity.kid uniqueness is what the mailbox's recipient-only trust
 * model rests on. A constraint scoped to a namespace with no rows is not an
 * error; it passes trivially.
 *
 * ## Why this reports rather than repairs
 *
 * Not because repair is impossible — `./repair.ts` does it, using the `sql`
 * handle and the plugin-attributed namespaces, the latter being what makes a
 * rename TARGETABLE rather than merely detectable.
 *
 * The split is deliberate and permanent. Auditing is a read, so it runs on
 * every boot. Repairing is DDL taking ACCESS EXCLUSIVE on `rows`, so it
 * runs only when an operator asks via `SYNOPTIC_CORTEXT_REPAIR`. Keeping them
 * apart means the reporting path can never surprise anyone, and the repair path
 * has exactly one trigger to reason about.
 *
 * The flat `coordinatorNamespaces` this function reads answers "is our literal
 * declared?" but never "what replaced it". `resolveCortextNamespaces` reads the
 * attributed list — and keeps `undefined` from collapsing into `[]`, which would
 * make "too old to answer" read as "answered: none".
 */

import {
  ARCHITECTURE_NAMESPACE,
  CORTEXT_COORDINATOR_NAME,
  CORTEXT_NAMESPACE
} from './cortext-namespace.js';

/** A catalog object one of the migrations installs, and what rests on it. */
export interface InvariantObject {
  readonly name: string;
  readonly kind: 'constraint' | 'index';
  /** The migration that installs it, for the operator chasing this down. */
  readonly migration: string;
  /** Stated as the loss, not the mechanism — see `findingMessage`. */
  readonly guarantee: string;
}

/**
 * The five objects. Enumerated by hand rather than derived from the migration
 * array, deliberately: a migration's `apply` is opaque SQL text, so anything
 * "derived" would be a regex over it that agrees with reality only by luck.
 * `invariant-audit.test.ts` greps the migration sources for the DDL and fails
 * if this list and the migrations disagree — which is the check that actually
 * holds them together.
 *
 * Note there is no `architecture/*` entry, and that is correct: migration 0002
 * is a one-time body normalisation, not a standing invariant. A drifted
 * architecture namespace means that normalisation never ran for those rows —
 * real, but a different and lesser thing than "kid uniqueness is not held".
 */
export const INVARIANT_OBJECTS: readonly InvariantObject[] = [
  {
    name: 'rows_todo_status_check',
    kind: 'constraint',
    migration: '0001_baseline',
    guarantee: 'Todo.status is restricted to its controlled vocabulary'
  },
  {
    name: 'rows_todo_priority_check',
    kind: 'constraint',
    migration: '0001_baseline',
    guarantee: 'Todo.priority is restricted to its controlled vocabulary'
  },
  {
    name: 'rows_agent_message_recipient_idx',
    kind: 'index',
    migration: '0001_baseline',
    guarantee: 'mailbox inbox reads are index-backed rather than heap scans'
  },
  {
    name: 'rows_agent_identity_kid_unique',
    kind: 'index',
    migration: '0001_baseline',
    guarantee:
      "AgentIdentity.kid is unique — the mailbox's recipient-only trust model rests on this"
  },
  {
    name: 'rows_agent_message_status_check',
    kind: 'constraint',
    migration: '0001_baseline',
    guarantee: 'AgentMessage.status is restricted to its controlled vocabulary'
  },
  {
    name: 'rows_host_install_key_unique',
    kind: 'index',
    migration: '0001_baseline',
    guarantee:
      'HostInstall.key is unique — one record per host, repo and harness, so the fleet view cannot show duplicates'
  }
];

/**
 * Why the audit could not say which namespace replaced ours.
 *
 * `host_does_not_attribute` is NOT the same as `coordinator_absent`, and
 * collapsing them is the whole reason this type exists — see
 * `resolveCortextNamespaces`.
 */
export type UntargetableReason = 'host_does_not_attribute' | 'coordinator_absent';

export type Finding =
  /** Our literal is undeclared, and we cannot say what replaced it. */
  | {
      readonly kind: 'namespace_uncovered';
      readonly scopedTo: string;
      readonly declared: readonly string[];
      readonly reason: UntargetableReason;
    }
  /** Our literal is undeclared, and the cortext coordinator names its replacement. */
  | {
      readonly kind: 'namespace_drifted';
      readonly scopedTo: string;
      readonly configured: string;
    }
  /** The object is not in the catalog at all. */
  | { readonly kind: 'object_missing'; readonly object: InvariantObject }
  /** Present, but its predicate names a different namespace. */
  | {
      readonly kind: 'object_misscoped';
      readonly object: InvariantObject;
      readonly scopedTo: string | null;
    }
  /** Present and correctly scoped, but NOT VALID — new writes only. */
  | { readonly kind: 'object_not_validated'; readonly object: InvariantObject };

/** One entry of the host's plugin-attributed namespace list. */
export interface PluginNamespace {
  readonly plugin: string;
  readonly namespace: string;
}

/**
 * The namespaces the cortext COORDINATOR declared, or `null` when the host
 * cannot say.
 *
 * The three states are genuinely distinct and the middle one is easy to lose:
 *
 *   - `undefined` in  -> `null` out. The host predates
 *     `coordinatorNamespacesByPlugin`. It is not telling us
 *     "none"; it is not telling us anything.
 *   - `[]` in, or no rows for our plugin -> `[]` out. The host DID attribute,
 *     and cortext contributed nothing — it is not loaded.
 *   - rows for our plugin -> those namespaces, in declaration order.
 *
 * The host deliberately does not default `undefined` to `[]`, which would make
 * "too old to answer" read identically to "answered: none". Returning `null`
 * rather than an empty array preserves that distinction.
 */
export function resolveCortextNamespaces(
  byPlugin: readonly PluginNamespace[] | undefined
): readonly string[] | null {
  if (byPlugin === undefined) return null;
  return byPlugin.filter((p) => p.plugin === CORTEXT_COORDINATOR_NAME).map((p) => p.namespace);
}

/**
 * Whether a coordinator declared the namespace our objects are scoped to, and
 * — when the host attributes — which namespace replaced it.
 *
 * Pure, and the only half that works without a `sql` handle, so it is what runs
 * against the in-memory dataset.
 *
 * Only the context-store literal is checked. `ARCHITECTURE_NAMESPACE` is
 * exported for callers that want it but is not audited here, for the reason in
 * `INVARIANT_OBJECTS`: no catalog object is scoped to it.
 */
export function auditNamespaceCoverage(
  coordinatorNamespaces: readonly string[],
  byPlugin?: readonly PluginNamespace[]
): Finding[] {
  if (coordinatorNamespaces.includes(CORTEXT_NAMESPACE)) return [];

  const ours = resolveCortextNamespaces(byPlugin);
  const configured = ours?.[0];
  if (configured !== undefined) {
    // The context store is namespaces[0] by construction in the coordinator's
    // `namespaces: [buildClaudeNamespace(...), buildArchitectureNamespace(...)]`.
    // Declaration order is part of substrate's contract for this field.
    return [{ kind: 'namespace_drifted', scopedTo: CORTEXT_NAMESPACE, configured }];
  }

  return [
    {
      kind: 'namespace_uncovered',
      scopedTo: CORTEXT_NAMESPACE,
      declared: coordinatorNamespaces,
      reason: ours === null ? 'host_does_not_attribute' : 'coordinator_absent'
    }
  ];
}

/** The namespace a predicate is scoped to, or null if it names none. */
export function scopedNamespace(definition: string): string | null {
  // Exact capture rather than a substring test. `definition.includes('cortext')`
  // would also be satisfied by a namespace called `cortex`, and — worse — would
  // report a boolean when the useful thing is WHICH namespace it actually found.
  // pg renders the literal as `'name'::text` in `pg_get_constraintdef` and as
  // plain `'name'` in some index predicates, so the cast is optional here.
  const m = definition.match(/namespace = '([^']*)'(?:::text)?/);
  return m?.[1] ?? null;
}

interface CatalogRow {
  readonly name: string;
  readonly definition: string;
  readonly validated: boolean;
}

/**
 * Read the catalog state of every object on `rows`.
 *
 * Both lookups are RELATION-scoped (`conrelid` / `indrelid` against
 * `'rows'::regclass`) and not by name alone. Constraint names are unique
 * per relation and index names per schema — neither is globally unique — so a
 * by-name lookup silently reads an unrelated object the moment a second schema
 * carries the same name.
 */
async function readCatalog(sql: SqlTag): Promise<Map<string, CatalogRow>> {
  const rows = new Map<string, CatalogRow>();

  // to_regclass returns NULL rather than throwing when the table is absent,
  // which is the state on a binary that has never run the dataset migrations.
  const [present] = (await sql`SELECT to_regclass('rows') IS NOT NULL AS ok`) as unknown as [
    { ok: boolean } | undefined
  ];
  if (!present?.ok) return rows;

  const constraints = (await sql`
    SELECT conname AS name, pg_get_constraintdef(oid) AS definition, convalidated AS validated
      FROM pg_constraint
     WHERE conrelid = 'rows'::regclass
  `) as unknown as CatalogRow[];
  for (const r of constraints) rows.set(r.name, r);

  // An index has no notion of NOT VALID; indisvalid means "usable by the
  // planner", which a failed CONCURRENTLY build leaves false. Same operator
  // consequence — the object exists and does nothing — so it maps onto the
  // same finding rather than earning its own.
  const indexes = (await sql`
    SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS validated
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'rows'::regclass
  `) as unknown as CatalogRow[];
  for (const r of indexes) rows.set(r.name, r);

  return rows;
}

/** Minimal shape of the postgres tag this needs — see `auditObjects`. */
type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

/**
 * Audit every object's presence, scope and validity.
 *
 * `sql` is typed `unknown` on the lifecycle context (substrate keeps the driver out
 * of its type surface), so the cast happens here, once, exactly as the
 * migrations do it.
 */
/**
 * Audit the invariant objects.
 *
 * Returns the INSPECTED COUNT alongside the findings.
 *
 * A tally rather than `INVARIANT_OBJECTS.length`, so that if this loop ever
 * gains a filter, an early return or a per-object skip, the completion metric
 * reports what was actually inspected instead of a promise.
 */
export async function auditObjects(
  sql: unknown
): Promise<{ findings: Finding[]; checked: number }> {
  const catalog = await readCatalog(sql as SqlTag);
  const findings: Finding[] = [];
  let checked = 0;

  for (const object of INVARIANT_OBJECTS) {
    checked++;
    const row = catalog.get(object.name);
    if (!row) {
      findings.push({ kind: 'object_missing', object });
      continue;
    }
    const scope = scopedNamespace(row.definition);
    if (scope !== CORTEXT_NAMESPACE) {
      findings.push({ kind: 'object_misscoped', object, scopedTo: scope });
      continue;
    }
    if (!row.validated) findings.push({ kind: 'object_not_validated', object });
  }

  return { findings, checked };
}

/** The operator-facing sentence for one finding. */
export function findingMessage(finding: Finding): string {
  const head = '[cortext-kernel]';
  switch (finding.kind) {
    case 'namespace_drifted':
      // The targeted message, available only when the host attributes. It names
      // BOTH sides, which is the difference between a finding an operator can
      // act on and one they have to investigate.
      return (
        `${head} the cortext coordinator is configured for namespace ` +
        `'${finding.configured}', but every kernel constraint and index is scoped to ` +
        `'${finding.scopedTo}'. So all of them are INACTIVE for '${finding.configured}': ` +
        'Todo/AgentMessage vocabularies unenforced, the mailbox inbox index covering no rows, ' +
        `and AgentIdentity.kid uniqueness NOT held. Writes succeed and queries answer, so ` +
        `nothing else will report this. Use '${finding.scopedTo}', or accept the loss ` +
        'deliberately.'
      );
    case 'namespace_uncovered':
      return (
        `${head} invariants are scoped to namespace '${finding.scopedTo}', which no loaded ` +
        `coordinator declares (declared: ${finding.declared.join(', ') || 'none'}). Every ` +
        'kernel guarantee below is therefore INACTIVE, and nothing else will report it — ' +
        'a constraint scoped to a namespace with no rows passes trivially. ' +
        (finding.reason === 'host_does_not_attribute'
          ? 'This substrate does not attribute namespaces to their plugin (added in 5.1.0), so ' +
            'which namespace REPLACED it cannot be determined — upgrade the binary to get a ' +
            'named target rather than this list.'
          : 'This substrate does attribute, and the cortext coordinator declared no namespace at ' +
            'all — it is not loaded. The objects are orphaned rather than misscoped.') +
        ' Set SYNOPTIC_CORTEXT_REPAIR=1 for one restart to re-scope.'
      );
    case 'object_missing':
      return (
        `${head} ${finding.object.kind} '${finding.object.name}' (${finding.object.migration}) ` +
        `is ABSENT. Lost guarantee: ${finding.object.guarantee}. Migrations are recorded once ` +
        'by id, so this will NOT be reinstalled by a restart.'
      );
    case 'object_misscoped':
      return (
        `${head} ${finding.object.kind} '${finding.object.name}' is scoped to ` +
        `${finding.scopedTo === null ? 'no namespace' : `'${finding.scopedTo}'`}, not ` +
        `'${CORTEXT_NAMESPACE}'. Lost guarantee: ${finding.object.guarantee}. It exists, so ` +
        'nothing errors; it simply matches no rows.'
      );
    case 'object_not_validated':
      return (
        `${head} ${finding.object.kind} '${finding.object.name}' exists but is NOT VALID — ` +
        `enforced for new writes only, and existing rows were never checked against it. ` +
        `Guarantee held only going forward: ${finding.object.guarantee}.`
      );
  }
}

/**
 * Run the audit and report. Returns the findings so a caller — or a test — can
 * assert on them without capturing the console.
 *
 * Both sinks: `metric` is the structured
 * channel an operator alerts on, and the console line is what actually appears
 * in the server journal beside substrate's own loader warnings, which is
 * where someone will see it.
 *
 * Never throws. A kernel plugin that aborts the boot over an OBSERVATION
 * would take the service down for a condition the service has been running
 * with, possibly for weeks — the whole point is that these failures are silent
 * and survivable. A catalog read that itself fails is reported and swallowed.
 *
 * ## It always emits, including when it finds nothing
 *
 * Every OTHER metric here names a failure, so without a completion signal a
 * clean audit and an audit that never ran would both be silence. A check whose
 * PASS state is indistinguishable from its absence is not falsifiable.
 *
 * So `invariant_audit_complete` fires on every path that reaches the end,
 * carrying `checked`. Silence now means the audit DID NOT RUN and is
 * actionable, and a `checked` that drops from 5 to 4 is visible without
 * anything having failed. Metric only, not a console line: a per-boot success
 * message on every deployment is noise, and the metric sink is exactly the
 * structured channel this belongs in.
 */
export async function reportInvariantAudit(
  ctx: {
    readonly sql: unknown;
    readonly coordinatorNamespaces: readonly string[];
    // Optional on the wire AND optional here, on purpose: cortext's peer range
    // floors at 4.1.0, so a host that predates this field is not an edge case,
    // it is the currently-deployed one.
    readonly coordinatorNamespacesByPlugin?: readonly PluginNamespace[];
    metric(name: string, payload?: unknown): void;
  },
  warn: (message: string) => void = console.warn
): Promise<Finding[]> {
  const findings: Finding[] = [
    ...auditNamespaceCoverage(ctx.coordinatorNamespaces, ctx.coordinatorNamespacesByPlugin)
  ];

  // null on the in-memory dataset — there is no catalog to read, and that is a
  // supported configuration, not a fault. Recorded rather than inferred, so
  // `checked: 0` cannot be confused with "checked and found none".
  const catalogRead = ctx.sql !== null && ctx.sql !== undefined;

  // Stays 0 when the catalog is unreadable OR when auditObjects throws — in
  // both cases nothing was inspected, and a tally that survived a throw would
  // be the same lie in a new place.
  let objectsChecked = 0;

  if (catalogRead) {
    try {
      const result = await auditObjects(ctx.sql);
      findings.push(...result.findings);
      objectsChecked = result.checked;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.metric('cortext_kernel.invariant_audit_failed', { error: message });
      warn(
        `[cortext-kernel] could not audit kernel invariants: ${message}. ` +
          'This is the audit failing, NOT the invariants — their state is now unknown.'
      );
      return findings;
    }
  }

  for (const finding of findings) {
    ctx.metric('cortext_kernel.invariant_inactive', {
      finding: finding.kind,
      object: 'object' in finding ? finding.object.name : undefined,
      scopedTo: 'scopedTo' in finding ? finding.scopedTo : undefined,
      // Only ever set on namespace_drifted, which is the point: an alert on
      // this metric can now route on whether a target is KNOWN.
      configured: 'configured' in finding ? finding.configured : undefined,
      reason: 'reason' in finding ? finding.reason : undefined
    });
    warn(findingMessage(finding));
  }

  // The completion signal. Emitted on the clean path AND alongside findings —
  // "the audit ran" and "the audit found something" are separate facts, and
  // conflating them would leave silence ambiguous.
  ctx.metric('cortext_kernel.invariant_audit_complete', {
    // A measured tally, not the list's length. If the catalog could not
    // be read nothing was inspected, so the count is 0 either way — but when it
    // WAS read this is now what the loop actually touched.
    checked: objectsChecked,
    findings: findings.length,
    catalogRead
  });
  return findings;
}

export { ARCHITECTURE_NAMESPACE, CORTEXT_NAMESPACE };
