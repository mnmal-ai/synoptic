/**
 * The relay's sending side. `sendAgentMessage` stores mail for an agent on a peer server with
 * `delivery: 'pending'`; `drainOutbox` hands each pending row to the peer's `cortext-relay/deliver`,
 * retrying with backoff and bouncing to the sender what cannot be delivered.
 *
 * A drain holds no connection, transaction or lock while it waits on a peer. Each row is claimed
 * in one conditional update, which also sets its next attempt time, then sent, then its outcome is
 * recorded in another conditional update. A row whose send or outcome write throws stays pending
 * and is tried again at that time.
 */

import type { Dataset, Row } from '@mnmal-ai/substrate/sdk';
import { formatQualifiedKey, makeAuthorizationProvider, makeCtx } from '@mnmal-ai/substrate/sdk';
import { RELAY_ACTOR } from './deliver.js';
import { RELAY_NAMESPACE, RELAY_PROTOCOL_VERSION } from './namespace.js';
import type { RelayRuntime } from './runtime.js';

export const OUTBOX_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 1024 * 1024;
const BATCH_SIZE = 100;
const MINUTE_MS = 60_000;
const RETRY_MAX_MINUTES = 60;
const GIVE_UP_MS = 24 * 60 * MINUTE_MS;
/** How much of a peer's error message is kept in `deliveryError` and quoted in a bounce. */
const PEER_MESSAGE_MAX_CHARS = 500;
const BOUNCE_TAG = 'system:bounce';
const TYPE = 'AgentMessage';

/** Codes a peer answers for mail it will never accept; anything else is worth retrying. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'unknown_recipient',
  'foreign_sender',
  'unknown_peer',
  'too_large',
  'unsupported_version',
  'kid_collision',
  'invalid_param',
  'unknown_param'
]);

export function isPermanent(code: string | undefined): boolean {
  return code !== undefined && PERMANENT_CODES.has(code);
}

export interface DrainResult {
  delivered: number;
  retried: number;
  failed: number;
}

/** What a peer answered: the HTTP status and the parsed JSON envelope. */
export interface PeerAnswer {
  status: number;
  envelope: {
    data?: Record<string, unknown>;
    errors?: Array<{ code?: string; message?: string }>;
  };
}

/** The MailPeer row for `domain`, read through `ds`. */
export async function peerFor(ds: Dataset, domain: string): Promise<Row | undefined> {
  return (await ds.read('MailPeer', { where: { domain: { eq: domain } }, limit: 1 })).rows[0];
}

/** Why mail for `domain` cannot go through `peer`, or undefined when it can. */
export function peerUnavailable(peer: Row | undefined, domain: string): string | undefined {
  if (peer === undefined) return `no mail peer serves ${domain}`;
  if (typeof peer.blockedReason === 'string' && peer.blockedReason !== '') {
    return `the mail peer for ${domain} is blocked: ${peer.blockedReason}`;
  }
  if (peer.active !== true) return `the mail peer for ${domain} is switched off`;
  return undefined;
}

/**
 * `Bearer <jwt>` signed with the peer row's outbound key and kid, for the peer's origin. A key that
 * cannot be read throws an error naming its path, never its contents.
 */
export function peerAuthorization(peer: Row): string {
  const keyPath = String(peer.outboundKeyPath);
  try {
    return makeAuthorizationProvider(
      { keyPath, kid: String(peer.outboundKid) },
      { audience: String(peer.origin) }
    )();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    throw new Error(
      `the outbound key at ${keyPath} cannot be used (${typeof code === 'string' ? code : 'unreadable or malformed'})`
    );
  }
}

/**
 * POST `frame` to `<origin>/substrate/v1/<route>`, signed when `authorization` is given. Follows no
 * redirect, gives up after 10 s and reads at most 1 MiB of the answer. Throws on a network error,
 * a timeout, a redirect, a larger answer or one that is not JSON. Any other answer is returned,
 * whatever its status: a 200 can still carry `errors`.
 */
export async function postToPeer(
  rt: RelayRuntime,
  origin: string,
  route: 'query' | 'mutate',
  frame: Record<string, unknown>,
  authorization?: string
): Promise<PeerAnswer> {
  const res = await rt.fetchImpl(`${origin}/substrate/v1/${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization !== undefined ? { authorization } : {})
    },
    body: JSON.stringify(frame),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const body = await readCapped(res);
  try {
    return { status: res.status, envelope: JSON.parse(body) ?? {} };
  } catch {
    throw new Error(`${origin} answered ${res.status} without a JSON body`);
  }
}

async function readCapped(res: Response): Promise<string> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw new Error(`the answer is larger than ${RESPONSE_MAX_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const draining = new WeakMap<RelayRuntime, { again: boolean; run: Promise<DrainResult> }>();

/**
 * Deliver the pending mail that is due, up to 100 rows, oldest first. One drain runs at a time per
 * runtime: a call during a drain gets that drain's result, and the drain makes one more pass so
 * mail committed meanwhile is not left for the schedule.
 */
export async function drainOutbox(rt: RelayRuntime): Promise<DrainResult> {
  const current = draining.get(rt);
  if (current !== undefined) {
    current.again = true;
    return current.run;
  }
  const state = { again: false, run: Promise.resolve({ delivered: 0, retried: 0, failed: 0 }) };
  state.run = (async () => {
    const result: DrainResult = { delivered: 0, retried: 0, failed: 0 };
    try {
      do {
        state.again = false;
        await drainOnce(rt, result);
      } while (state.again);
      return result;
    } finally {
      draining.delete(rt);
    }
  })();
  draining.set(rt, state);
  return state.run;
}

async function drainOnce(rt: RelayRuntime, result: DrainResult): Promise<void> {
  const ds = rt.engine?.datasetFor(rt.mailNamespace);
  if (ds === undefined) {
    throw new Error(`cortext relay: the '${rt.mailNamespace}' dataset is not available yet`);
  }
  const { rows } = await ds.read(TYPE, {
    where: { delivery: { eq: 'pending' }, deliveryNextAt: { lte: rt.now().toISOString() } },
    orderBy: [{ createdAt: 'asc' }],
    limit: BATCH_SIZE
  });
  // One at a time: a peer is never sent more than one delivery at once from this process. Copies,
  // since a memory store hands out its live rows and a claim must compare what this read saw.
  for (const row of rows.map((r) => ({ ...r }))) {
    let outcome: keyof DrainResult | undefined;
    try {
      outcome = await drainRow(rt, ds, row);
    } catch (err) {
      console.warn(`cortext relay: message ${String(row.id)} stays pending: ${errorText(err)}`);
      outcome = 'retried';
    }
    if (outcome !== undefined) result[outcome] += 1;
  }
}

/** One row's attempt; undefined when another drain got to it first. */
async function drainRow(
  rt: RelayRuntime,
  ds: Dataset,
  row: Row
): Promise<keyof DrainResult | undefined> {
  const recipient =
    typeof row.recipient === 'string'
      ? (await ds.read('AgentIdentity', { id: row.recipient })).rows[0]
      : undefined;
  const to = String(recipient?.kid ?? 'an unknown agent');
  const domain = String(recipient?.domain ?? 'no peer server');
  const peer = recipient?.domain != null ? await peerFor(ds, domain) : undefined;
  const now = rt.now();
  const unclaimed = { delivery: 'pending', deliveryAttempts: row.deliveryAttempts ?? null };
  const age = now.getTime() - Date.parse(String(row._metadata?.createdAt));
  const reason =
    recipient?.domain == null
      ? 'the recipient is no longer an agent of a peer server'
      : (peerUnavailable(peer, domain) ??
        (age >= GIVE_UP_MS
          ? `not delivered within 24 hours; the last attempt said: ${String(row.deliveryError ?? 'nothing')}`
          : undefined));
  if (peer === undefined || reason !== undefined) {
    // peerUnavailable names a missing peer, so `reason` is set here.
    return fail(rt, ds, row, unclaimed, to, domain, String(reason));
  }

  const attempts = Number(row.deliveryAttempts ?? 0);
  const retryMs = Math.min(2 ** attempts, RETRY_MAX_MINUTES) * MINUTE_MS;
  const claim = await ds.conditionalUpdate(
    TYPE,
    row.id,
    unclaimed,
    {
      deliveryAttempts: attempts + 1,
      deliveryNextAt: new Date(now.getTime() + retryMs).toISOString()
    },
    RELAY_ACTOR
  );
  if (!claim.matched) return undefined;
  const claimed = { deliveryAttempts: attempts + 1 };
  const key = `${RELAY_NAMESPACE}/deliver`;

  let answer: PeerAnswer;
  try {
    const params = await deliverParams(ds, row, to, domain);
    answer = await postToPeer(
      rt,
      String(peer.origin),
      'mutate',
      { [key]: { params, fields: { id: true, shortId: true, duplicate: true } } },
      peerAuthorization(peer)
    );
  } catch (err) {
    await ds.conditionalUpdate(
      TYPE,
      row.id,
      claimed,
      { deliveryError: errorText(err) },
      RELAY_ACTOR
    );
    return 'retried';
  }
  // A repeat of a delivered message answers with the first id, so it counts as delivered too.
  const delivered = answer.envelope.data?.[key] as { id?: unknown } | undefined;
  if (typeof delivered?.id === 'string') {
    await ds.conditionalUpdate(
      TYPE,
      row.id,
      claimed,
      { delivery: 'delivered', deliveryNextAt: null, deliveryError: null },
      RELAY_ACTOR
    );
    return 'delivered';
  }
  const error = answer.envelope.errors?.[0];
  const said =
    error?.code !== undefined
      ? `${error.code}: ${String(error.message ?? '').slice(0, PEER_MESSAGE_MAX_CHARS)}`
      : undefined;
  if (isPermanent(error?.code)) {
    return fail(rt, ds, row, claimed, to, domain, `${domain} refused it with ${said}`);
  }
  const retry = `${domain} answered ${answer.status} ${said !== undefined ? `with ${said}` : 'without a message id'}`;
  await ds.conditionalUpdate(TYPE, row.id, claimed, { deliveryError: retry }, RELAY_ACTOR);
  return 'retried';
}

async function deliverParams(
  ds: Dataset,
  row: Row,
  to: string,
  domain: string
): Promise<Record<string, unknown>> {
  const parentId = typeof row.inReplyTo === 'string' ? row.inReplyTo : undefined;
  const parent =
    parentId !== undefined ? (await ds.read(TYPE, { id: parentId })).rows[0] : undefined;
  // The peer knows mail it sent here by its own id.
  const inReplyToRemoteId =
    parent?.viaDomain === domain && typeof parent.remoteId === 'string'
      ? parent.remoteId
      : parentId;
  return {
    v: RELAY_PROTOCOL_VERSION,
    messageId: String(row.id),
    from: String(row._metadata?.createdBy?.id),
    to,
    subject: row.subject,
    body: row.body,
    ...(row.instance != null ? { instance: row.instance } : {}),
    ...(inReplyToRemoteId !== undefined ? { inReplyToRemoteId } : {})
  };
}

/** Mark the row failed, if `match` still holds, and bounce it to its sender. */
async function fail(
  rt: RelayRuntime,
  ds: Dataset,
  row: Row,
  match: Record<string, unknown>,
  to: string,
  domain: string,
  reason: string
): Promise<'failed' | undefined> {
  const { matched } = await ds.conditionalUpdate(
    TYPE,
    row.id,
    match,
    { delivery: 'failed', deliveryNextAt: null, deliveryError: reason },
    RELAY_ACTOR
  );
  if (!matched) return undefined;
  try {
    await bounce(rt, row, to, domain, reason);
  } catch (err) {
    console.warn(`cortext relay: no bounce for message ${String(row.id)}: ${errorText(err)}`);
  }
  return 'failed';
}

/** The sender hears why through its own mailbox, unless the failed row is itself a bounce. */
async function bounce(
  rt: RelayRuntime,
  row: Row,
  to: string,
  domain: string,
  reason: string
): Promise<void> {
  if (Array.isArray(row.tags) && row.tags.includes(BOUNCE_TAG)) return;
  const engine = rt.engine;
  if (engine === undefined) throw new Error('the engine is not available yet');
  const ns = rt.mailNamespace;
  const envelope = await engine.mutate({
    frame: {
      [formatQualifiedKey(ns, 'sendAgentMessage')]: {
        params: {
          to: [String(row._metadata?.createdBy?.id)],
          subject: `Undelivered: ${String(row.subject)}`,
          body: `Your message to ${to} on ${domain} was not delivered: ${reason}`,
          inReplyTo: row.id,
          tags: [BOUNCE_TAG]
        },
        fields: { id: true }
      }
    },
    ctx: {
      ...makeCtx(ns, 'mutate'),
      identity: { kind: 'system', id: RELAY_ACTOR.id, grants: { [ns]: ['read', 'mutate'] } }
    }
  });
  const refused = envelope.errors?.[0];
  if (refused !== undefined) throw new Error(`${refused.code}: ${refused.message}`);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
