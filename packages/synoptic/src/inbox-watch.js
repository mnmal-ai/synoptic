// The inbox push watcher's core. Node-free so it is
// testable with an injected fetch; the Node pieces live in inbox-watch-entry.js.

import { resolveIdentityId } from './inbox.js';
import { readInboxKnobs, toWatchMessage } from './inbox-push.js';

// A stream that never sends a blank line would otherwise grow the buffer
// without bound; past this the partial event is dropped.
const SSE_BUFFER_MAX = 1024 * 1024;

/** Incremental text/event-stream parser. */
export function parseSse() {
  let buf = '';
  return (chunk) => {
    // Line endings are normalised on the accumulated buffer, so a CRLF split
    // across two chunks is still one line ending. A trailing CR waits for the
    // next chunk, which may begin with its LF.
    buf = (buf + chunk).replace(/\r\n/g, '\n');
    const heldCr = buf.endsWith('\r');
    if (heldCr) buf = buf.slice(0, -1);
    buf = buf.replace(/\r/g, '\n');
    const blocks = buf.split('\n\n');
    buf = (blocks.pop() ?? '') + (heldCr ? '\r' : '');
    if (buf.length > SSE_BUFFER_MAX) buf = '';
    const out = [];
    for (const block of blocks) {
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':') || line === '') continue;
        const i = line.indexOf(':');
        const field = i === -1 ? line : line.slice(0, i);
        const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length === 0) continue;
      const raw = data.join('\n');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      out.push({ event, data: parsed });
    }
    return out;
  };
}

const OVERLOAD = 'subscription_overloaded';

export async function runWatcher({
  env,
  fetchImpl,
  since,
  emit,
  sleep,
  idleMs = 60_000,
  namespace
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
  let restarts = 0; // consecutive server_restart ends with no snapshot
  const sinceMs = Date.parse(since);
  const isNewer = (row) => {
    const t = Date.parse(row?._metadata?.createdAt);
    return Number.isNaN(t) || Number.isNaN(sinceMs) || t >= sinceMs; // >=: a row at exactly `since` is re-sent; the bridge dedupes by id
  };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  for (;;) {
    snapshotSeen = false;
    const outcome = await oneConnection();
    // A snapshot proves the connection worked, so it resets the backoff, except
    // for overload: the server accepted then shed us, and that must escalate.
    if (snapshotSeen && outcome.reason !== OVERLOAD) attempt = 0;
    if (snapshotSeen) restarts = 0;
    if (outcome.kind === 'terminal') return disabled(outcome.reason);
    // A restart that never reaches a snapshot is a server stuck restarting: after three,
    // stop resubscribing at once and back off until a snapshot proves it healthy again.
    if (outcome.kind === 'now' && (snapshotSeen || ++restarts <= 3)) continue;
    emit({ type: 'status', state: 'reconnecting', reason: outcome.reason });
    await backoff(attempt);
    attempt += 1;
  }

  /** One subscription. Resolves { kind: 'terminal'|'now'|'backoff', reason }. */
  async function oneConnection() {
    const ac = new AbortController();
    let res;
    try {
      res = await fetchImpl(`${env.SUBSTRATE_URL}/substrate/v1/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(frame),
        signal: ac.signal
      });
    } catch (err) {
      return {
        kind: 'backoff',
        reason: `connect: ${err instanceof Error ? err.message : String(err)}`
      };
    }
    // A 4xx is the request's own fault and retrying repeats it, except 408 and 429.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
      return { kind: 'terminal', reason: `HTTP ${res.status}` };
    if (!res.ok || res.body == null) return { kind: 'backoff', reason: `HTTP ${res.status}` };

    const parse = parseSse();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let idle;
    let live = false;
    const idleTimeout = () =>
      new Promise((resolve) => {
        idle = setTimeout(() => resolve({ idle: true }), idleMs);
      });
    try {
      for (;;) {
        const r = await Promise.race([reader.read(), idleTimeout()]);
        clearTimeout(idle);
        if ('idle' in r) {
          return { kind: 'backoff', reason: `idle ${idleMs} ms` };
        }
        if (r.done) return { kind: 'backoff', reason: 'stream ended without an end frame' };
        for (const { event, data } of parse(decoder.decode(r.value, { stream: true }))) {
          if (event === 'snapshot') {
            if (!isObj(data)) continue;
            snapshotSeen = true;
            if (!live) {
              live = true;
              emit({ type: 'status', state: 'live', config: { wake: knobs.wake } });
            }
            const rows = Array.isArray(data.rows) ? data.rows : [];
            for (const row of rows) if (isObj(row) && isNewer(row)) emit(toMsg(row));
          } else if (event === 'add') {
            if (isObj(data) && isObj(data.row)) emit(toMsg(data.row));
          } else if (event === 'remove') {
            if (isObj(data) && typeof data.removedId === 'string')
              emit({ type: 'handled', id: data.removedId });
          } else if (event === 'error') {
            if (isObj(data) && data.code === OVERLOAD) return { kind: 'backoff', reason: OVERLOAD };
            return { kind: 'terminal', reason: (isObj(data) && data.code) || 'error' };
          } else if (event === 'end') {
            return isObj(data) && data.reason === 'server_restart'
              ? { kind: 'now', reason: 'server_restart' }
              : { kind: 'backoff', reason: (isObj(data) && data.reason) || 'end' };
          }
        }
      }
    } finally {
      clearTimeout(idle);
      ac.abort();
      reader.cancel().catch(() => {}); // settles a pending read; a stalled body must not pin the process
    }
  }
}
