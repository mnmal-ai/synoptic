/**
 * The relay's sending side. `sendAgentMessage` stores mail for an agent on a peer server with
 * `delivery: 'pending'`; `drainOutbox` hands each pending row to the peer's `cortext-relay/deliver`,
 * retrying with backoff and bouncing to the sender what cannot be delivered.
 *
 * A drain holds no connection, transaction or lock while it waits on a peer. Each row is claimed
 * in one conditional update, which also sets its next attempt time, then sent, then its outcome is
 * recorded in another conditional update. A row whose send or outcome write throws stays pending
 * and is tried again at that time.
 *
 * Nothing a peer writes reaches a row: `deliveryError` holds one of this server's fixed codes or a
 * code from `KNOWN_CODES`, and a bounce says why in a sentence this server chose for that code.
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
/** The peer codes kept as they are; any other code a peer answers is recorded as `refused`. */
const KNOWN_CODES: ReadonlySet<string> = new Set([...PERMANENT_CODES, 'rate_limited']);

/** Why the sender's mail did not arrive, by `deliveryError` code. */
const BOUNCE_REASONS: Record<string, string> = {
  unknown_recipient: 'that server has no active agent of that name',
  foreign_sender: 'that server does not accept you as the sender',
  kid_collision: 'that server does not accept you as the sender',
  unknown_peer: 'that server does not recognise this server as a mail peer',
  too_large: 'the message is larger than that server accepts',
  unsupported_version: 'that server speaks another version of the relay protocol',
  invalid_param: 'that server refused the message as malformed',
  unknown_param: 'that server refused the message as malformed',
  peer_missing: 'this server no longer exchanges mail with that server',
  peer_blocked: 'this server has blocked mail to that server',
  peer_inactive: 'this server has switched off mail to that server',
  recipient_gone: 'the recipient is no longer in the directory as an agent of another server',
  expired: 'it could not be delivered within 24 hours'
};

export function isPermanent(code: string | undefined): boolean {
  return code !== undefined && PERMANENT_CODES.has(code);
}

export interface DrainResult {
  delivered: number;
  retried: number;
  failed: number;
}

/** What a peer answered: the HTTP status and the parsed JSON envelope, `{}` when not JSON. */
export interface PeerAnswer {
  status: number;
  envelope: {
    data?: Record<string, unknown>;
    errors?: Array<{ code?: string; message?: string }>;
  };
}

/** A call to a peer that got no answer, with a code this server chose. */
export class PeerCallError extends Error {
  constructor(
    readonly code: 'timeout' | 'network' | 'answer_too_large',
    cause?: unknown
  ) {
    super(code, { cause });
  }
}

/** The MailPeer row for `domain`, read through `ds`. */
export async function peerFor(ds: Dataset, domain: string): Promise<Row | undefined> {
  return (await ds.read('MailPeer', { where: { domain: { eq: domain } }, limit: 1 })).rows[0];
}

/** What stops mail going through `peer`, or undefined when nothing does. */
export function peerProblem(
  peer: Row | undefined
): 'peer_missing' | 'peer_blocked' | 'peer_inactive' | undefined {
  if (peer === undefined) return 'peer_missing';
  if (typeof peer.blockedReason === 'string' && peer.blockedReason !== '') return 'peer_blocked';
  if (peer.active !== true) return 'peer_inactive';
  return undefined;
}

/** `peerProblem` as a sentence for the sender, naming `domain` and quoting `blockedReason`. */
export function peerUnavailable(peer: Row | undefined, domain: string): string | undefined {
  switch (peerProblem(peer)) {
    case 'peer_missing':
      return `no mail peer serves ${domain}`;
    case 'peer_blocked':
      return `the mail peer for ${domain} is blocked: ${String(peer?.blockedReason)}`;
    case 'peer_inactive':
      return `the mail peer for ${domain} is switched off`;
    default:
      return undefined;
  }
}

/**
 * `Bearer <jwt>` signed with the peer row's outbound key and kid, for the peer's origin and the
 * relay namespace only. A key that cannot be read throws an error naming its path, never its
 * contents; the path is operator-only, so the message is for logs, never for a row.
 */
export function peerAuthorization(peer: Row): string {
  const keyPath = String(peer.outboundKeyPath);
  try {
    return makeAuthorizationProvider(
      { keyPath, kid: String(peer.outboundKid) },
      { audience: String(peer.origin), namespaces: [RELAY_NAMESPACE] }
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
 * redirect, gives up after 10 s and reads at most 1 MiB of the answer. No answer (a network error,
 * a timeout, a redirect, a larger answer) throws a `PeerCallError`. Any answer is returned, whatever
 * its status, so the caller reads `errors` first: a 200 can carry them.
 */
export async function postToPeer(
  rt: RelayRuntime,
  origin: string,
  route: 'query' | 'mutate',
  frame: Record<string, unknown>,
  authorization?: string
): Promise<PeerAnswer> {
  let status: number;
  let body: string;
  try {
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
    status = res.status;
    body = await readCapped(res);
  } catch (err) {
    if (err instanceof PeerCallError) throw err;
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new PeerCallError(timedOut ? 'timeout' : 'network', err);
  }
  try {
    return { status, envelope: JSON.parse(body) ?? {} };
  } catch {
    return { status, envelope: {} };
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
      throw new PeerCallError('answer_too_large');
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
  // Peers this pass could not reach, with why: their later rows are not sent until the next pass.
  const unreachable = new Map<string, string>();
  // One at a time: a peer is never sent more than one delivery at once from this process. Copies,
  // since a memory store hands out its live rows and a claim must compare what this read saw.
  for (const row of rows.map((r) => ({ ...r }))) {
    let outcome: keyof DrainResult | undefined;
    try {
      outcome = await drainRow(rt, ds, row, unreachable);
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
  row: Row,
  unreachable: Map<string, string>
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
  const problem =
    recipient?.domain == null
      ? 'recipient_gone'
      : (peerProblem(peer) ?? (age >= GIVE_UP_MS ? 'expired' : undefined));
  if (peer === undefined || problem !== undefined) {
    // peerProblem names a missing peer, so `problem` is set here.
    return fail(rt, ds, row, unclaimed, to, domain, String(problem));
  }

  const attempts = Number(row.deliveryAttempts ?? 0);
  const retryMs = Math.min(2 ** attempts, RETRY_MAX_MINUTES) * MINUTE_MS;
  const skipped = unreachable.get(domain);
  const claim = await ds.conditionalUpdate(
    TYPE,
    row.id,
    unclaimed,
    {
      deliveryAttempts: attempts + 1,
      deliveryNextAt: new Date(now.getTime() + retryMs).toISOString(),
      ...(skipped !== undefined ? { deliveryError: skipped } : {})
    },
    RELAY_ACTOR
  );
  if (!claim.matched) return undefined;
  if (skipped !== undefined) return 'retried';
  const claimed = { deliveryAttempts: attempts + 1 };

  const { code, peerWide } = await send(rt, ds, row, peer, to, domain);
  if (peerWide) unreachable.set(domain, code);
  if (code === 'delivered') {
    await ds.conditionalUpdate(
      TYPE,
      row.id,
      claimed,
      { delivery: 'delivered', deliveryNextAt: null, deliveryError: null },
      RELAY_ACTOR
    );
    return 'delivered';
  }
  if (isPermanent(code)) return fail(rt, ds, row, claimed, to, domain, code);
  await ds.conditionalUpdate(TYPE, row.id, claimed, { deliveryError: code }, RELAY_ACTOR);
  return 'retried';
}

/**
 * One delivery to the peer: `delivered`, or the `deliveryError` code. `peerWide` is set when the
 * failure would be the same for any row of this peer: the key, no answer, or a 5xx.
 */
async function send(
  rt: RelayRuntime,
  ds: Dataset,
  row: Row,
  peer: Row,
  to: string,
  domain: string
): Promise<{ code: string; peerWide: boolean }> {
  const params = await deliverParams(ds, row, to, domain);
  let authorization: string;
  try {
    authorization = peerAuthorization(peer);
  } catch (err) {
    console.warn(`cortext relay: mail to ${domain} is held: ${errorText(err)}`);
    rt.metric('cortext.mail_key_unusable', { domain, error: errorText(err) });
    return { code: 'key_unusable', peerWide: true };
  }
  const key = `${RELAY_NAMESPACE}/deliver`;
  let answer: PeerAnswer;
  try {
    answer = await postToPeer(
      rt,
      String(peer.origin),
      'mutate',
      { [key]: { params, fields: { id: true, shortId: true, duplicate: true } } },
      authorization
    );
  } catch (err) {
    return { code: err instanceof PeerCallError ? err.code : 'network', peerWide: true };
  }
  // A repeat of a delivered message answers with the first id, so it counts as delivered too.
  const delivered = answer.envelope.data?.[key] as { id?: unknown } | undefined;
  if (typeof delivered?.id === 'string') return { code: 'delivered', peerWide: false };
  if (answer.status >= 500) return { code: `http_${answer.status}`, peerWide: true };
  const peerCode = answer.envelope.errors?.[0]?.code;
  if (peerCode !== undefined) {
    return { code: KNOWN_CODES.has(peerCode) ? peerCode : 'refused', peerWide: false };
  }
  const ok = answer.status >= 200 && answer.status < 300;
  return { code: ok ? 'no_message_id' : `http_${answer.status}`, peerWide: false };
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

/** Mark the row failed with `code`, if `match` still holds, and bounce it to its sender. */
async function fail(
  rt: RelayRuntime,
  ds: Dataset,
  row: Row,
  match: Record<string, unknown>,
  to: string,
  domain: string,
  code: string
): Promise<'failed' | undefined> {
  const { matched } = await ds.conditionalUpdate(
    TYPE,
    row.id,
    match,
    { delivery: 'failed', deliveryNextAt: null, deliveryError: code },
    RELAY_ACTOR
  );
  if (!matched) return undefined;
  try {
    await bounce(rt, row, to, domain, code);
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
  code: string
): Promise<void> {
  if (Array.isArray(row.tags) && row.tags.includes(BOUNCE_TAG)) return;
  const engine = rt.engine;
  if (engine === undefined) throw new Error('the engine is not available yet');
  const ns = rt.mailNamespace;
  const why = BOUNCE_REASONS[code] ?? 'it could not be delivered';
  const envelope = await engine.mutate({
    frame: {
      [formatQualifiedKey(ns, 'sendAgentMessage')]: {
        params: {
          to: [String(row._metadata?.createdBy?.id)],
          subject: `Undelivered: ${String(row.subject)}`,
          body: `Your message to ${to} on ${domain} was not delivered: ${why}.`,
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
