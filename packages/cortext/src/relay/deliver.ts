/**
 * The relay's receiving side: a peer server hands over one message for a local agent.
 *
 * `deliver` runs as the peer's relay key, which holds no grant on the coordinator namespace, and a
 * relay mutation's transaction covers only `cortext-relay`. So the sender's identity and the
 * message are written through the committed coordinator dataset, not the guarded registry
 * entries, in an order that is safe to repeat: the identity first (an upsert, stamped with the
 * system actor `cortext:relay`), then the message (stamped with the peer's relay kid), which the
 * unique index on `(viaDomain, remoteId)` stores once however often it arrives.
 *
 * shortcut: on Postgres each deliver holds its relay frame's transaction connection while these
 * writes take another from the same pool, so as many concurrent deliveries as the pool has
 * connections stall the server. A virtual namespace does not avoid it (the engine still opens a
 * transaction for it); doing this work on the frame's own connection, through
 * `args.dataset.withScopedTransaction([mailNamespace])`, does, but the duplicate paths then need
 * advisory locks, since a unique violation aborts that transaction.
 */

import type {
  ActorIdentity,
  Dataset,
  EdgesStore,
  EngineHandle,
  FieldDef,
  RequestContext,
  ResolverArgs,
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

const SUBJECT_MAX_CHARS = 200;
const BODY_MAX_BYTES = 65_536;
/** messageId, from, to, instance and inReplyToRemoteId. */
const FIELD_MAX_CHARS = 256;
const RATE_PER_WINDOW = 60;
const RATE_WINDOW_MS = 60_000;

/** Stamped on remote AgentIdentity writes; a message is stamped with the peer's relay kid. */
const RELAY_ACTOR: ActorIdentity = { kind: 'system', id: 'cortext:relay' };

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
/** `<name>@<host>`: one `@`, both parts non-empty, no whitespace or control characters. */
const KID = /^[^@\s\p{Cc}]+@[^@\s\p{Cc}]+$/u;
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

function coordinator(rt: RelayRuntime): { engine: EngineHandle; ds: Dataset; edges: EdgesStore } {
  const ds = rt.engine?.datasetFor(rt.mailNamespace);
  if (rt.engine === undefined || ds === undefined || rt.edges === undefined) {
    throw new Error(`cortext relay: the '${rt.mailNamespace}' dataset is not available yet`);
  }
  return { engine: rt.engine, ds, edges: rt.edges };
}

const isUniqueViolation = (err: unknown): boolean =>
  isResolverFrameError(err) && err.code === 'unique_violation';

/**
 * One write through an autoCRUD resolver, stamped with `actor`, so validation, defaults, shortId
 * and crossRef edges are what a local write gets; then the write is announced, so subscriptions
 * and coordinator hooks hear of it as of a commit through `mutate`.
 */
async function coordinatorWrite(
  rt: RelayRuntime,
  actor: ActorIdentity,
  type: string,
  verb: 'create',
  params: Record<string, unknown>
): Promise<Row>;
async function coordinatorWrite(
  rt: RelayRuntime,
  actor: ActorIdentity,
  type: string,
  verb: 'update',
  params: Record<string, unknown>
): Promise<Row | null>;
async function coordinatorWrite(
  rt: RelayRuntime,
  actor: ActorIdentity,
  type: string,
  verb: 'create' | 'update',
  params: Record<string, unknown>
): Promise<Row | null> {
  const { engine, ds, edges } = coordinator(rt);
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
  const events: WriteEvent[] = [];
  const args: ResolverArgs = { params, dataset: ds, onWrite: (e) => events.push(e) };
  const row = await resolver(ctx, args);
  await engine.announceWrites(events, actor);
  return row;
}

async function identityByKid(ds: Dataset, kid: string): Promise<Row | undefined> {
  return (await ds.read('AgentIdentity', { where: { kid: { eq: kid } }, limit: 1 })).rows[0];
}

/**
 * The remote identity `entry.kid` of `domain`: created on first sight, otherwise made active and
 * given whichever of `displayName`, `project` and `description` the entry carries. A kid held by
 * a local identity or by another domain is `kid_collision`, naming both holders; it is never merged.
 */
export async function upsertRemoteIdentity(
  rt: RelayRuntime,
  domain: string,
  entry: RemoteIdentityEntry
): Promise<Row> {
  const { ds } = coordinator(rt);
  const described: Record<string, unknown> = {};
  for (const key of ['displayName', 'project', 'description'] as const) {
    if (entry[key] !== undefined) described[key] = entry[key];
  }
  let row = await identityByKid(ds, entry.kid);
  if (row === undefined) {
    try {
      return await coordinatorWrite(rt, RELAY_ACTOR, 'AgentIdentity', 'create', {
        kid: entry.kid,
        host: '',
        domain,
        active: true,
        ...described
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A concurrent first contact wrote the row; carry on with that one.
      row = await identityByKid(ds, entry.kid);
      if (row === undefined) throw err;
    }
  }
  if (isLocalIdentity(row) || row.domain !== domain) {
    const holder = isLocalIdentity(row) ? 'a local identity' : `an agent of ${String(row.domain)}`;
    throw new ResolverFrameError(
      'kid_collision',
      `kid '${entry.kid}' is held by ${holder} and claimed by ${domain}; it is not merged`,
      { kid: entry.kid, holder: isLocalIdentity(row) ? null : row.domain, claimant: domain }
    );
  }
  const current = row;
  const patch = Object.fromEntries(
    Object.entries({ active: true, ...described }).filter(([k, v]) => (current[k] ?? null) !== v)
  );
  if (Object.keys(patch).length === 0) return current;
  const updated = await coordinatorWrite(rt, RELAY_ACTOR, 'AgentIdentity', 'update', {
    id: current.id,
    ...patch
  });
  return updated ?? current;
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
    const peer = await requirePeer(rt, ctx);
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
    const { ds } = coordinator(rt);
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
      await upsertRemoteIdentity(rt, domain, { kid: p.from });
    } catch (err) {
      if (!isResolverFrameError(err) || err.code !== 'kid_collision') throw err;
      throw new ResolverFrameError(
        'foreign_sender',
        `deliver: '${p.from}' is not an agent of ${domain}`,
        { kid: p.from }
      );
    }
    const earlier = await relayedMessage(ds, domain, p.messageId);
    if (earlier !== undefined) return resultOf(earlier, true);

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
    try {
      // Stamped with the key that signed the delivery; the sender is `remoteFrom`.
      const signer: ActorIdentity = { kind: 'agent', id: String(peer.inboundKid) };
      return resultOf(await coordinatorWrite(rt, signer, 'AgentMessage', 'create', params), false);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A concurrent delivery of the same message won the insert.
      const winner = await relayedMessage(ds, domain, p.messageId);
      if (winner === undefined) throw err;
      return resultOf(winner, true);
    }
  };
}
