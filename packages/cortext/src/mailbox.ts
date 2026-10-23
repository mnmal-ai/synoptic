/**
 * claude/AgentMessage mutation family — the mailbox write + transition surface.
 *
 * Three custom mutations replace the autoCRUD write paths for AgentMessage:
 *
 *   - `sendAgentMessage`  — kid-addressed send with fan-out. `to` accepts a
 *     single kid, a list of kids, or `'*'` (every active AgentIdentity except
 *     the sender). One row per recipient; `recipient: null` broadcasts are
 *     retired (cohort-global read-state made the first reader hide an
 *     announcement from everyone else).
 *   - `markAgentMessageRead` / `ackAgentMessage` — recipient-only status
 *     transitions. Ack stamps `ackedBy` / `ackedAt` server-side so attribution
 *     survives later row edits (`updatedBy` is too coarse: any field update
 *     smudges it).
 *
 * Direct `createAgentMessage` is not registered at all — AgentMessage declares
 * `autoCrud: false`, so the published schema cannot advertise a mutation the
 * route only denies (a caller reading the schema built a shape that could never
 * work, and the refusal looked like a grant problem). `mailboxWriteGuard` still
 * denies transition-field patches through `updateAgentMessage`, and keeps its
 * create branch as the second line of defence for any path that re-registers
 * the verb — the mutation family remains the only write path, which is what
 * enforces kid addressing rather than documenting it.
 *
 * The sender remains `_metadata.createdBy` (server-stamped from the signed
 * principal; spec §3) — fan-out does not change the trust model.
 */

import type {
  Dataset,
  FieldDef,
  NamespaceInstallContext,
  Policy,
  RequestContext,
  ResolverArgs,
  Row,
  TypedResolver
} from '@mnmal-ai/substrate/sdk';
import {
  and,
  createResolverWithEdges,
  deleteResolver,
  denyAll,
  field,
  getResolver,
  listResolver,
  or,
  RESERVED_AUTOCRUD_FIELDS,
  ResolverFrameError,
  requireIdentity,
  resolveEntityRow,
  resolveIdentity,
  updateResolver
} from '@mnmal-ai/substrate/sdk';
import { messageParticipantsOnly } from './participants.js';

const TYPE = 'AgentMessage';
const DIRECTORY_TYPE = 'AgentIdentity';

/**
 * Fields whose writes are reserved to the transition mutations. Checked by
 * `mailboxWriteGuard` against update params; there is no create verb to deny
 * wholesale — the mutation is not registered.
 */
const TRANSITION_FIELDS = ['status', 'ackedBy', 'ackedAt'] as const;

/**
 * Fields written once, by sendAgentMessage, and never edited. `instance`
 * is the sender's own account of which writer it was; letting a later update
 * change it would make it say whatever the last editor wanted.
 */
const SEND_ONLY_FIELDS = ['instance'] as const;

/**
 * The only fields updateAgentMessage may write. Everything else a
 * message carries is fixed at send; a denylist would let any agent rewrite
 * `recipient` to its own identity row and then ack, or edit `body` after delivery.
 * `id` addresses the row; `_`-prefixed keys are request controls, not fields.
 */
const UPDATABLE_FIELDS: ReadonlySet<string> = new Set(['id', 'archived', 'tags']);

/**
 * sendAgentMessage's introspection/registration param schema. `to`
 * wire-accepts a single kid string, a list of kids, or '*' (broadcast to
 * every active identity except the sender); declared as list-of-string for
 * introspection, the resolver normalises at runtime.
 */
const SEND_PARAMS: Record<string, FieldDef> = {
  to: field.list(field.string()),
  subject: field.string(),
  body: field.string({ indexed: false }),
  inReplyTo: field.string({ nullable: true }),
  tags: field.list(field.string(), { nullable: true }),
  instance: field.string({ nullable: true })
};

/**
 * Runtime allowlist derived from the declared params — one
 * authoritative declaration, so the schema can never advertise a param the
 * resolver rejects (or vice versa).
 */
const SEND_PARAM_NAMES: ReadonlySet<string> = new Set(Object.keys(SEND_PARAMS));

/**
 * Upper bound on a directory read. The cohort is ~10 identities; 1000 exists
 * so a `'*'` fan-out can never be silently truncated by a kernel default
 * limit, not because that scale is anticipated.
 */
const DIRECTORY_READ_LIMIT = 1000;

/**
 * Policy over AgentMessage's hand-registered surface — `installMailboxMutations`
 * composes it with the plugin policy, the way defineNamespace composes type
 * policies for autoCRUD types. Retires the direct write paths:
 *   - create → always denied. The verb is not registered (autoCrud:false), so
 *     this branch only fires if something re-registers it; the schema never
 *     advertises it.
 *   - update → only archived and tags may change; a transition field
 *     or anything fixed at send is denied, each with its own reason.
 */
export const mailboxWriteGuard: Policy = (ctx, args) => {
  // Messages name the caller's own namespace, never a hard-coded one: they
  // tell the caller which mutation to use instead.
  const ns = ctx.namespace;
  if (ctx.verb === 'create') {
    return {
      allow: false,
      reason:
        `${ns}/AgentMessage: direct createAgentMessage is retired — use ${ns}/sendAgentMessage ` +
        "(kid-addressed; to: '<kid>' | ['<kid>', …] | '*')"
    };
  }
  if (ctx.verb === 'update') {
    const params = args.params ?? {};
    for (const fieldName of TRANSITION_FIELDS) {
      if (fieldName in params) {
        return {
          allow: false,
          reason:
            `${ns}/AgentMessage: '${fieldName}' transitions only via ${ns}/markAgentMessageRead / ` +
            `${ns}/ackAgentMessage (recipient-only)`
        };
      }
    }
    for (const fieldName of SEND_ONLY_FIELDS) {
      if (fieldName in params) {
        return {
          allow: false,
          reason: `${ns}/AgentMessage: '${fieldName}' is set once by ${ns}/sendAgentMessage and cannot be edited`
        };
      }
    }
    for (const fieldName of Object.keys(params)) {
      if (UPDATABLE_FIELDS.has(fieldName) || fieldName.startsWith('_')) continue;
      return {
        allow: false,
        reason:
          `${ns}/AgentMessage: '${fieldName}' is fixed at send; updateAgentMessage may change only ` +
          `archived and tags. Reply with ${ns}/sendAgentMessage instead.`
      };
    }
  }
  return { allow: true };
};

/**
 * Resolve the `to` param into directory rows, validate-first so a bad address
 * rejects before any row is written:
 *   - wildcard (`['*']` canonical; bare `'*'` accepted as sugar) → every
 *     active identity except the sender; empty → no_recipients. Mixing the
 *     wildcard with explicit kids is ambiguous → wildcard_mixed.
 *   - kid / kid[] → deduped; unknown kid → unknown_recipient; inactive →
 *     inactive_recipient.
 */
/**
 * Whether `to:'*'` should fan a copy out to this identity.
 *
 * ABSENT AND NULL BOTH MEAN ELIGIBLE, and that is the whole reason this is a
 * predicate rather than a `where` clause. `broadcastEligible` is declared
 * `default: true`, but a default is applied on WRITE — every AgentIdentity row
 * created before the field existed carries no such key and reads back as
 * `null`.
 *
 * So `where: { broadcastEligible: { eq: true } }` would match NONE of them
 * (and `eq: null` matches nothing either, under SQL three-valued logic),
 * turning every broadcast into `no_recipients`. Opting OUT has to be an
 * explicit `false`.
 *
 * Exported because it cannot be exercised through `createAgentIdentity`: that
 * path applies the declared default, so a row written through the schema always
 * carries the key. The pre-field shape is only reachable directly, which is
 * what `mailbox-broadcast-eligibility.test.ts` does.
 */
export function isBroadcastEligible(row: Record<string, unknown>): boolean {
  return row.broadcastEligible !== false;
}

async function resolveRecipients(
  ds: Dataset,
  to: unknown,
  senderId: string,
  ns: string
): Promise<Row[]> {
  const list = Array.isArray(to) ? to : [to];
  if (list.includes('*')) {
    if (list.length > 1) {
      throw new ResolverFrameError(
        'wildcard_mixed',
        "sendAgentMessage: the '*' wildcard cannot be combined with explicit kids — it already reaches every active identity",
        { field: 'to' }
      );
    }
    const { rows } = await ds.read(DIRECTORY_TYPE, {
      where: { active: { eq: true } },
      limit: DIRECTORY_READ_LIMIT
    });
    // `Row`'s index signature surfaces kid/active as `unknown` — the runtime
    // equality/typeof guards do the real narrowing.
    const others = rows.filter((r) => r.kid !== senderId);

    // Broadcast eligibility is filtered HERE rather than in the `where` above,
    // and that is deliberate. `broadcastEligible` defaults true, but a
    // default applies on WRITE — every row predating the field has no such key,
    // so `where: { broadcastEligible: { eq: true } }` would match none of them
    // (and `eq: null` matches nothing either, under SQL three-valued logic).
    // Filtering in the query would have turned every broadcast into a
    // `no_recipients` error until the whole directory was backfilled. `!== false`
    // treats absent as eligible, which is both the correct default and immune to
    // a half-applied migration.
    const eligible = others.filter(isBroadcastEligible);
    if (eligible.length === 0) {
      // The two exhaustion cases are distinguished because the remedies are
      // opposite: "nobody else is active" means the directory is empty, while
      // "everyone else is opted out" means a broadcastEligible flag is set too
      // widely. Collapsing them would send an operator to the wrong field.
      throw new ResolverFrameError(
        'no_recipients',
        others.length === 0
          ? "sendAgentMessage: to:'*' found no active cortext/AgentIdentity besides the sender"
          : `sendAgentMessage: to:'*' found ${others.length} active cortext/AgentIdentity ` +
              'besides the sender, but all of them have broadcastEligible: false',
        { sender: senderId, active: others.length }
      );
    }
    return eligible;
  }

  if (list.length === 0 || !list.every((k) => typeof k === 'string' && k.length > 0)) {
    throw new ResolverFrameError(
      'missing_required_field',
      "sendAgentMessage: params.to must be a kid, a non-empty list of kids, or ['*']",
      { field: 'to' }
    );
  }
  const kids = [...new Set(list as string[])];
  const { rows } = await ds.read(DIRECTORY_TYPE, {
    where: { kid: { in: kids } },
    limit: DIRECTORY_READ_LIMIT
  });
  const byKid = new Map<string, Row>();
  for (const r of rows) {
    const kid = String(r.kid);
    // kid is the directory's natural key (pg enforces this via
    // the 0004 partial unique index; this guard covers in-memory-store
    // deployments). Silently picking one of the duplicates would route mail
    // — and the recipient-only transition right — non-deterministically.
    if (byKid.has(kid)) {
      throw new ResolverFrameError(
        'ambiguous_recipient',
        `sendAgentMessage: kid '${kid}' matches more than one ${ns}/AgentIdentity row — directory uniqueness is violated; resolve the duplicate before sending`,
        { kid }
      );
    }
    byKid.set(kid, r);
  }
  return kids.map((kid) => {
    const row = byKid.get(kid);
    if (row === undefined) {
      throw new ResolverFrameError(
        'unknown_recipient',
        `sendAgentMessage: no ${ns}/AgentIdentity row with kid '${kid}'`,
        { kid }
      );
    }
    if (row.active !== true) {
      throw new ResolverFrameError(
        'inactive_recipient',
        `sendAgentMessage: identity '${kid}' is inactive — messages to retired identities are refused`,
        { kid }
      );
    }
    return row;
  });
}

function sendResolver(
  installCtx: NamespaceInstallContext,
  createMessage: TypedResolver<Row>
): TypedResolver<Row[]> {
  return async (ctx: RequestContext, args: ResolverArgs): Promise<Row[]> => {
    const params = args.params ?? {};
    for (const key of Object.keys(params)) {
      if (!SEND_PARAM_NAMES.has(key)) {
        throw new ResolverFrameError(
          'unknown_field',
          `sendAgentMessage: unknown param '${key}'. Allowed: ${[...SEND_PARAM_NAMES].sort().join(', ')}.`,
          { field: key }
        );
      }
    }

    const ds = args.dataset ?? installCtx.dataset;
    const actor = resolveIdentity(ctx);
    const recipients = await resolveRecipients(ds, params.to, actor.id, ctx.namespace);

    // Delegate each row write to the edge-aware autoCRUD create resolver —
    // field validation, enum/default handling, metadata stamping, shortId
    // allocation, AND crossRef edge emission all stay single-sourced (edges
    // derive from the declared field defs, so a third crossRef on
    // AgentMessage fans out edges without this file changing). The
    // per-recipient creates are mutually independent, so they run
    // concurrently; Promise.all preserves recipient order in
    // the returned list, and the engine's G1 tx wraps the whole frame so a
    // rejection mid-fan-out rolls back every row.
    return Promise.all(
      recipients.map((recipient) => {
        const rowParams: Record<string, unknown> = {
          recipient: recipient.id,
          subject: params.subject,
          body: params.body
        };
        if (params.inReplyTo !== undefined) rowParams.inReplyTo = params.inReplyTo;
        if (params.tags !== undefined) rowParams.tags = params.tags;
        if (params.instance !== undefined) rowParams.instance = params.instance;
        return createMessage(ctx, { ...args, params: rowParams });
      })
    );
  };
}

type TransitionTarget = 'read' | 'acked';

interface TransitionSpec {
  /** Mutation name — error messages and registration share it. */
  mutationName: string;
  /**
   * Statuses for which the call is an idempotent no-op (returns the row
   * unchanged). Doubles as the no-downgrade guard: markRead on read/acked
   * does nothing; re-ack preserves the original attribution.
   */
  isNoOp: (status: unknown) => boolean;
  /** Server-stamped fields written alongside `status` itself. */
  stamp: (actor: { id: string }, at: string) => Record<string, unknown>;
}

/**
 * One entry per transition: the Record forces exhaustiveness —
 * adding a TransitionTarget without a spec is a compile error rather than a
 * silent no-op.
 */
const TRANSITIONS: Record<TransitionTarget, TransitionSpec> = {
  read: {
    mutationName: 'markAgentMessageRead',
    isNoOp: (status) => status !== 'unread',
    stamp: () => ({})
  },
  acked: {
    mutationName: 'ackAgentMessage',
    isNoOp: (status) => status === 'acked',
    stamp: (actor, at) => ({ ackedBy: actor.id, ackedAt: at })
  }
};

function transitionResolver(
  installCtx: NamespaceInstallContext,
  target: TransitionTarget
): TypedResolver<Row | null> {
  const { mutationName: name, isNoOp, stamp } = TRANSITIONS[target];
  return async (ctx: RequestContext, args: ResolverArgs): Promise<Row | null> => {
    const params = args.params ?? {};
    for (const key of Object.keys(params)) {
      if (key !== 'id') {
        throw new ResolverFrameError(
          'unknown_param',
          `${name}: unknown param '${key}'. Allowed: id.`,
          { field: key }
        );
      }
    }
    const ds = args.dataset ?? installCtx.dataset;
    const raw = params.id;
    const id = typeof raw === 'string' || typeof raw === 'number' ? raw : undefined;
    if (id === undefined) {
      throw new ResolverFrameError('missing_id', `${name}: params.id is required`, {
        field: 'id'
      });
    }

    // Short-form ids resolve like every other autoCRUD mutation; id-miss is a
    // silent null per the update<T> contract. The row-shaped variant avoids
    // re-reading the row resolveEntityId had already fetched —
    // this resolver needs its content (status/recipient) below.
    const message = await resolveEntityRow(ds, TYPE, id);
    if (message === null) return null;

    const recipientId = message.recipient;
    if (typeof recipientId !== 'string' || recipientId.length === 0) {
      throw new ResolverFrameError(
        'no_recipient',
        `${name}: message has no resolvable recipient (broadcast-era or orphaned row) — transitions are recipient-only`,
        { id: message.id }
      );
    }
    const { rows: identityRows } = await ds.read(DIRECTORY_TYPE, { id: recipientId });
    const identityRow = identityRows[0];
    if (identityRow === undefined) {
      throw new ResolverFrameError(
        'no_recipient',
        `${name}: the recipient identity row no longer exists`,
        { id: message.id }
      );
    }

    // Recipient-only enforcement: the caller's signed principal
    // must BE the addressee. A sender acking its own outbound message is
    // always a bug.
    const actor = resolveIdentity(ctx);
    if (actor.id !== identityRow.kid) {
      throw new ResolverFrameError(
        'not_recipient',
        `${name}: only the recipient ('${String(identityRow.kid)}') may transition this message`,
        { recipient: identityRow.kid }
      );
    }

    // Compare-and-set on the status this read saw: two sessions sharing a kid
    // can transition one message concurrently, and an unconditional write let
    // a mark-read land after an ack and move it back to `read`. On a miss the
    // row is re-read, so the loser re-checks against the winner's status.
    // Bypassing updateResolver is deliberate: ackedAt is serverSet and would
    // be rejected by its client-field guard; here it is system-stamped.
    let current: Row | null = message;
    for (let attempt = 0; attempt < 3 && current !== null; attempt++) {
      if (isNoOp(current.status)) return current;
      const { matched, row } = await ds.conditionalUpdate(
        TYPE,
        current.id as string,
        { status: current.status },
        { status: target, ...stamp(actor, ctx.now.toISOString()) },
        actor,
        ctx.now
      );
      if (matched && row !== null) {
        args.onWrite?.({ ns: ds.namespace, type: TYPE, id: row.id, operation: 'update', row });
        return row;
      }
      current = await resolveEntityRow(ds, TYPE, message.id as string);
    }
    if (current === null) return null;
    throw new ResolverFrameError(
      'conflict',
      `${name}: the message kept changing while it was being transitioned; retry`,
      { id: message.id }
    );
  };
}

/**
 * Register AgentMessage's whole surface. The type declares `autoCrud: false`,
 * so defineNamespace installed nothing for it and this function owns the lot:
 * the type entry, get/update/delete — same resolvers and same params/returns
 * installAutoCrud would have emitted — plus the custom family (sendAgentMessage,
 * markAgentMessageRead, ackAgentMessage). What is deliberately absent is
 * `createAgentMessage`: an advertised mutation the route only denies teaches
 * callers to build a shape that cannot work, and the refusal reads like a
 * grant problem. Field defs arrive pre-augmentation; the reserved engine
 * fields are added here, the way defineNamespace adds them for autoCRUD types.
 */
export function installMailboxMutations(
  ctx: NamespaceInstallContext,
  messageFields: Record<string, FieldDef>
): void {
  const fields: Record<string, FieldDef> = { ...messageFields, ...RESERVED_AUTOCRUD_FIELDS };

  // Same layering defineNamespace applies to autoCRUD types: plugin policy
  // composed over the type policy. mailboxWriteGuard keeps its create branch
  // as the second line of defence for any path that re-registers the verb.
  const writePolicy: Policy =
    ctx.pluginPolicy === undefined ? mailboxWriteGuard : and(ctx.pluginPolicy, mailboxWriteGuard);

  ctx.registry.register(TYPE, {
    resolver: listResolver(TYPE, ctx.dataset, { fields }),
    kind: 'type',
    policy: writePolicy,
    fields
  });

  ctx.registry.register(`get${TYPE}`, {
    resolver: getResolver(TYPE, ctx.dataset),
    kind: 'mutation',
    verb: 'get',
    params: { id: field.string() },
    returns: field.struct(fields, { nullable: true }),
    policy: writePolicy,
    fields
  });

  ctx.registry.register(`update${TYPE}`, {
    // Field allow-list in the policy; WHO may archive or retag in the wrapper,
    // which reads the row.
    resolver: messageParticipantsOnly(
      ctx,
      `update${TYPE}`,
      updateResolver(TYPE, ctx.dataset, ctx.edges, { fields })
    ),
    kind: 'mutation',
    verb: 'update',
    // Full field set so clients can introspect what is assignable; the
    // resolver decides at runtime which fields to apply.
    params: { id: field.string(), ...fields },
    returns: field.struct(fields, { nullable: true }),
    policy: writePolicy,
    fields
  });

  ctx.registry.register(`delete${TYPE}`, {
    resolver: messageParticipantsOnly(
      ctx,
      `delete${TYPE}`,
      deleteResolver(TYPE, ctx.dataset, ctx.edges)
    ),
    kind: 'mutation',
    verb: 'delete',
    params: { id: field.string() },
    returns: field.struct({ id: field.string(), deleted: field.boolean() }),
    policy: writePolicy
    // No `fields`: mirrors autoCRUD — a delete returns {id, deleted}, and
    // carrying the type's field map would imply arbitrary field selection.
  });

  // Edge-aware create: crossRef edges derive from the threaded field defs
  // exactly as autoCRUD's create<T> does, so the mailbox cannot drift from
  // the declared schema.
  const createMessage = createResolverWithEdges(TYPE, ctx.dataset, ctx.edges, { fields });

  // An anonymous send has no principal to stamp as the sender — the trust
  // model (spec §3) collapses. Denied regardless of the operator's auth
  // posture; or() surfaces the actionable deny reason.
  const requireSender = or(
    requireIdentity(),
    denyAll(
      'sendAgentMessage requires an authenticated identity — the sender is the signed principal (spec §3)'
    )
  );
  const sendPolicy =
    ctx.pluginPolicy !== undefined ? and(ctx.pluginPolicy, requireSender) : requireSender;
  // Transitions rely on the resolver's recipient check (an anonymous caller
  // can never match a kid); plugin-level policy still composes.
  const transitionPolicy = ctx.pluginPolicy;

  const messageStruct = field.struct(fields);

  // Semantic verbs ('create' / 'update') are stamped even though these are
  // custom mutations so verb-keyed posture policies (deny writes, deny
  // updates) compose over the mailbox exactly as over autoCRUD.
  ctx.registry.register('sendAgentMessage', {
    resolver: sendResolver(ctx, createMessage),
    kind: 'mutation',
    verb: 'create',
    params: SEND_PARAMS,
    returns: field.list(messageStruct),
    policy: sendPolicy,
    fields
  });

  // Registration iterates the TRANSITIONS record so the mutation names
  // single-source from the specs — a new transition registers (and names
  // itself) by existing.
  for (const [target, spec] of Object.entries(TRANSITIONS) as Array<
    [TransitionTarget, TransitionSpec]
  >) {
    ctx.registry.register(spec.mutationName, {
      resolver: transitionResolver(ctx, target),
      kind: 'mutation',
      verb: 'update',
      params: { id: field.string() },
      returns: field.struct(fields, { nullable: true }),
      ...(transitionPolicy !== undefined ? { policy: transitionPolicy } : {}),
      fields
    });
  }
}
