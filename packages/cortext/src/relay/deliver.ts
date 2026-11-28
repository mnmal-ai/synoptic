/**
 * The relay's receiving side: a peer server hands over one message for a local agent.
 *
 * `deliver` runs as the peer's relay key, which holds no grant on the coordinator namespace. Its
 * reads and writes of coordinator rows go straight to the coordinator dataset, not through the
 * guarded registry entries, and run inside the relay frame's own transaction: on Postgres that
 * is one connection per delivery, and a failed delivery leaves nothing behind. Under a lock on
 * the message, a repeat returns the first result; a new message gets its sender's identity
 * created if it has none, an existing one being left as it is (under a lock on the kid, stamped
 * with the system actor `cortext:relay`), and is then stored (stamped with the peer's relay kid).
 * Locks are always taken message first, then kid. The unique index on `(viaDomain, remoteId)` is
 * the backstop.
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
export const FIELD_MAX_CHARS = 256;
const RATE_PER_WINDOW = 60;
const RATE_WINDOW_MS = 60_000;
/** New sender identities a peer may create per hour. */
const NEW_SENDERS_PER_WINDOW = 20;
const NEW_SENDERS_WINDOW_MS = 3_600_000;
const UNSAFE = /[\p{Cc}\p{Cf}]/gu;

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
  listed?: boolean;
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
 * `<name>@<host>`: printable ASCII only (U+0021 to U+007E), one `@`, both parts non-empty, at most
 * 128 characters. Kids are shown to agents, so no look-alike or invisible characters.
 */
const KID = /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+$/;
const KID_MAX_CHARS = 128;
export const isKid = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= KID_MAX_CHARS && KID.test(v);
/** `v` is checked on its own, before anything else. */
const PARAM_SHAPES: Record<string, (v: unknown) => boolean> = {
  messageId: nonEmpty,
  from: isKid,
  to: isKid,
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
 * The remote identity `entry.kid` of `domain`: created active on first sight, after
 * `beforeCreate`, which may throw to refuse it; otherwise given whichever of `listed`,
 * `displayName`, `project` and `description` the entry carries. Never changes `active`.
 * A kid held by a local identity or by another domain is `kid_collision`, naming both holders; it
 * is never merged. Otherwise a kid whose host, in any case, is the machine of a local identity is
 * `local_host`: a peer names agents on its own machines, never on this server's. Runs under a lock
 * on the kid, whichever domain claims it, so concurrent claims serialise. With a `scope` it runs in
 * that transaction (a delivery's); without one, in a transaction of its own, announced once it
 * commits. Never call the form without a scope from inside a frame's resolver: its transaction
 * would take a second pooled connection beside the frame's. A create that loses to a writer taking
 * no lock (an operator's) fails on the unique index and is not retried.
 */
export async function upsertRemoteIdentity(
  rt: RelayRuntime,
  domain: string,
  entry: RemoteIdentityEntry,
  scope?: CoordinatorScope,
  beforeCreate?: () => void
): Promise<Row> {
  if (scope !== undefined) return upsertIn(rt, scope, domain, entry, beforeCreate);
  const events: WriteEvent[] = [];
  const onWrite = (e: WriteEvent) => void events.push(e);
  const row = await onTransaction(rt, coordinator(rt).ds, (ds, edges) =>
    upsertIn(rt, { ds, edges, onWrite }, domain, entry, beforeCreate)
  );
  await coordinator(rt).engine.announceWrites(events, RELAY_ACTOR);
  return row;
}

function upsertIn(
  rt: RelayRuntime,
  scope: CoordinatorScope,
  domain: string,
  entry: RemoteIdentityEntry,
  beforeCreate?: () => void
): Promise<Row> {
  return locked(scope.ds, `cortext-relay:kid:${entry.kid}`, () =>
    upsertLocked(rt, scope, domain, entry, beforeCreate)
  );
}

async function upsertLocked(
  rt: RelayRuntime,
  scope: CoordinatorScope,
  domain: string,
  entry: RemoteIdentityEntry,
  beforeCreate?: () => void
): Promise<Row> {
  const given: Record<string, unknown> = {};
  for (const key of ['listed', 'displayName', 'project', 'description'] as const) {
    if (entry[key] !== undefined) given[key] = entry[key];
  }
  const row = await identityByKid(scope.ds, entry.kid);
  if (row !== undefined && (isLocalIdentity(row) || row.domain !== domain)) {
    const holder = isLocalIdentity(row) ? 'a local identity' : `an agent of ${String(row.domain)}`;
    throw new ResolverFrameError(
      'kid_collision',
      `kid '${entry.kid}' is held by ${holder} and claimed by ${domain}; it is not merged`,
      { kid: entry.kid, holder: isLocalIdentity(row) ? null : row.domain, claimant: domain }
    );
  }
  if (await isLocalHost(scope.ds, entry.kid.slice(entry.kid.indexOf('@') + 1))) {
    throw new ResolverFrameError(
      'local_host',
      `kid '${entry.kid}' names a host of this server and is claimed by ${domain}`,
      { kid: entry.kid, claimant: domain }
    );
  }
  if (row === undefined) {
    beforeCreate?.();
    return coordinatorWrite(rt, scope, RELAY_ACTOR, 'AgentIdentity', 'create', {
      kid: entry.kid,
      host: '',
      domain,
      active: true,
      ...given
    });
  }
  const patch = Object.fromEntries(
    Object.entries(given).filter(([k, v]) => (row[k] ?? null) !== v)
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

/**
 * Whether a peer has used fewer than `limit` in the last `windowMs`, counting this use if so;
 * counted in this process with the relay's clock.
 */
function rateLimiter(
  now: () => Date,
  limit: number,
  windowMs: number
): (peerId: string) => boolean {
  const recent = new Map<string, number[]>();
  return (peerId) => {
    const at = now().getTime();
    const kept = (recent.get(peerId) ?? []).filter((t) => t > at - windowMs);
    const allowed = kept.length < limit;
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

/** The part of a kid after `@`, or '' without one. */
const kidHost = (kid: unknown): string => {
  const s = String(kid);
  const at = s.indexOf('@');
  return at === -1 ? '' : s.slice(at + 1);
};

/**
 * Whether `host`, in any case, is the machine of an identity on this server: its `host` field or
 * the host part of its kid.
 */
async function isLocalHost(ds: Dataset, host: string): Promise<boolean> {
  const wanted = host.toLowerCase();
  const isWanted = (h: string): boolean => h.toLowerCase() === wanted;
  let cursor: string | undefined;
  do {
    const page = await ds.read('AgentIdentity', {
      where: { domain: { eq: null } },
      limit: 1000,
      ...(cursor !== undefined ? { cursor } : {})
    });
    if (
      page.rows.some(
        (r) => isLocalIdentity(r) && (isWanted(String(r.host)) || isWanted(kidHost(r.kid)))
      )
    ) {
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
  const withinRate = rateLimiter(rt.now, RATE_PER_WINDOW, RATE_WINDOW_MS);
  const withinNewSenders = rateLimiter(rt.now, NEW_SENDERS_PER_WINDOW, NEW_SENDERS_WINDOW_MS);
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
      deliverIn(rt, ctx, raw, { ds, edges, ...sink }, withinRate, withinNewSenders)
    );
  };
}

async function deliverIn(
  rt: RelayRuntime,
  ctx: RequestContext,
  raw: Record<string, unknown>,
  scope: CoordinatorScope,
  withinRate: (peerId: string) => boolean,
  withinNewSenders: (peerId: string) => boolean
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
    // A sender's existing row is left as it is; a new one uses the peer's new-sender budget.
    const admitNewSender = (): void => {
      if (withinNewSenders(String(peer.id))) return;
      throw new ResolverFrameError(
        'rate_limited',
        `deliver: ${domain} has introduced ${NEW_SENDERS_PER_WINDOW} new senders in the last hour; retry later`
      );
    };
    let sender: Row;
    try {
      sender = await upsertRemoteIdentity(rt, domain, { kid: p.from }, scope, admitNewSender);
    } catch (err) {
      const code = isResolverFrameError(err) ? err.code : undefined;
      if (code !== 'kid_collision' && code !== 'local_host') throw err;
      const why =
        code === 'local_host' ? 'names a host of this server' : `is not an agent of ${domain}`;
      throw new ResolverFrameError('foreign_sender', `deliver: '${p.from}' ${why}`, {
        kid: p.from
      });
    }
    // An operator switched this sender off: its mail is refused, and the row stays off.
    if (sender.active === false) {
      throw new ResolverFrameError(
        'foreign_sender',
        `deliver: '${p.from}' is switched off on this server`,
        { kid: p.from }
      );
    }
    const inReplyTo =
      p.inReplyToRemoteId != null ? await parentId(ds, domain, p.inReplyToRemoteId) : undefined;
    // No tags: relayed mail is never urgent and never a broadcast.
    // Subject and instance are shown in one line, so control and format characters go and a
    // newline becomes a space; the body is stored as sent.
    const params: Record<string, unknown> = {
      recipient: recipient.id,
      subject: p.subject.replace(/\r\n?|\n/g, ' ').replace(UNSAFE, ''),
      body: p.body,
      remoteFrom: p.from,
      viaDomain: domain,
      remoteId: p.messageId,
      ...(p.instance != null ? { instance: p.instance.replace(UNSAFE, '') } : {}),
      ...(inReplyTo !== undefined ? { inReplyTo } : {})
    };
    // Stamped with the key that signed the delivery; the sender is `remoteFrom`.
    const signer: ActorIdentity = { kind: 'agent', id: String(peer.inboundKid) };
    const row = await coordinatorWrite(rt, scope, signer, 'AgentMessage', 'create', params);
    return resultOf(row, false);
  });
}
