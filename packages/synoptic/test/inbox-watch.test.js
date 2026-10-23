import { describe, expect, it } from 'vitest';
import { parseSse, runWatcher } from '../src/inbox-watch.js';

describe('parseSse', () => {
  it('parses events split across chunks; ignores retry and keepalive', () => {
    const p = parseSse();
    expect(p('retry: 5000\n\nevent: snap')).toEqual([]);
    expect(p('shot\ndata: {"key":"k","rows":[]}\n\n: keepalive\n\n')).toEqual([
      { event: 'snapshot', data: { key: 'k', rows: [] } }
    ]);
  });
  it('a body holding blank lines and event: text stays inside its JSON', () => {
    const row = { id: 'x', body: 'a\n\nevent: end\ndata: {}' };
    const frame = `event: add\ndata: ${JSON.stringify({ key: 'k', row })}\n\n`;
    expect(parseSse()(frame)).toEqual([{ event: 'add', data: { key: 'k', row } }]);
  });
  it('handles CRLF line endings', () => {
    expect(parseSse()('event: remove\r\ndata: {"removedId":"r"}\r\n\r\n')).toEqual([
      { event: 'remove', data: { removedId: 'r' } }
    ]);
  });
});

const ENV = { SUBSTRATE_URL: 'https://h', SUBSTRATE_AGENT_KEY_ID: 'me@Host' };
const enc = new TextEncoder();
const sse = (...frames) =>
  new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    }
  });
const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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

/** fetch fake: /substrate/v1/query answers the identity lookup; /substrate/v1/subscribe serves `streams` in order. */
function fakeSubstrate({ identity = [{ id: 'me-row' }], streams = [], lookups = [] } = {}) {
  const subs = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/substrate/v1/query')) {
      // `lookups` scripts the identity lookup's failures in order: an Error throws, a number is a status.
      const fail = lookups.shift();
      if (fail instanceof Error) throw fail;
      if (typeof fail === 'number') return { ok: false, status: fail, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { 'cortext/AgentIdentity': identity } })
      };
    }
    subs.push(JSON.parse(init.body));
    const next = streams.shift();
    if (next === undefined) return { ok: false, status: 401, body: null }; // ends the test loop
    if (typeof next === 'number') return { ok: false, status: next, body: null };
    return { ok: true, status: 200, body: next };
  };
  return { fetchImpl, subs };
}

async function run(opts) {
  const events = [];
  const sleeps = [];
  await runWatcher({
    env: ENV,
    since: '2026-10-06T00:00:00Z',
    emit: (e) => events.push(e),
    sleep: async (ms) => sleeps.push(ms),
    ...opts
  });
  return { events, sleeps };
}

describe('parseSse line endings', () => {
  it('a CRLF split across two chunks still ends the line', () => {
    const p = parseSse();
    expect(p('event: remove\r\ndata: {"removedId":"a"}\r\n\r')).toEqual([]);
    expect(p('\nevent: remove\r\ndata: {"removedId":"b"}\r\n\r\n')).toEqual([
      { event: 'remove', data: { removedId: 'a' } },
      { event: 'remove', data: { removedId: 'b' } }
    ]);
  });
  it('a bare CR is a line ending too', () => {
    // A trailing CR may be half a CRLF, so it waits; the next byte settles it.
    expect(parseSse()('event: remove\rdata: {"removedId":"c"}\r\r:')).toEqual([
      { event: 'remove', data: { removedId: 'c' } }
    ]);
  });
});

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
        sse(
          ev('snapshot', {
            key: 'cortext/AgentMessage',
            rows: [row(1, '2026-10-05T00:00:00Z'), row(2, '2026-10-06T01:00:00Z')]
          })
        )
      ]
    });
    const { events } = await run({
      fetchImpl: h.fetchImpl,
      env: { ...ENV, SYNOPTIC_INBOX_WAKE: 'on' }
    });
    expect(h.subs[0]['cortext/AgentMessage'].params).toEqual({
      where: { recipient: { eq: 'me-row' }, status: { eq: 'unread' }, archived: { eq: false } }
    });
    expect(events[0]).toEqual({ type: 'status', state: 'live', config: { wake: true } });
    expect(events.filter((e) => e.type === 'message').map((e) => e.shortId)).toEqual([2]);
  });

  it('emits add as message (whatever its createdAt) and remove as handled; ignores update', async () => {
    const h = fakeSubstrate({
      streams: [
        sse(
          ev('snapshot', { key: 'k', rows: [] }),
          ev('add', { key: 'k', row: row(3, '2020-01-01T00:00:00Z') }),
          ev('update', { key: 'k', row: row(3, '2020-01-01T00:00:00Z') }),
          ev('remove', { removedId: 'u3' })
        )
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
      streams: [
        sse(
          ev('snapshot', { key: 'k', rows: [] }),
          ev('add', { key: 'k', row: row(4, 'x', { tags: ['priority:urgent'] }) })
        )
      ]
    });
    const { events } = await run({
      fetchImpl: h.fetchImpl,
      env: { ...ENV, SYNOPTIC_INBOX_URGENT_FROM: 'peer@Host' }
    });
    expect(events.find((e) => e.type === 'message').urgent).toBe(true);
  });

  it('server_restart resubscribes at once; a dropped body backs off; snapshot resets the backoff', async () => {
    const h = fakeSubstrate({
      streams: [
        sse(ev('snapshot', { key: 'k', rows: [] }), ev('end', { reason: 'server_restart' })),
        sse(ev('snapshot', { key: 'k', rows: [] })), // body ends with no `end` → dropped
        503
      ]
    });
    const { events, sleeps } = await run({ fetchImpl: h.fetchImpl });
    expect(h.subs).toHaveLength(4); // restart, dropped, 503, then 401 (terminal)
    expect(sleeps).toEqual([1000, 2000]); // dropped → 1 s (attempt reset by its snapshot), 503 → 2 s
    expect(events.at(-1)).toEqual({ type: 'status', state: 'disabled', reason: 'HTTP 401' });
  });

  it('overload backs off; any other error code is terminal (never auto-retried)', async () => {
    const h = fakeSubstrate({
      streams: [
        sse(
          ev('error', { code: 'subscription_overloaded', message: 'q' }),
          ev('end', { reason: 'subscription_overloaded' })
        ),
        sse(ev('error', { code: 'policy_denied', message: 'no' }))
      ]
    });
    const { events, sleeps } = await run({ fetchImpl: h.fetchImpl });
    expect(sleeps).toEqual([1000]);
    expect(events.at(-1)).toEqual({ type: 'status', state: 'disabled', reason: 'policy_denied' });
    expect(h.subs).toHaveLength(2);
  });

  it('treats idleMs of silence as a dead stream', async () => {
    const stalled = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(ev('snapshot', { key: 'k', rows: [] })));
      }
    }); // never closes
    const h = fakeSubstrate({ streams: [stalled] });
    const { events } = await run({ fetchImpl: h.fetchImpl, idleMs: 20 });
    expect(events.some((e) => e.state === 'reconnecting' && /idle/.test(e.reason))).toBe(true);
  });

  it('overload escalates the backoff even after a snapshot', async () => {
    const ov = () =>
      sse(
        ev('snapshot', { key: 'k', rows: [] }),
        ev('error', { code: 'subscription_overloaded', message: 'q' })
      );
    const h = fakeSubstrate({ streams: [ov(), ov()] });
    const { sleeps } = await run({ fetchImpl: h.fetchImpl });
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('malformed event data degrades instead of throwing', async () => {
    const h = fakeSubstrate({
      streams: [
        sse(
          ev('snapshot', 'junk'),
          ev('snapshot', { key: 'k', rows: 'nope' }),
          ev('snapshot', null),
          ev('add', null),
          ev('add', { key: 'k' }),
          ev('add', { key: 'k', row: 'x' }),
          ev('remove', null),
          ev('remove', { removedId: 5 }),
          ev('add', { key: 'k', row: row(9, '2020-01-01T00:00:00Z') })
        )
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
        sse(
          ev('snapshot', {
            key: 'k',
            rows: [
              row(1, '2026-10-06T00:00:00.123Z'),
              row(2, '2026-10-05T23:59:59Z'),
              row(3, 'garbage'),
              row(4, '2026-10-06T00:00:00Z') // exactly since: re-emitted, the bridge dedupes by id
            ]
          })
        )
      ]
    });
    const { events } = await run({ fetchImpl: h.fetchImpl });
    expect(events.filter((e) => e.type === 'message').map((e) => e.shortId)).toEqual([1, 3, 4]);
  });

  it('a transient identity-lookup failure backs off and recovers', async () => {
    const h = fakeSubstrate({
      lookups: [new Error('fetch failed'), 503],
      streams: [sse(ev('snapshot', { key: 'k', rows: [] }))]
    });
    const { events, sleeps } = await run({ fetchImpl: h.fetchImpl });
    expect(events.slice(0, 2)).toMatchObject([
      { type: 'status', state: 'reconnecting', reason: 'identity lookup: fetch failed' },
      { type: 'status', state: 'reconnecting', reason: 'identity lookup: substrate/query 503' }
    ]);
    expect(events[2]).toEqual({ type: 'status', state: 'live', config: { wake: false } });
    // 1 s and 2 s for the lookup; the lookup's success resets the attempt, so the dropped
    // stream backs off from 1 s again before the closing 401.
    expect(sleeps).toEqual([1000, 2000, 1000]);
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

    const busy = fakeSubstrate({ streams: [429, 408] });
    const r2 = await run({ fetchImpl: busy.fetchImpl });
    expect(r2.sleeps).toEqual([1000, 2000]);
    expect(busy.subs).toHaveLength(3); // 429, 408, then the closing 401
  });

  it('server_restart with no snapshot resubscribes at once three times, then backs off', async () => {
    const restart = () => sse(ev('end', { reason: 'server_restart' }));
    const h = fakeSubstrate({ streams: [restart(), restart(), restart(), restart()] });
    const { events, sleeps } = await run({ fetchImpl: h.fetchImpl });
    expect(sleeps).toEqual([1000]); // only the fourth
    expect(events.filter((e) => e.state === 'reconnecting')).toEqual([
      { type: 'status', state: 'reconnecting', reason: 'server_restart' }
    ]);
    expect(h.subs).toHaveLength(5);
  });

  it('a snapshot resets the server_restart count', async () => {
    const restart = () => sse(ev('end', { reason: 'server_restart' }));
    const h = fakeSubstrate({
      streams: [
        restart(),
        restart(),
        restart(),
        sse(ev('snapshot', { key: 'k', rows: [] }), ev('end', { reason: 'server_restart' })),
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
