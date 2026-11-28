// The relay's sending side: `sendAgentMessage` to an agent on a peer server stores the message as
// pending, and `drainOutbox` hands it to the peer's `cortext-relay/deliver` after commit and on a
// schedule, retrying with backoff and bouncing to the sender what cannot be delivered.

import { generateKeyPairSync, randomUUID, verify as verifySignature } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Row, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainOutbox } from '../src/relay/outbox.js';
import { createRelayRuntime, type RelayRuntime } from '../src/relay/runtime.js';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'cortext';
const MAIL_DOMAIN = 'substrate.example.org';
const SENDER = 'agent-a@host-a.example';
const NEIGHBOUR = 'agent-c@host-a.example';
const REMOTE = 'agent-b@host-b.example';
const STRAY = 'agent-d@host-d.example';
const PEER_DOMAIN = 'peer.example.net';
const ORIGIN = 'https://peer.example.net';
// A second peer, for mail that must not wait behind the first.
const REMOTE_TWO = 'agent-e@host-e.example';
const PEER_TWO_DOMAIN = 'peer-two.example.net';
const ORIGIN_TWO = 'https://peer-two.example.net';
const OUT_KID = 'relay-out@substrate.example.org';
const DELIVER = 'cortext-relay/deliver';
const MINUTE = 60_000;
// Both peers have passed a directory sync, so mail may go to them.
const SYNCED_AT = '2026-11-27T00:00:00.000Z';

interface Envelope {
  data?: Record<string, unknown>;
  errors?: Array<{ code: string; message: string }>;
}
interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, { params: Record<string, unknown> }>;
}
type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

const json = (env: unknown, status = 200): Response =>
  new Response(JSON.stringify(env), { status, headers: { 'content-type': 'application/json' } });
const accepted = (): Response =>
  json({ data: { [DELIVER]: { id: randomUUID(), shortId: 7, duplicate: false } } });
const refused = (code: string): Response =>
  json({ data: {}, errors: [{ code, message: `deliver: ${code}` }] });
const text = (res: SubstrateResponse): string => {
  const b = res.body;
  if (b === undefined || typeof b === 'string') return b ?? '';
  return b instanceof Uint8Array ? Buffer.from(b).toString('utf8') : '';
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/**
 * A sender with two local agents, an agent on each of two peers and one on a domain no peer
 * serves. The plugin's own post-commit hook is left out unless `hook` is set, so each test drains
 * when it chooses.
 */
async function setup(opts: { mailDomain?: string | undefined; hook?: boolean } = {}) {
  const mailDomain = 'mailDomain' in opts ? opts.mailDomain : MAIL_DOMAIN;
  const dir = mkdtempSync(join(tmpdir(), 'cortext-outbox-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const keyPath = join(dir, 'relay.key');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  let skew = 0;
  const now = () => new Date(Date.now() + skew);
  const calls: Call[] = [];
  const h = { respond: (() => accepted()) as Responder };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    return h.respond(url, init);
  }) as unknown as typeof fetch;

  const plugin = buildClaudeForTest(
    { namespace: NS, ...(mailDomain !== undefined ? { mailDomain } : {}) },
    { relay: { fetchImpl, now } }
  );
  const { onCommittedWrites: _hook, ...withoutHook } = plugin;
  const server = new MemorySubstrateServer();
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: {
      [NS]: new MemoryDataset({ namespace: NS }),
      architecture: new MemoryDataset({ namespace: 'architecture' }),
      'cortext-relay': new MemoryDataset({ namespace: 'cortext-relay' })
    },
    coordinators: [opts.hook === true ? plugin : withoutHook],
    auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' }
  });
  await server.start();
  cleanup.push(() => composed.stop());

  const ds = composed.engine.datasetFor(NS);
  if (ds === undefined) throw new Error(`no dataset for ${NS}`);
  await ds.write('MailPeer', [
    {
      id: 'peer',
      domain: PEER_DOMAIN,
      origin: ORIGIN,
      inboundKid: 'relay-in@peer.example.net',
      outboundKid: OUT_KID,
      outboundKeyPath: keyPath,
      active: true,
      lastSyncAt: SYNCED_AT
    },
    {
      id: 'peer-two',
      domain: PEER_TWO_DOMAIN,
      origin: ORIGIN_TWO,
      inboundKid: 'relay-in@peer-two.example.net',
      outboundKid: OUT_KID,
      outboundKeyPath: keyPath,
      active: true,
      lastSyncAt: SYNCED_AT
    }
  ]);
  await ds.write('AgentIdentity', [
    { id: 'sender', kid: SENDER, host: 'host-a.example', active: true },
    { id: 'neighbour', kid: NEIGHBOUR, host: 'host-a.example', active: true },
    { id: 'remote', kid: REMOTE, host: '', domain: PEER_DOMAIN, active: true },
    { id: 'remote-two', kid: REMOTE_TWO, host: '', domain: PEER_TWO_DOMAIN, active: true },
    { id: 'stray', kid: STRAY, host: '', domain: 'nowhere.example.net', active: true }
  ]);

  const metrics: Array<{ name: string; payload: unknown }> = [];
  const rt: RelayRuntime = createRelayRuntime(
    { namespace: NS, mailDomain: mailDomain ?? '' },
    {
      engine: composed.engine,
      fetchImpl,
      now,
      metric: (name, payload) => metrics.push({ name, payload })
    }
  );
  const send = async (params: Record<string, unknown>, kid = SENDER) => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${signHs256(
          { sub: kid, exp: Math.floor(Date.now() / 1000) + 3600, capabilities: ['read', 'mutate'] },
          'test-secret',
          { kid: 'test' }
        )}`
      },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/sendAgentMessage`]: { params, fields: { id: true, recipient: true } }
        })
      )
    });
    const env = JSON.parse(text(res)) as Envelope;
    return {
      errors: env.errors,
      sent: (env.data?.[`${NS}/sendAgentMessage`] ?? []) as Array<{ id: string; recipient: string }>
    };
  };
  /** One message to REMOTE, returning its id. */
  const sendRemote = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const { errors, sent } = await send({
      to: REMOTE,
      subject: 'hello',
      body: 'over there',
      ...extra
    });
    expect(errors).toBeUndefined();
    return String(sent[0]?.id);
  };
  const message = async (id: string): Promise<Row | undefined> =>
    (await ds.read('AgentMessage', { id })).rows[0];
  const messages = async (): Promise<Row[]> => (await ds.read('AgentMessage', {})).rows;
  const bounces = async (): Promise<Row[]> =>
    (await messages()).filter((m) => Array.isArray(m.tags) && m.tags.includes('system:bounce'));
  return {
    ds,
    rt,
    composed,
    plugin,
    keyPath,
    publicKey,
    calls,
    metrics,
    h,
    send,
    sendRemote,
    message,
    messages,
    bounces,
    advance: (ms: number) => {
      skew += ms;
    }
  };
}

describe('sendAgentMessage to an agent on a peer server', () => {
  it('stores a send to a remote row as pending and does not call out inside the mutation', async () => {
    const { send, message, calls } = await setup();
    const before = Date.now();
    const { errors, sent } = await send({ to: [REMOTE, NEIGHBOUR], subject: 'hello', body: 'b' });
    expect(errors).toBeUndefined();
    expect(calls).toHaveLength(0);
    const remote = await message(String(sent.find((s) => s.recipient === 'remote')?.id));
    expect(remote).toMatchObject({ delivery: 'pending', deliveryAttempts: 0 });
    expect(Date.parse(String(remote?.deliveryNextAt))).toBeGreaterThanOrEqual(before);
    // Local mail carries no delivery state.
    const local = await message(String(sent.find((s) => s.recipient === 'neighbour')?.id));
    expect(local?.delivery ?? null).toBeNull();
    expect(local?.deliveryNextAt ?? null).toBeNull();
  });

  it('refuses a remote recipient when no active peer serves its domain', async () => {
    const { send, messages, ds } = await setup();
    const none = await send({ to: [NEIGHBOUR, STRAY], subject: 's', body: 'b' });
    expect(none.errors?.[0]?.code).toBe('relay_unavailable');
    expect(none.errors?.[0]?.message).toContain('nowhere.example.net');
    await ds.write('MailPeer', [{ id: 'peer', active: false }]);
    const off = await send({ to: REMOTE, subject: 's', body: 'b' });
    expect(off.errors?.[0]?.code).toBe('relay_unavailable');
    expect(off.errors?.[0]?.message).toContain(PEER_DOMAIN);
    expect(off.errors?.[0]?.message).toContain('switched off');
    expect(await messages()).toHaveLength(0);
  });

  it('refuses when the peer is blocked, quoting blockedReason', async () => {
    const { send, messages, ds } = await setup();
    await ds.write('MailPeer', [
      { id: 'peer', blockedReason: 'peer answers mail reads without a key' }
    ]);
    const { errors } = await send({ to: REMOTE, subject: 's', body: 'b' });
    expect(errors?.[0]?.code).toBe('relay_unavailable');
    expect(errors?.[0]?.message).toContain(PEER_DOMAIN);
    expect(errors?.[0]?.message).toContain('peer answers mail reads without a key');
    expect(await messages()).toHaveLength(0);
  });

  it('refuses a remote recipient on a server without a mail domain', async () => {
    const { send, messages } = await setup({ mailDomain: undefined });
    const { errors } = await send({ to: REMOTE, subject: 's', body: 'b' });
    expect(errors?.[0]?.code).toBe('relay_unavailable');
    expect(errors?.[0]?.message).toContain(PEER_DOMAIN);
    expect(await messages()).toHaveLength(0);
  });

  it.each([
    ['a 201-character subject', { subject: 'x'.repeat(201), body: 'b' }],
    ['a 65,537-byte body', { subject: 's', body: 'x'.repeat(65_537) }]
  ])('refuses %s to a remote recipient before writing anything', async (_case, content) => {
    const { send, messages } = await setup();
    const { errors } = await send({ to: [NEIGHBOUR, REMOTE], ...content });
    expect(errors?.[0]?.code).toBe('too_large');
    expect(await messages()).toHaveLength(0);
    // Local mail keeps no such cap.
    expect((await send({ to: NEIGHBOUR, ...content })).errors).toBeUndefined();
  });
});

describe('drainOutbox', () => {
  it('delivers on drain: one POST to <origin>/substrate/v1/mutate with v:1, messageId, from, to, subject, body', async () => {
    const { rt, sendRemote, calls, publicKey } = await setup();
    const id = await sendRemote({ instance: 'session:1a2b3c4d', tags: ['priority:urgent'] });
    expect(await drainOutbox(rt)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`${ORIGIN}/substrate/v1/mutate`);
    expect(call?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    // Relayed mail carries no tags.
    expect(call?.body[DELIVER]?.params).toEqual({
      v: 1,
      messageId: id,
      from: SENDER,
      to: REMOTE,
      subject: 'hello',
      body: 'over there',
      instance: 'session:1a2b3c4d'
    });
    // Signed with the peer row's outbound key, for the peer's origin and the relay alone.
    const auth = (call?.init.headers as Record<string, string> | undefined)?.authorization ?? '';
    const [head, payload, sig] = auth.replace(/^Bearer /, '').split('.') as [
      string,
      string,
      string
    ];
    expect(
      verifySignature(
        null,
        Buffer.from(`${head}.${payload}`),
        publicKey,
        Buffer.from(sig, 'base64url')
      )
    ).toBe(true);
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toMatchObject({ kid: OUT_KID });
    // Good for the relay namespace only, whatever the peer granted the key.
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
      sub: OUT_KID,
      aud: ORIGIN,
      ns: ['cortext-relay']
    });
  });

  it('marks delivered and makes no second call on the next drain', async () => {
    const { rt, sendRemote, message, calls, advance } = await setup();
    const id = await sendRemote();
    await drainOutbox(rt);
    expect(await message(id)).toMatchObject({ delivery: 'delivered', deliveryAttempts: 1 });
    expect((await message(id))?.deliveryNextAt ?? null).toBeNull();
    advance(2 * 60 * MINUTE);
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 0, failed: 0 });
    expect(calls).toHaveLength(1);
  });

  it('counts an answer naming an earlier delivery as delivered', async () => {
    const { rt, sendRemote, message, h } = await setup();
    const id = await sendRemote();
    h.respond = () => json({ data: { [DELIVER]: { id: 'r-1', shortId: 1, duplicate: true } } });
    expect(await drainOutbox(rt)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect((await message(id))?.delivery).toBe('delivered');
  });

  it('retries after 1, 2, 4 minutes on a network error', async () => {
    const { rt, sendRemote, message, calls, h, advance } = await setup();
    h.respond = () => {
      throw new TypeError('fetch failed');
    };
    const id = await sendRemote();
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect(await message(id)).toMatchObject({
      delivery: 'pending',
      deliveryAttempts: 1,
      deliveryError: 'network'
    });
    let expected = 1;
    for (const delay of [1, 2, 4]) {
      advance(delay * MINUTE - 30_000);
      await drainOutbox(rt);
      expect(calls).toHaveLength(expected);
      advance(30_000);
      await drainOutbox(rt);
      expect(calls).toHaveLength(++expected);
    }
    expect((await message(id))?.deliveryAttempts).toBe(4);
  });

  it('retries on 503 and on rate_limited', async () => {
    const { rt, sendRemote, message, calls, h, advance } = await setup();
    const id = await sendRemote();
    h.respond = () => new Response('unavailable', { status: 503 });
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect((await message(id))?.deliveryError).toBe('http_503');
    advance(MINUTE);
    h.respond = () => refused('rate_limited');
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect((await message(id))?.deliveryError).toBe('rate_limited');
    advance(2 * MINUTE);
    h.respond = () => accepted();
    expect(await drainOutbox(rt)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect(calls).toHaveLength(3);
    expect(await message(id)).toMatchObject({
      delivery: 'delivered',
      deliveryAttempts: 3,
      deliveryError: null
    });
  });

  it('retries when the answer is larger than 1 MiB', async () => {
    const { rt, sendRemote, message, h } = await setup();
    const id = await sendRemote();
    h.respond = () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 });
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect(await message(id)).toMatchObject({
      delivery: 'pending',
      deliveryError: 'answer_too_large'
    });
  });

  it.each([
    ['times out', () => Promise.reject(new DOMException('timed out', 'TimeoutError')), 'timeout'],
    ['answers 503', () => new Response('unavailable', { status: 503 }), 'http_503']
  ])(
    'calls a peer that %s once per pass and still delivers to the others',
    async (_case, dead, code) => {
      const { rt, send, sendRemote, message, calls, h } = await setup();
      h.respond = (url) => (url.startsWith(`${ORIGIN_TWO}/`) ? accepted() : dead());
      const stuck = [await sendRemote(), await sendRemote(), await sendRemote()];
      const { sent } = await send({ to: REMOTE_TWO, subject: 'hello', body: 'b' });
      expect(await drainOutbox(rt)).toEqual({ delivered: 1, retried: 3, failed: 0 });
      expect(calls.filter((c) => c.url.startsWith(`${ORIGIN}/`))).toHaveLength(1);
      expect(calls.filter((c) => c.url.startsWith(`${ORIGIN_TWO}/`))).toHaveLength(1);
      expect((await message(String(sent[0]?.id)))?.delivery).toBe('delivered');
      for (const id of stuck) {
        expect(await message(id)).toMatchObject({
          delivery: 'pending',
          deliveryAttempts: 1,
          deliveryError: code
        });
      }
    }
  );

  it("keeps none of a peer's own text in the row or the bounce", async () => {
    const { rt, sendRemote, message, bounces, h, advance } = await setup();
    const marker = 'peer-written-';
    h.respond = () =>
      json({
        data: {},
        errors: [{ code: marker.repeat(770).slice(0, 10_000), message: marker.repeat(5_000) }]
      });
    const id = await sendRemote();
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect((await message(id))?.deliveryError).toBe('refused');
    // A known code keeps its name; its message is not kept either.
    advance(MINUTE);
    h.respond = () =>
      json({ data: {}, errors: [{ code: 'unknown_recipient', message: marker.repeat(5_000) }] });
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 0, failed: 1 });
    expect((await message(id))?.deliveryError).toBe('unknown_recipient');
    const [bounce] = await bounces();
    expect(bounce?.body).toBe(
      `Your message to ${REMOTE} on ${PEER_DOMAIN} was not delivered: that server has no active agent of that name.`
    );
    expect(JSON.stringify([await message(id), bounce])).not.toContain(marker);
  });

  it.each([
    'unknown_recipient',
    'foreign_sender',
    'unknown_peer',
    'too_large',
    'unsupported_version',
    'kid_collision',
    'invalid_param',
    'unknown_param'
  ])('fails at once and bounces on %s', async (code) => {
    const { rt, sendRemote, message, bounces, calls, h, advance } = await setup();
    h.respond = () => refused(code);
    const id = await sendRemote();
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 0, failed: 1 });
    expect(calls).toHaveLength(1);
    expect(await message(id)).toMatchObject({
      delivery: 'failed',
      deliveryError: code
    });
    expect((await message(id))?.deliveryNextAt ?? null).toBeNull();
    const [bounce, ...more] = await bounces();
    expect(more).toHaveLength(0);
    expect(bounce).toMatchObject({
      recipient: 'sender',
      subject: 'Undelivered: hello',
      tags: ['system:bounce'],
      inReplyTo: id,
      _metadata: expect.objectContaining({ createdBy: { kind: 'system', id: 'cortext:relay' } })
    });
    const opening = `Your message to ${REMOTE} on ${PEER_DOMAIN} was not delivered: `;
    expect(String(bounce?.body).startsWith(opening)).toBe(true);
    expect(bounce?.body).toMatch(/[^ ]\.$/);
    // The peer's message is not quoted.
    expect(bounce?.body).not.toContain('deliver:');
    advance(2 * 60 * MINUTE);
    await drainOutbox(rt);
    expect(calls).toHaveLength(1);
  });

  it('fails and bounces 24 hours after createdAt', async () => {
    const { rt, sendRemote, message, bounces, calls, h, advance } = await setup();
    h.respond = () => new Response('unavailable', { status: 503 });
    const id = await sendRemote();
    await drainOutbox(rt);
    advance(24 * 60 * MINUTE - 30_000);
    await drainOutbox(rt);
    expect(calls).toHaveLength(2);
    expect((await message(id))?.delivery).toBe('pending');
    // The next attempt falls due after the 24 hours: the row fails instead of being sent.
    advance(2 * MINUTE);
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 0, failed: 1 });
    expect(calls).toHaveLength(2);
    expect(await message(id)).toMatchObject({
      delivery: 'failed',
      deliveryError: 'expired'
    });
    const [bounce, ...more] = await bounces();
    expect(more).toHaveLength(0);
    expect(bounce?.body).toContain('within 24 hours');
  });

  it.each([
    ['switched off', { active: false }, 'peer_inactive', 'switched off'],
    ['blocked', { blockedReason: 'abuse report' }, 'peer_blocked', 'blocked']
  ])('fails and bounces queued mail when the peer is %s', async (_case, patch, code, reason) => {
    const { rt, sendRemote, message, bounces, calls, ds } = await setup();
    const id = await sendRemote();
    await ds.write('MailPeer', [{ id: 'peer', ...patch }]);
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 0, failed: 1 });
    expect(calls).toHaveLength(0);
    expect(await message(id)).toMatchObject({
      delivery: 'failed',
      deliveryError: code
    });
    const [bounce] = await bounces();
    expect(bounce?.body).toContain(reason);
    expect(bounce?.body).not.toContain('abuse report');
  });

  it('stays pending when the key file is missing, naming the path only to the operator', async () => {
    const { rt, sendRemote, message, bounces, calls, metrics, ds, keyPath, advance } =
      await setup();
    const missing = join(keyPath, '..', 'missing.key');
    await ds.write('MailPeer', [{ id: 'peer', outboundKeyPath: missing }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const id = await sendRemote();
      expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 1, failed: 0 });
      expect(calls).toHaveLength(0);
      expect(await message(id)).toMatchObject({
        delivery: 'pending',
        deliveryAttempts: 1,
        deliveryError: 'key_unusable'
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(missing));
      expect(metrics).toContainEqual({
        name: 'cortext.mail_key_unusable',
        payload: expect.objectContaining({ error: expect.stringContaining(missing) })
      });
      // Nor does the bounce, once it gives up.
      advance(24 * 60 * MINUTE);
      expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 0, failed: 1 });
      expect(await bounces()).toHaveLength(1);
      expect(JSON.stringify([await message(id), ...(await bounces())])).not.toContain(missing);
    } finally {
      warn.mockRestore();
    }
  });

  it('holds queued mail for a peer not checked yet, without a request or a bounce', async () => {
    const { rt, sendRemote, message, bounces, calls, ds, advance } = await setup();
    const id = await sendRemote();
    await ds.write('MailPeer', [{ id: 'peer', lastSyncAt: null }]);
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect(calls).toHaveLength(0);
    expect(await message(id)).toMatchObject({
      delivery: 'pending',
      deliveryAttempts: 1,
      deliveryError: 'peer_unchecked'
    });
    expect(await bounces()).toHaveLength(0);
    // Once the peer has been checked, the next pass delivers it.
    await ds.write('MailPeer', [{ id: 'peer', lastSyncAt: SYNCED_AT }]);
    advance(MINUTE);
    expect(await drainOutbox(rt)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect(calls).toHaveLength(1);
  });

  it('still gives up 24 hours after createdAt on a peer never checked', async () => {
    const { rt, sendRemote, message, bounces, calls, ds, advance } = await setup();
    const id = await sendRemote();
    await ds.write('MailPeer', [{ id: 'peer', lastSyncAt: null }]);
    advance(24 * 60 * MINUTE);
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 0, failed: 1 });
    expect(calls).toHaveLength(0);
    expect(await message(id)).toMatchObject({ delivery: 'failed', deliveryError: 'expired' });
    expect(await bounces()).toHaveLength(1);
  });

  it('never bounces a bounce', async () => {
    const { rt, sendRemote, message, bounces, h } = await setup();
    h.respond = () => refused('unknown_recipient');
    const id = await sendRemote({ tags: ['system:bounce'] });
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 0, failed: 1 });
    expect((await message(id))?.delivery).toBe('failed');
    expect((await bounces()).map((b) => b.id)).toEqual([id]);
  });

  it('two concurrent drains send one request', async () => {
    const { rt, sendRemote, calls } = await setup();
    await sendRemote();
    await Promise.all([drainOutbox(rt), drainOutbox(rt)]);
    expect(calls).toHaveLength(1);
    // Two runtimes, as two processes would be: the claim lets one of them send.
    const other = { ...rt };
    await sendRemote();
    const results = await Promise.all([drainOutbox(rt), drainOutbox(other)]);
    expect(calls).toHaveLength(2);
    expect(results.reduce((n, r) => n + r.delivered, 0)).toBe(1);
  });

  it("sends the parent's remoteId when replying to relayed mail", async () => {
    const { rt, sendRemote, calls, ds } = await setup();
    await ds.write('AgentMessage', [
      {
        id: 'relayed-1',
        recipient: 'sender',
        subject: 'q',
        body: 'b',
        status: 'unread',
        viaDomain: PEER_DOMAIN,
        remoteId: 'their-id-1'
      },
      {
        id: 'relayed-2',
        recipient: 'sender',
        subject: 'q',
        body: 'b',
        status: 'unread',
        viaDomain: 'other.example.net',
        remoteId: 'their-id-2'
      },
      { id: 'local-1', recipient: 'sender', subject: 'q', body: 'b', status: 'unread' }
    ]);
    await sendRemote({ inReplyTo: 'relayed-1' });
    await sendRemote({ inReplyTo: 'relayed-2' });
    await sendRemote({ inReplyTo: 'local-1' });
    await drainOutbox(rt);
    expect(calls.map((c) => c.body[DELIVER]?.params.inReplyToRemoteId)).toEqual([
      'their-id-1',
      'relayed-2',
      'local-1'
    ]);
  });

  it('delivers after commit through the plugin hook', async () => {
    const { send, message, calls } = await setup({ hook: true });
    const { sent } = await send({ to: REMOTE, subject: 'hello', body: 'b' });
    const id = String(sent[0]?.id);
    await vi.waitFor(async () => expect((await message(id))?.delivery).toBe('delivered'));
    expect(calls).toHaveLength(1);
  });

  it('is accepted by a receiving server', async () => {
    const sender = await setup();
    // The receiving server knows this server's relay key and has REMOTE as a local agent.
    const system = new MemoryDataset({ namespace: '_system' });
    await system.write('Key', [
      {
        id: 'k-relay',
        kid: OUT_KID,
        algorithm: 'EdDSA',
        publicKey: sender.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        namespaces: 'cortext-relay',
        capabilities: 'read,mutate',
        revokedAt: null
      }
    ]);
    const server = new MemorySubstrateServer();
    const receiver = await compose({
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      datasets: {
        _system: system,
        [NS]: new MemoryDataset({ namespace: NS }),
        architecture: new MemoryDataset({ namespace: 'architecture' }),
        'cortext-relay': new MemoryDataset({ namespace: 'cortext-relay' })
      },
      coordinators: [buildClaudeForTest({ namespace: NS, mailDomain: PEER_DOMAIN })],
      auth: { keys: [], mode: 'attribute' }
    });
    await server.start();
    cleanup.push(() => receiver.stop());
    const rds = receiver.engine.datasetFor(NS);
    if (rds === undefined) throw new Error('no receiving dataset');
    await rds.write('MailPeer', [
      {
        id: 'back',
        domain: MAIL_DOMAIN,
        origin: 'https://substrate.example.org',
        inboundKid: OUT_KID,
        outboundKid: 'relay-out@peer.example.net',
        outboundKeyPath: '/etc/substrate/keys/relay.key',
        active: true
      }
    ]);
    await rds.write('AgentIdentity', [
      { id: 'b', kid: REMOTE, host: 'host-b.example', active: true }
    ]);
    sender.h.respond = async (url, init) => {
      const res = await server.inject({
        method: 'POST',
        path: new URL(url).pathname,
        headers: init.headers as Record<string, string>,
        body: Buffer.from(String(init.body))
      });
      return new Response(text(res), { status: res.status });
    };
    const id = await sender.sendRemote({ instance: 'session:1a2b3c4d' });
    expect(await drainOutbox(sender.rt)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    const [arrived] = (await rds.read('AgentMessage', {})).rows;
    expect(arrived).toMatchObject({
      recipient: 'b',
      subject: 'hello',
      body: 'over there',
      instance: 'session:1a2b3c4d',
      remoteFrom: SENDER,
      viaDomain: MAIL_DOMAIN,
      remoteId: id
    });
  });
});

describe('outbox wiring', () => {
  it('registers no outbox schedule without mailDomain', () => {
    const off = buildClaudeForTest({ namespace: NS });
    expect((off.schedule ?? []).map((t) => t.name)).not.toContain(`${NS}-mail-outbox`);
    expect(off.onCommittedWrites).toBeUndefined();
    const on = buildClaudeForTest({ namespace: NS, mailDomain: MAIL_DOMAIN });
    expect(on.schedule?.find((t) => t.name === `${NS}-mail-outbox`)).toMatchObject({
      intervalMs: 60_000
    });
    expect(on.onCommittedWrites).toBeTypeOf('function');
  });
});
