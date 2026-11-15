// The inbox push watcher's core: one live subscription on this session's
// unread inbox through SubstrateClient (HTTP/2 frame streams). The Node pieces
// live in inbox-watch-entry.js; tests inject fetchImpl.

import { SubscribeError, SubstrateClient } from '@mnmal-ai/substrate/client';
import { resolveIdentityId } from './inbox.js';
import { readInboxKnobs, toWatchMessage } from './inbox-push.js';

const OVERLOAD = 'subscription_overloaded';

export async function runWatcher({
  env,
  fetchImpl,
  since,
  emit,
  sleep,
  idleMs = 60_000,
  namespace,
  signal,
  clientOptions = {}
}) {
  const ns = namespace ?? env.SUBSTRATE_NAMESPACE ?? 'cortext';
  const knobs = readInboxKnobs(env);
  const disabled = (reason) => emit({ type: 'status', state: 'disabled', reason });
  if (!env.SUBSTRATE_URL || !env.SUBSTRATE_AGENT_KEY_ID)
    return disabled('no SUBSTRATE_URL or SUBSTRATE_AGENT_KEY_ID');
  if (!knobs.push) return disabled('SYNOPTIC_INBOX_PUSH=off');

  const backoff = (n) => sleep(Math.min(60_000, 1_000 * 2 ** n));
  let attempt = 0;

  // The lookup runs under the connection's backoff: a transport error or 5xx is transient,
  // and `disabled` is never respawned. Only a refused credential (substrateQuery throws
  // `substrate/query <status>`) or a missing directory row is terminal.
  let meId;
  for (;;) {
    if (signal?.aborted) return;
    try {
      meId = await resolveIdentityId({
        substrateUrl: env.SUBSTRATE_URL,
        namespace: ns,
        agentKid: env.SUBSTRATE_AGENT_KEY_ID,
        fetchImpl
      });
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A refused credential, or a URL the signer will never send a token to,
      // does not get better by retrying.
      if (
        /^substrate\/query 40[13]$/.test(message) ||
        /^refusing to send an agent token/.test(message)
      )
        return disabled(`identity lookup failed: ${message}`);
      emit({ type: 'status', state: 'reconnecting', reason: `identity lookup: ${message}` });
      await backoff(attempt);
      attempt += 1;
    }
  }
  if (meId === null) return disabled(`no AgentIdentity row for ${env.SUBSTRATE_AGENT_KEY_ID}`);
  attempt = 0; // the lookup answered: the server is reachable

  const key = `${ns}/AgentMessage`;
  const frame = {
    [key]: {
      params: {
        where: { recipient: { eq: meId }, status: { eq: 'unread' }, archived: { eq: false } }
      },
      fields: {
        id: true,
        shortId: true,
        subject: true,
        body: true,
        inReplyTo: true,
        instance: true,
        tags: true,
        _metadata: true
      }
    }
  };
  const toMsg = (r) =>
    toWatchMessage(r, { kid: env.SUBSTRATE_AGENT_KEY_ID, urgentFrom: knobs.urgentFrom });
  let snapshotSeen = false;
  let restarts = 0; // consecutive server_restart ends with no snapshot between them
  let snapshotSinceRestart = false;
  const sinceMs = Date.parse(since);
  const isNewer = (row) => {
    const t = Date.parse(row?._metadata?.createdAt);
    return Number.isNaN(t) || Number.isNaN(sinceMs) || t >= sinceMs; // >=: a row at exactly `since` is re-sent; the bridge dedupes by id
  };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // The client re-subscribes on its own after a dropped connection, `end
  // { server_restart }`, an overload within its budget, or idleMs of silence.
  // This loop handles what it hands back: a failed connect, a spent overload
  // budget, a refusal, or an `end` it will not follow.
  const client = new SubstrateClient({
    endpoint: env.SUBSTRATE_URL,
    fetch: fetchImpl,
    streamIdleMs: idleMs,
    onDiagnostics: () => {},
    ...clientOptions
  });

  for (;;) {
    if (signal?.aborted) return;
    snapshotSeen = false;
    const outcome = await oneConnection();
    if (signal?.aborted) return;
    // A snapshot proves the connection worked, so it resets the backoff, except
    // for overload: the server accepted then shed us, and that must escalate.
    if (snapshotSeen && outcome.reason !== OVERLOAD) attempt = 0;
    if (outcome.kind === 'terminal') return disabled(outcome.reason);
    emit({ type: 'status', state: 'reconnecting', reason: outcome.reason });
    await backoff(attempt);
    attempt += 1;
  }

  /** One subscription. Resolves { kind: 'terminal'|'backoff', reason }. */
  async function oneConnection() {
    let live = false;
    try {
      for await (const event of client.subscribe(frame, signal ? { signal } : {})) {
        if (event.kind === 'snapshot') {
          snapshotSeen = true;
          snapshotSinceRestart = true;
          if (!live) {
            live = true;
            emit({ type: 'status', state: 'live', config: { wake: knobs.wake } });
          }
          const rows = isObj(event.data) ? event.data[key] : undefined;
          if (Array.isArray(rows))
            for (const row of rows) if (isObj(row) && isNewer(row)) emit(toMsg(row));
        } else if (event.kind === 'add') {
          const row = isObj(event.data) ? event.data[key] : undefined;
          if (isObj(row)) emit(toMsg(row));
        } else if (event.kind === 'remove') {
          if (typeof event.removedId === 'string' && event.removedId !== '')
            emit({ type: 'handled', id: event.removedId });
        } else if (event.kind === 'end') {
          if (event.reason !== 'server_restart')
            return { kind: 'backoff', reason: event.reason ?? 'end' };
          // The client re-subscribes at once. A server stuck restarting never
          // reaches a snapshot: after three in a row, leave and back off.
          if (snapshotSinceRestart) restarts = 0;
          else if (++restarts > 3) return { kind: 'backoff', reason: 'server_restart' };
          snapshotSinceRestart = false;
        }
      }
      return { kind: 'backoff', reason: 'subscription ended' };
    } catch (err) {
      return classify(err);
    }
  }
}

/** A subscribe failure: terminal when retrying cannot change it, else back off. */
function classify(err) {
  if (err instanceof SubscribeError)
    return err.code === OVERLOAD
      ? { kind: 'backoff', reason: OVERLOAD }
      : { kind: 'terminal', reason: err.code || 'error' };
  const status = typeof err?.status === 'number' ? err.status : undefined;
  if (err?.code === 'frames_unsupported') return { kind: 'terminal', reason: 'frames_unsupported' };
  if (status !== undefined) {
    // A 4xx is the request's own fault and retrying repeats it, except 408 and 429.
    const terminal = status >= 400 && status < 500 && status !== 408 && status !== 429;
    return { kind: terminal ? 'terminal' : 'backoff', reason: `HTTP ${status}` };
  }
  const cause = err?.cause instanceof Error ? err.cause.message : undefined;
  return {
    kind: 'backoff',
    reason: `connect: ${cause ?? (err instanceof Error ? err.message : String(err))}`
  };
}
