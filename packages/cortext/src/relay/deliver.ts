/**
 * The relay's receiving side: a peer server hands over one message for a local agent.
 *
 * `deliver` runs as the peer's relay key, which holds no grant on the coordinator namespace. Its
 * reads and writes of coordinator rows go straight to the coordinator dataset, not through the
 * guarded registry entries, and run inside the relay frame's own transaction: on Postgres that
 * is one connection per delivery, and a failed delivery leaves nothing behind. Under a lock on
 * the message, a repeat returns the first result; a new message gets its sender's identity
 * upserted (under a lock on the kid, stamped with the system actor `cortext:relay`) and is then
 * stored (stamped with the peer's relay kid). Locks are always taken message first, then kid. The
 * unique index on `(viaDomain, remoteId)` is the backstop.
 */

import type {
  ActorIdentity,
  Dataset,
  EdgesStore,
  EngineHandle,
  FieldDef,
  RequestContext,
  Row,
  TypedResolver,
  WriteEvent
} from '@mnmal-ai/substrate/sdk';
import {
  createResolverWithEdges,
  field,
  isResolverFrameError,
  ResolverFrameError,
  updateResolver
} from '@mnmal-ai/substrate/sdk';
import { isLocalIdentity } from '../participants.js';
import { RELAY_PROTOCOL_VERSION, requirePeer } from './namespace.js';
import type { RelayRuntime } from './runtime.js';

export const SUBJECT_MAX_CHARS = 200;
export const BODY_MAX_BYTES = 65_536;
/** messageId, from, to, instance and inReplyToRemoteId. */
const FIELD_MAX_CHARS = 256;
const RATE_PER_WINDOW = 60;
const RATE_WINDOW_MS = 60_000;

/**
 * Stamped on remote AgentIdentity writes and on the outbox's writes; a received message is stamped
 * with the peer's relay kid.
 */
export const RELAY_ACTOR: ActorIdentity = { kind: 'system', id: 'cortext:relay' };

export const DELIVER_PARAMS: Record<string, FieldDef> = {
  v: field.number(),
  messageId: field.string(),
  from: field.string(),
  to: field.string(),
  subject: field.string(),
  body: field.string({ indexed: false }),
  instance: field.string({ nullable: true }),
  inReplyToRemoteId: field.string({ nullable: true })
};

export const DELIVER_RETURNS: FieldDef = field.struct({
  id: field.string(),
  shortId: field.number(),
  duplicate: field.boolean()
});

/** A type alias rather than an interface, so it is assignable to the registry's `Row`. */
export type DeliverResult = { id: string; shortId: number; duplicate: boolean };

export interface RemoteIdentityEntry {
  kid: string;
  displayName?: string | null;
  project?: string | null;
  description?: string | null;
}

interface DeliverParams {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  instance?: string | null;
  inReplyToRemoteId?: string | null;
}

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v !== '';
const text = (v: unknown): boolean => typeof v === 'string';
const optional = (v: unknown): boolean => v == null || typeof v === 'string';
/**
 * `<name>@<host>`: one `@`, both parts non-empty, no whitespace, control or format characters
 * (bidi overrides, zero-width), since kids are shown to agents.
 */
const KID = /^[^@\s\p{Cc}\p{Cf}]+@[^@\s\p{Cc}\p{Cf}]+$/u;
const kid = (v: unknown): boolean => typeof v === 'string' && KID.test(v);
/** `v` is checked on its own, before anything else. */
const PARAM_SHAPES: Record<string, (v: unknown) => boolean> = {
  messageId: nonEmpty,
  from: kid,
  to: kid,
  subject: text,
  body: text,
  instance: optional,
  inReplyToRemoteId: optional
};

/**
 * Where coordinator reads and writes go inside a transaction: its dataset, its edges, and the
 * sink that announces the writes once it commits.
 */
export interface CoordinatorScope {
  ds: Dataset;
  edges: EdgesStore;
  onWrite?: (event: WriteEvent) => void;
}

function coordinator(rt: RelayRuntime): { engine: EngineHandle; ds: Dataset; edges: EdgesStore } {
  const ds = rt.engine?.datasetFor(rt.mailNamespace);
  if (rt.engine === undefined || ds === undefined || rt.edges === undefined) {
    throw new Error(`cortext relay: the '${rt.mailNamespace}' dataset is not available yet`);
  }
  return { engine: rt.engine, ds, edges: rt.edges };
}

/**
 * `fn` holding the lock `key`. On a Postgres transaction the lock lasts until the transaction
 * ends, so the next holder sees what this one committed. A store without locks relies on the
 * unique indexes alone.
 */
const locked = <T>(ds: Dataset, key: string, fn: () => Promise<T>): Promise<T> =>
  ds.withAdvisoryLock !== undefined ? ds.withAdvisoryLock(key, fn) : fn();

/**
 * `fn` on the coordinator dataset inside one transaction. `base` is a delivery frame's dataset,
 * whose transaction the coordinator joins (Postgres: the frame's one connection), or the committed
 * coordinator dataset, which opens a transaction of its own. A store that cannot share a
 * transaction across namespaces (memory) gets one on the coordinator dataset.
 */
function onTransaction<T>(
  rt: RelayRuntime,
  base: Dataset,
  fn: (ds: Dataset, edges: EdgesStore) => Promise<T>
): Promise<T> {
  const committed = coordinator(rt);
  if (base.withScopedTransaction !== undefined) {
    return base.withScopedTransaction([rt.mailNamespace], ({ datasets, edges }) => {
      const ds = datasets.get(rt.mailNamespace);
      if (ds === undefined) throw new Error(`cortext relay: no '${rt.mailNamespace}' in the scope`);
      return fn(ds, edges ?? committed.edges);
    });
  }
  return committed.ds.withTransaction((tx) => fn(tx, committed.edges));
}

/**
 * One write through an autoCRUD resolver, stamped with `actor`, so validation, defaults, shortId
 * and crossRef edges are what a local write gets. It goes to the scope's sink, which announces it
 * once the transaction commits, so subscriptions and coordinator hooks hear of it as of a commit
 * through `mutate`.
 */
async function coordinatorWrite(
  rt: RelayRuntime,
  scope: CoordinatorScope,
  actor: ActorIdentity,
  type: string,
  verb: 'create',
  params: Record<string, unknown>
): Promise<Row>;
async function coordinatorWrite(
  rt: RelayRuntime,
  scope: CoordinatorScope,
  actor: ActorIdentity,
  type: string,
  verb: 'update',
  params: Record<string, unknown>
): Promise<Row | null>;
async function coordinatorWrite(
  rt: RelayRuntime,
  scope: CoordinatorScope,
  actor: ActorIdentity,
  type: string,
  verb: 'create' | 'update',
  params: Record<string, unknown>
): Promise<Row | null> {
  const { engine } = coordinator(rt);
  const { ds, edges, onWrite } = scope;
  const fields = engine.typeEntry?.(rt.mailNamespace, type)?.fields;
  if (fields === undefined) throw new Error(`cortext relay: no ${rt.mailNamespace}/${type} type`);
  const resolver: TypedResolver<Row | null> =
    verb === 'create'
      ? createResolverWithEdges(type, ds, edges, { fields })
      : updateResolver(type, ds, edges, { fields });
  const ctx: RequestContext = {
    // The metadata stamp reads `agentKeyId` for an agent and `kind` for a system actor. The grant
    // is for this write alone: read is what the crossRef existence check needs.
    identity: {
      ...(actor.kind === 'agent' ? { agentKeyId: actor.id } : { kind: actor.kind }),
      id: actor.id,
      grants: { [rt.mailNamespace]: ['read', 'mutate'] }
    },
    namespace: rt.mailNamespace,
    operation: 'mutate',
    now: rt.now(),
    headers: {},
    meta: {}
  };
  return resolver(ctx, {
    params,
    dataset: ds,
    edges,
    ...(onWrite !== undefined ? { onWrite } : {})
  });
}

async function identityByKid(ds: Dataset, kid: string): Promise<Row | undefined> {
  return (await ds.read('AgentIdentity', { where: { kid: { eq: kid } }, limit: 1 })).rows[0];
}

/**
 * The remote identity `entry.kid` of `domain`: created on first sight, otherwise made active and
 * given whichever of `displayName`, `project` and `description` the entry carries. A kid held by
 * a local identity or by another domain is `kid_collision`, naming both holders; it is never merged.
 * Runs under a lock on the kid, whichever domain claims it, so concurrent claims serialise. With a
 * `scope` it runs in that transaction (a delivery's); without one, in a transaction of its own,
 * announced once it commits. A create that loses to a writer taking no lock (an operator's) fails
 * on the unique index and is not retried.
 */
export async function upsertRemoteIdentity(
  rt: RelayRuntime,
  domain: string,
  entry: RemoteIdentityEntry,
  scope?: CoordinatorScope
): Promise<Row> {
  if (scope !== undefined) return upsertIn(rt, scope, domain, entry);
  const events: WriteEvent[] = [];
  const onWrite = (e: WriteEvent) => void events.push(e);
  const row = await onTransaction(rt, coordinator(rt).ds, (ds, edges) =>
    upsertIn(rt, { ds, edges, onWrite }, domain, entry)
  );
  await coordinator(rt).engine.announceWrites(events, RELAY_ACTOR);
  return row;
}

function upsertIn(
  rt: RelayRuntime,
  scope: CoordinatorScope,
  domain: string,
  entry: RemoteIdentityEntry
): Promise<Row> {
  return locked(scope.ds, `cortext-relay:kid:${entry.kid}`, () =>
    upsertLocked(rt, scope, domain, entry)
  );
}

async function upsertLocked(
  rt: RelayRuntime,
  scope: CoordinatorScope,
  domain: string,
  entry: RemoteIdentityEntry
): Promise<Row> {
  const described: Record<string, unknown> = {};
  for (const key of ['displayName', 'project', 'description'] as const) {
    if (entry[key] !== undefined) described[key] = entry[key];
  }
  const row = await identityByKid(scope.ds, entry.kid);
  if (row === undefined) {
    return coordinatorWrite(rt, scope, RELAY_ACTOR, 'AgentIdentity', 'create', {
      kid: entry.kid,
      host: '',
      domain,
      active: true,
      ...described
    });
  }
  if (isLocalIdentity(row) || row.domain !== domain) {
    const holder = isLocalIdentity(row) ? 'a local identity' : `an agent of ${String(row.domain)}`;
    throw new ResolverFrameError(
      'kid_collision',
      `kid '${entry.kid}' is held by ${holder} and claimed by ${domain}; it is not merged`,
      { kid: entry.kid, holder: isLocalIdentity(row) ? null : row.domain, claimant: domain }
    );
  }
  const patch = Object.fromEntries(
    Object.entries({ active: true, ...described }).filter(([k, v]) => (row[k] ?? null) !== v)
  );
  if (Object.keys(patch).length === 0) return row;
  const updated = await coordinatorWrite(rt, scope, RELAY_ACTOR, 'AgentIdentity', 'update', {
    id: row.id,
    ...patch
  });
  return updated ?? row;
}

/** Declared params only, each of its expected shape. */
function readParams(params: Record<string, unknown>): DeliverParams {
  for (const key of Object.keys(params)) {
    if (!(key in DELIVER_PARAMS)) {
      throw new ResolverFrameError(
        'unknown_param',
        `deliver: unknown param '${key}'. Allowed: ${Object.keys(DELIVER_PARAMS).sort().join(', ')}.`,
        { field: key }
      );
    }
  }
  for (const [key, valid] of Object.entries(PARAM_SHAPES)) {
    if (!valid(params[key])) {
      throw new ResolverFrameError('invalid_param', `deliver: '${key}' is missing or malformed`, {
        field: key
      });
    }
  }
  return params as unknown as DeliverParams;
}

/** Deliveries per peer in the last minute, counted in this process with the relay's clock. */
function rateLimiter(now: () => Date): (peerId: string) => boolean {
  const recent = new Map<string, number[]>();
  return (peerId) => {
    const at = now().getTime();
    const kept = (recent.get(peerId) ?? []).filter((t) => t > at - RATE_WINDOW_MS);
    const allowed = kept.length < RATE_PER_WINDOW;
    if (allowed) kept.push(at);
    recent.set(peerId, kept);
    return allowed;
  };
}

async function relayedMessage(
  ds: Dataset,
  domain: string,
  remoteId: string
): Promise<Row | undefined> {
  const { rows } = await ds.read('AgentMessage', {
    where: { viaDomain: { eq: domain }, remoteId: { eq: remoteId } },
    limit: 1
  });
  return rows[0];
}

/** Mail this server sent (the row's own id), else mail this peer delivered earlier (its remoteId). */
async function parentId(ds: Dataset, domain: string, ref: string): Promise<string | undefined> {
  const own = (await ds.read('AgentMessage', { id: ref })).rows[0];
  const parent = own ?? (await relayedMessage(ds, domain, ref));
  return parent === undefined ? undefined : String(parent.id);
}

/** Whether `host`, in any case, is the host of an identity on this server. */
async function isLocalHost(ds: Dataset, host: string): Promise<boolean> {
  const wanted = host.toLowerCase();
  let cursor: string | undefined;
  do {
    const page = await ds.read('AgentIdentity', {
      where: { domain: { eq: null } },
      limit: 1000,
      ...(cursor !== undefined ? { cursor } : {})
    });
    if (page.rows.some((r) => isLocalIdentity(r) && String(r.host).toLowerCase() === wanted)) {
      return true;
    }
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return false;
}

const resultOf = (row: Row, duplicate: boolean): DeliverResult => ({
  id: String(row.id),
  shortId: Number(row.shortId),
  duplicate
});

export function deliverResolver(rt: RelayRuntime): TypedResolver<DeliverResult> {
  const withinRate = rateLimiter(rt.now);
  return async (ctx, args) => {
    const raw = args.params ?? {};
    if (raw.v !== RELAY_PROTOCOL_VERSION) {
      throw new ResolverFrameError(
        'unsupported_version',
        `deliver: protocol version ${String(raw.v)} is not supported; this server speaks ${RELAY_PROTOCOL_VERSION}`,
        { supported: RELAY_PROTOCOL_VERSION }
      );
    }
    // The writes go to the frame's sink, which announces them after the frame commits.
    const sink = args.onWrite !== undefined ? { onWrite: args.onWrite } : {};
    return onTransaction(rt, args.dataset ?? coordinator(rt).ds, (ds, edges) =>
      deliverIn(rt, ctx, raw, { ds, edges, ...sink }, withinRate)
    );
  };
}

async function deliverIn(
  rt: RelayRuntime,
  ctx: RequestContext,
  raw: Record<string, unknown>,
  scope: CoordinatorScope,
  withinRate: (peerId: string) => boolean
): Promise<DeliverResult> {
  const { ds } = scope;
  const peer = await requirePeer(rt, ctx, ds);
  const domain = String(peer.domain);
  const p = readParams(raw);
  const short = [p.messageId, p.from, p.to, p.instance, p.inReplyToRemoteId];
  if (
    short.some((v) => v != null && [...v].length > FIELD_MAX_CHARS) ||
    [...p.subject].length > SUBJECT_MAX_CHARS ||
    Buffer.byteLength(p.body) > BODY_MAX_BYTES
  ) {
    throw new ResolverFrameError(
      'too_large',
      `deliver: a subject holds at most ${SUBJECT_MAX_CHARS} characters, a body at most ${BODY_MAX_BYTES} bytes, and messageId, from, to, instance and inReplyToRemoteId at most ${FIELD_MAX_CHARS} characters each`
    );
  }
  if (!withinRate(String(peer.id))) {
    throw new ResolverFrameError(
      'rate_limited',
      `deliver: ${domain} has delivered ${RATE_PER_WINDOW} messages in the last minute; retry later`
    );
  }
  // Deliveries of one message take turns. A repeat returns the first result and changes nothing,
  // even if the recipient or the sender has changed since, so a lost response is never bounced.
  return locked(ds, `cortext-relay:message:${domain}:${p.messageId}`, async () => {
    const earlier = await relayedMessage(ds, domain, p.messageId);
    if (earlier !== undefined) return resultOf(earlier, true);
    // Only an active agent of this server; nothing is forwarded onward.
    const recipient = await identityByKid(ds, p.to);
    if (recipient === undefined || recipient.active !== true || !isLocalIdentity(recipient)) {
      throw new ResolverFrameError(
        'unknown_recipient',
        `deliver: '${p.to}' is not an active agent on this server`,
        { kid: p.to }
      );
    }
    // A peer names senders on its own machines, never on this server's.
    if (await isLocalHost(ds, p.from.slice(p.from.indexOf('@') + 1))) {
      throw new ResolverFrameError(
        'foreign_sender',
        `deliver: '${p.from}' names a host of this server`,
        { kid: p.from }
      );
    }
    try {
      await upsertRemoteIdentity(rt, domain, { kid: p.from }, scope);
    } catch (err) {
      if (!isResolverFrameError(err) || err.code !== 'kid_collision') throw err;
      throw new ResolverFrameError(
        'foreign_sender',
        `deliver: '${p.from}' is not an agent of ${domain}`,
        { kid: p.from }
      );
    }
    const inReplyTo =
      p.inReplyToRemoteId != null ? await parentId(ds, domain, p.inReplyToRemoteId) : undefined;
    // No tags: relayed mail is never urgent and never a broadcast.
    const params: Record<string, unknown> = {
      recipient: recipient.id,
      subject: p.subject,
      body: p.body,
      remoteFrom: p.from,
      viaDomain: domain,
      remoteId: p.messageId,
      ...(p.instance != null ? { instance: p.instance } : {}),
      ...(inReplyTo !== undefined ? { inReplyTo } : {})
    };
    // Stamped with the key that signed the delivery; the sender is `remoteFrom`.
    const signer: ActorIdentity = { kind: 'agent', id: String(peer.inboundKid) };
    const row = await coordinatorWrite(rt, scope, signer, 'AgentMessage', 'create', params);
    return resultOf(row, false);
  });
}
