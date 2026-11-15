import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeStreamFrame, FRAMES_JSON_MIME } from '@mnmal-ai/substrate/pack';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentAuth, makeSignedFetch } from '../src/agent-auth.js';
import { runWatcher } from '../src/inbox-watch.js';
import { substrateMutate } from '../src/substrate-http.js';
import { startSubstrate } from './fixtures/substrate-server.js';

const ENV = { SUBSTRATE_URL: 'https://h', SUBSTRATE_AGENT_KEY_ID: 'me@Host' };
const KEY = 'cortext/AgentMessage';
const row = (shortId, createdAt, extra = {}) => ({
  id: `u${shortId}`,
  shortId,
  subject: `s${shortId}`,
  body: 'b',
  inReplyTo: null,
  tags: null,
  _metadata: { createdAt, createdBy: { kind: 'agent', id: 'peer@Host' } },
  ...extra
});

// Server frames as substrate writes them on /substrate/v1/subscribe.
const snapshot = (rows) => ({ kind: 'snapshot', data: { [KEY]: rows } });
const add = (r) => ({ kind: 'add', data: { [KEY]: r } });
const remove = (removedId) => ({ kind: 'remove', removedId });
const end = (reason) => ({ kind: 'end', reason });
const error = (code) => ({ kind: 'error', errors: [{ code, message: code }] });

/** A frame-stream body; `open: true` leaves it unclosed (a stalled connection). */
const frames = (list, { open = false } = {}) =>
  new ReadableStream({
    start(c) {
      for (const f of list) c.enqueue(encodeStreamFrame(f, 'json'));
      if (!open) c.close();
    }
  });

/** fetch fake: /substrate/v1/query answers the identity lookup; /substrate/v1/subscribe serves `streams` in order. */
function fakeSubstrate({ identity = [{ id: 'me-row' }], streams = [], lookups = [] } = {}) {
  const subs = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/substrate/v1/query')) {
      // `lookups` scripts the identity lookup's failures in order: an Error throws, a number is a status.
      const fail = lookups.shift();
      if (fail instanceof Error) throw fail;
      if (typeof fail === 'number') return new Response('{}', { status: fail });
      return Response.json({ data: { 'cortext/AgentIdentity': identity } });
    }
    subs.push(JSON.parse(init.body));
    const next = streams.shift();
    if (next === undefined) return new Response('{}', { status: 401 }); // ends the test loop
    if (typeof next === 'number') return new Response('{}', { status: next });
    return new Response(next, { headers: { 'content-type': FRAMES_JSON_MIME } });
  };
  return { fetchImpl, subs };
}

// The client's own re-subscribe delays, shrunk so the suite runs on real timers.
const FAST = {
  reconnect: { baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
  overloadResubscribe: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 }
};

async function run(opts) {
  const events = [];
  const sleeps = [];
  await runWatcher({
    env: ENV,
    since: '2026-10-06T00:00:00Z',
    emit: (e) => events.push(e),
    sleep: async (ms) => sleeps.push(ms),
    clientOptions: FAST,
    ...opts
  });
  return { events, sleeps };
}

describe('runWatcher', () => {
  it('is disabled without identity env, with PUSH off, or with no AgentIdentity row', async () => {
    expect((await run({ env: {}, fetchImpl: fakeSubstrate().fetchImpl })).events).toEqual([
      { type: 'status', state: 'disabled', reason: 'no SUBSTRATE_URL or SUBSTRATE_AGENT_KEY_ID' }
    ]);
    expect(
      (
        await run({
          env: { ...ENV, SYNOPTIC_INBOX_PUSH: 'off' },
          fetchImpl: fakeSubstrate().fetchImpl
        })
      ).events[0].reason
    ).toBe('SYNOPTIC_INBOX_PUSH=off');
    expect(
      (await run({ fetchImpl: fakeSubstrate({ identity: [] }).fetchImpl })).events[0].reason
    ).toMatch(/no AgentIdentity row/);
  });

  it('is disabled, not retried, when the signer refuses the URL', async () => {
    const fetchImpl = () => {
      throw new Error('refusing to send an agent token to http://remote.example: use https');
    };
    const { events } = await run({ fetchImpl });
    expect(events.at(-1)).toMatchObject({ type: 'status', state: 'disabled' });
    expect(events.some((e) => e.state === 'reconnecting')).toBe(false);
  });

  it('subscribes on the recipient filter with no limit, goes live with the wake setting, filters the snapshot by since', async () => {
    const h = fakeSubstrate({
      streams: [
        frames([
          snapshot([row(1, '2026-10-05T00:00:00Z'), row(2, '2026-10-06T01:00:00Z')]),
          end('x')
        ])
      ]
    });
    const { events } = await run({
      fetchImpl: h.fetchImpl,
      env: { ...ENV, SYNOPTIC_INBOX_WAKE: 'on' }
    });
    expect(h.subs[0][KEY].params).toEqual({
      where: { recipient: { eq: 'me-row' }, status: { eq: 'unread' }, archived: { eq: false } }
    });
    expect(events[0]).toEqual({ type: 'status', state: 'live', config: { wake: true } });
    expect(events.filter((e) => e.type === 'message').map((e) => e.shortId)).toEqual([2]);
  });

  it('emits add as message (whatever its createdAt) and remove as handled; ignores update', async () => {
    const h = fakeSubstrate({
      streams: [
        frames([
          snapshot([]),
          add(row(3, '2020-01-01T00:00:00Z')),
          { kind: 'update', data: { [KEY]: row(3, '2020-01-01T00:00:00Z') } },
          remove('u3'),
          end('x')
        ])
      ]
    });
    const { events } = await run({ fetchImpl: h.fetchImpl });
    expect(events.slice(1, 3)).toMatchObject([
      { type: 'message', shortId: 3 },
      { type: 'handled', id: 'u3' }
    ]);
  });

  it('marks urgent only for an allowlisted signer', async () => {
    const h = fakeSubstrate({
      streams: [frames([snapshot([]), add(row(4, 'x', { tags: ['priority:urgent'] })), end('x')])]
    });
    const { events } = await run({
      fetchImpl: h.fetchImpl,
      env: { ...ENV, SYNOPTIC_INBOX_URGENT_FROM: 'peer@Host' }
    });
    expect(events.find((e) => e.type === 'message').urgent).toBe(true);
  });

  it('the client follows server_restart, a dropped body and a 5xx; a 401 is terminal', async () => {
    const h = fakeSubstrate({
      streams: [
        frames([snapshot([]), end('server_restart')]),
        frames([snapshot([])]), // body ends with no `end` -> dropped
        503
      ]
    });
    const { events, sleeps } = await run({ fetchImpl: h.fetchImpl });
    expect(h.subs).toHaveLength(4); // restart, dropped, 503, then 401
    expect(sleeps).toEqual([]); // each was re-subscribed by the client, not this loop
    expect(events.filter((e) => e.state === 'live')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'status', state: 'disabled', reason: 'HTTP 401' });
  });

  it('an overload past the client budget backs off; any other error code is terminal', async () => {
    const h = fakeSubstrate({
      streams: [
        frames([error('subscription_overloaded')]), // within the budget: the client re-subscribes
        frames([error('subscription_overloaded')]), // budget spent: this loop backs off
        frames([error('policy_denied')])
      ]
    });
    const { events, sleeps } = await run({ fetchImpl: h.fetchImpl });
    expect(sleeps).toEqual([1000]);
    expect(events.at(-1)).toEqual({ type: 'status', state: 'disabled', reason: 'policy_denied' });
    expect(h.subs).toHaveLength(3);
  });

  it('re-subscribes a stream silent for idleMs', async () => {
    const h = fakeSubstrate({ streams: [frames([snapshot([])], { open: true })] });
    await run({ fetchImpl: h.fetchImpl, idleMs: 20 });
    expect(h.subs).toHaveLength(2); // the stalled stream, then the closing 401
  });

  it('overload escalates the backoff even after a snapshot', async () => {
    const ov = () => frames([snapshot([]), error('subscription_overloaded')]);
    const h = fakeSubstrate({ streams: [ov(), ov(), ov(), ov()] });
    const { sleeps } = await run({ fetchImpl: h.fetchImpl });
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('malformed event data degrades instead of throwing', async () => {
    const h = fakeSubstrate({
      streams: [
        frames([
          { kind: 'snapshot', data: 'junk' },
          { kind: 'snapshot', data: { [KEY]: 'nope' } },
          { kind: 'snapshot', data: null },
          { kind: 'add', data: null },
          { kind: 'add', data: {} },
          { kind: 'add', data: { [KEY]: 'x' } },
          { kind: 'remove' },
          { kind: 'remove', removedId: 5 },
          add(row(9, '2020-01-01T00:00:00Z')),
          end('x')
        ])
      ]
    });
    const { events } = await run({ fetchImpl: h.fetchImpl });
    expect(events.filter((e) => e.state === 'live')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'message').map((e) => e.shortId)).toEqual([9]);
    expect(events.some((e) => e.type === 'handled')).toBe(false);
  });

  it('compares since as a timestamp, emitting when unparseable', async () => {
    const h = fakeSubstrate({
      streams: [
        frames([
          snapshot([
            row(1, '2026-10-06T00:00:00.123Z'),
            row(2, '2026-10-05T23:59:59Z'),
            row(3, 'garbage'),
            row(4, '2026-10-06T00:00:00Z') // exactly since: re-emitted, the bridge dedupes by id
          ]),
          end('x')
        ])
      ]
    });
    const { events } = await run({ fetchImpl: h.fetchImpl });
    expect(events.filter((e) => e.type === 'message').map((e) => e.shortId)).toEqual([1, 3, 4]);
  });

  it('a transient identity-lookup failure backs off and recovers', async () => {
    const h = fakeSubstrate({
      lookups: [new Error('fetch failed'), 503],
      streams: [frames([snapshot([])])]
    });
    const { events, sleeps } = await run({ fetchImpl: h.fetchImpl });
    expect(events.slice(0, 2)).toMatchObject([
      { type: 'status', state: 'reconnecting', reason: 'identity lookup: fetch failed' },
      { type: 'status', state: 'reconnecting', reason: 'identity lookup: substrate/query 503' }
    ]);
    expect(events[2]).toEqual({ type: 'status', state: 'live', config: { wake: false } });
    expect(sleeps).toEqual([1000, 2000]); // the dropped stream is the client's to re-subscribe
  });

  it('an auth failure on the identity lookup is terminal', async () => {
    for (const status of [401, 403]) {
      const h = fakeSubstrate({ lookups: [status] });
      const { events, sleeps } = await run({ fetchImpl: h.fetchImpl });
      expect(events).toEqual([
        {
          type: 'status',
          state: 'disabled',
          reason: `identity lookup failed: substrate/query ${status}`
        }
      ]);
      expect(sleeps).toEqual([]);
      expect(h.subs).toHaveLength(0);
    }
  });

  it('a 4xx other than 408 or 429 is terminal; 408 and 429 back off', async () => {
    const bad = fakeSubstrate({ streams: [400] });
    const r1 = await run({ fetchImpl: bad.fetchImpl });
    expect(r1.events).toEqual([{ type: 'status', state: 'disabled', reason: 'HTTP 400' }]);
    expect(r1.sleeps).toEqual([]);

    // The client retries a 429 three times itself before it surfaces.
    const busy = fakeSubstrate({ streams: [429, 429, 429, 429, 408] });
    const r2 = await run({ fetchImpl: busy.fetchImpl });
    expect(r2.sleeps).toEqual([1000, 2000]);
    expect(busy.subs).toHaveLength(6); // four 429s, the 408, then the closing 401
  });

  it('a server that keeps restarting with no snapshot: three re-subscribes, then a backoff', async () => {
    const restart = () => frames([end('server_restart')]);
    const h = fakeSubstrate({ streams: [restart(), restart(), restart(), restart()] });
    const { events, sleeps } = await run({ fetchImpl: h.fetchImpl });
    expect(sleeps).toEqual([1000]);
    expect(events.filter((e) => e.state === 'reconnecting')).toEqual([
      { type: 'status', state: 'reconnecting', reason: 'server_restart' }
    ]);
    expect(h.subs).toHaveLength(5);
  });

  it('a snapshot resets the server_restart count', async () => {
    const restart = () => frames([end('server_restart')]);
    const h = fakeSubstrate({
      streams: [
        restart(),
        restart(),
        restart(),
        frames([snapshot([]), end('server_restart')]),
        restart(),
        restart(),
        restart()
      ]
    });
    const { sleeps } = await run({ fetchImpl: h.fetchImpl });
    expect(sleeps).toEqual([]);
    expect(h.subs).toHaveLength(8);
  });
});

describe('runWatcher against a real HTTP/2 substrate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synoptic-watch-'));
  const agent = (kid) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyPath = join(dir, `${kid}.pem`);
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    return { kid, keyPath, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
  };
  const me = agent('watch-test@example');
  const peer = agent('peer@example');
  let server;
  const envFor = (a) => ({
    SUBSTRATE_URL: server.url,
    SUBSTRATE_AGENT_KEY_ID: a.kid,
    SUBSTRATE_AGENT_KEY_PATH: a.keyPath
  });
  const signedAs = (a) => makeSignedFetch(createAgentAuth(envFor(a)).getAuthHeader);
  /** A write as `a` that throws with the server's reason when any frame is refused. */
  const write = async (a, payload) => {
    const refused = [];
    const data = await substrateMutate(server.url, payload, {
      fetchImpl: signedAs(a),
      onFrameFailure: (key, why) => refused.push(`${key}: ${why}`)
    });
    if (refused.length > 0) throw new Error(refused.join('; '));
    return data;
  };

  beforeAll(async () => {
    server = await startSubstrate({ keys: [me, peer] });
  }, 30000);
  afterAll(async () => {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers the snapshot and new mail signed, and reports mail that leaves the inbox', async () => {
    for (const a of [me, peer])
      await write(a, {
        'cortext/createAgentIdentity': {
          params: { kid: a.kid, host: 'example', active: true },
          fields: { id: true }
        }
      });
    const send = async (subject) =>
      (
        await write(peer, {
          'cortext/sendAgentMessage': {
            params: { to: me.kid, subject, body: 'b' },
            fields: { id: true }
          }
        })
      )['cortext/sendAgentMessage'][0].id;
    const first = await send('before the watcher');

    const events = [];
    const seen = (pred) =>
      vi.waitFor(() => expect(events.some(pred)).toBe(true), { timeout: 10000, interval: 20 });
    const ac = new AbortController();
    const done = runWatcher({
      env: envFor(me),
      fetchImpl: signedAs(me),
      since: new Date(0).toISOString(),
      emit: (e) => events.push(e),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      signal: ac.signal
    });

    await seen((e) => e.type === 'message' && e.id === first);
    expect(events[0]).toEqual({ type: 'status', state: 'live', config: { wake: false } });
    const second = await send('while it watches');
    await seen((e) => e.type === 'message' && e.id === second);
    expect(events.find((e) => e.id === second)).toMatchObject({ subject: 'while it watches' });

    await write(me, { 'cortext/ackAgentMessage': { params: { id: first }, fields: { id: true } } });
    await seen((e) => e.type === 'handled' && e.id === first);

    ac.abort();
    await done; // the signal ends the watcher without a disabled status
    expect(events.some((e) => e.state === 'disabled')).toBe(false);
  }, 30000);
});
