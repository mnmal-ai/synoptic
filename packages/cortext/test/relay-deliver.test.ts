// The relay's receiving side: `cortext-relay/deliver` called by a peer's relay key writes one
// message into this server's mailbox, after checking the version, the peer, the shape, the sizes
// and the rate, then (under the message's lock) whether it was delivered before, the recipient
// and the sender, in that order.

import { generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import type { CommittedWriteBatch, EdgesStore, Row } from '@mnmal-ai/substrate/sdk';
import { compose, MemoryDataset, MemorySubstrateServer } from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { upsertRemoteIdentity } from '../src/relay/deliver.js';
import { createRelayRuntime } from '../src/relay/runtime.js';
import { buildClaudeForTest } from './_helpers.js';

const LOCAL = 'agent-a@host-a.example';
const GONE = 'gone@host-a.example';
// A local kid whose host part is not a host of this server, as older short-host kids are.
const LEGACY = 'legacy@oldname';
const SENDER = 'agent-b@host-b.example';
const OTHER_REMOTE = 'agent-c@host-c.example';
const PEER = 'relay-peer@peer.example.net';
const STRANGER = 'stranger@peer.example.net';
const PEER_DOMAIN = 'peer.example.net';
interface Envelope {
  data?: Record<string, unknown>;
  errors?: Array<{ code: string; message: string }>;
}
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

/** A receiver with one peer, a local agent, a retired local agent and a remote agent of another domain. */
async function setup(opts: { namespace?: string; now?: () => Date } = {}) {
  const ns = opts.namespace ?? 'cortext';
  const grants: Record<string, { namespaces: string; capabilities: string }> = {
    [PEER]: { namespaces: 'cortext-relay', capabilities: 'read,mutate' },
    [STRANGER]: { namespaces: 'cortext-relay', capabilities: 'read,mutate' }
  };
  const privateKeys = new Map<string, KeyObject>();
  const system = new MemoryDataset({ namespace: '_system' });
  await system.write(
    'Key',
    Object.entries(grants).map(([kid, g], i) => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      privateKeys.set(kid, privateKey);
      return {
        id: `k${i}`,
        kid,
        algorithm: 'EdDSA',
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        ...g,
        revokedAt: null
      };
    })
  );
  const batches: CommittedWriteBatch[] = [];
  const coordinator = buildClaudeForTest(
    { namespace: ns, mailDomain: 'substrate.example.org' },
    opts.now !== undefined ? { relay: { now: opts.now } } : {}
  );
  // The edges store the namespaces install with, for calling upsertRemoteIdentity directly.
  let edges: EdgesStore | undefined;
  const relayNs = coordinator.namespaces.find((n) => n.namespace === 'cortext-relay');
  const install = relayNs?.install.bind(relayNs);
  if (relayNs !== undefined && install !== undefined) {
    relayNs.install = (ctx) => {
      edges = ctx.edges;
      return install(ctx);
    };
  }
  const server = new MemorySubstrateServer();
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: {
      _system: system,
      [ns]: new MemoryDataset({ namespace: ns }),
      architecture: new MemoryDataset({ namespace: 'architecture' }),
      'cortext-relay': new MemoryDataset({ namespace: 'cortext-relay' })
    },
    coordinators: [{ ...coordinator, onCommittedWrites: (b) => void batches.push(b) }],
    auth: { keys: [], mode: 'attribute' }
  });
  await server.start();
  stop = () => composed.stop();

  const ds = composed.engine.datasetFor(ns);
  if (ds === undefined) throw new Error(`no dataset for ${ns}`);
  await ds.write('MailPeer', [
    {
      id: 'p1',
      domain: PEER_DOMAIN,
      origin: 'https://peer.example.net:3100',
      inboundKid: PEER,
      outboundKid: 'relay-out@substrate.example.org',
      outboundKeyPath: '/etc/substrate/keys/relay.key',
      active: true
    }
  ]);
  await ds.write('AgentIdentity', [
    { id: 'local', kid: LOCAL, host: 'host-a.example', active: true },
    { id: 'gone', kid: GONE, host: 'host-a.example', active: false },
    { id: 'legacy', kid: LEGACY, host: 'host-a.example', active: true },
    { id: 'other', kid: OTHER_REMOTE, host: '', domain: 'other.example.net', active: true }
  ]);

  const token = (kid: string) => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
    const body = b64url(
      JSON.stringify({
        sub: kid,
        iat: now,
        exp: now + 3600,
        ns: ['*'],
        capabilities: ['read', 'mutate']
      })
    );
    const sig = sign(null, Buffer.from(`${head}.${body}`), privateKeys.get(kid) as KeyObject);
    return `${head}.${body}.${b64url(sig)}`;
  };
  const deliver = async (params: Record<string, unknown>, kid = PEER) => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token(kid)}` },
      body: Buffer.from(
        JSON.stringify({
          'cortext-relay/deliver': { params, fields: { id: true, shortId: true, duplicate: true } }
        })
      )
    });
    const env = JSON.parse(Buffer.from(res.body as Uint8Array).toString('utf8')) as Envelope;
    return {
      errors: env.errors,
      result: env.data?.['cortext-relay/deliver'] as
        | { id: string; shortId: number; duplicate: boolean }
        | undefined
    };
  };
  const messages = async (): Promise<Row[]> => (await ds.read('AgentMessage', {})).rows;
  const identity = async (kid: string): Promise<Row | undefined> =>
    (await ds.read('AgentIdentity', { where: { kid: { eq: kid } } })).rows[0];
  const identities = async (): Promise<Row[]> => (await ds.read('AgentIdentity', {})).rows;
  const rt = createRelayRuntime(
    { namespace: ns, mailDomain: 'substrate.example.org' },
    { engine: composed.engine, edges }
  );
  return { deliver, messages, identity, identities, ds, batches, rt };
}

const payload = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  messageId: randomUUID(),
  from: SENDER,
  to: LOCAL,
  subject: 'hello',
  body: 'a message from the other server',
  ...extra
});

describe('cortext-relay/deliver', () => {
  it('stores a message for a local agent and returns its id', async () => {
    const { deliver, messages, batches } = await setup();
    const sent = payload({ instance: 'session:1a2b3c4d' });
    const { errors, result } = await deliver(sent);
    expect(errors).toBeUndefined();
    expect(result).toEqual({
      id: expect.any(String),
      shortId: expect.any(Number),
      duplicate: false
    });
    const [row] = await messages();
    expect(row).toMatchObject({
      id: result?.id,
      shortId: result?.shortId,
      recipient: 'local',
      subject: 'hello',
      body: 'a message from the other server',
      instance: 'session:1a2b3c4d',
      status: 'unread',
      archived: false,
      remoteFrom: SENDER,
      viaDomain: PEER_DOMAIN,
      remoteId: sent.messageId
    });
    // Stamped with the relay key that signed the delivery; the sender is remoteFrom.
    expect(row?._metadata).toMatchObject({ createdBy: { kind: 'agent', id: PEER } });
    expect(row?.tags ?? null).toBeNull();
    // Inbox subscriptions and coordinator hooks hear of it as of a local send.
    expect(batches).toContainEqual(
      expect.objectContaining({
        namespace: 'cortext',
        type: 'AgentMessage',
        operation: 'create',
        ids: [result?.id]
      })
    );
  });

  it('creates the remote sender identity on first contact', async () => {
    const { deliver, identity } = await setup();
    expect(await identity(SENDER)).toBeUndefined();
    expect((await deliver(payload())).errors).toBeUndefined();
    expect(await identity(SENDER)).toMatchObject({
      kid: SENDER,
      domain: PEER_DOMAIN,
      host: '',
      active: true,
      roaming: false,
      shortId: expect.any(Number)
    });
  });

  it('returns the first result on a repeat messageId', async () => {
    const { deliver, messages } = await setup();
    const sent = payload();
    const first = await deliver(sent);
    const again = await deliver(sent);
    expect(again.errors).toBeUndefined();
    expect(again.result).toEqual({ ...first.result, duplicate: true });
    expect(await messages()).toHaveLength(1);
  });

  it('returns the first result after its recipient is made inactive', async () => {
    const { deliver, ds } = await setup();
    const sent = payload();
    const first = await deliver(sent);
    await ds.write('AgentIdentity', [
      { id: 'local', kid: LOCAL, host: 'host-a.example', active: false }
    ]);
    expect((await deliver(payload())).errors?.[0]?.code).toBe('unknown_recipient');
    const again = await deliver(sent);
    expect(again.errors).toBeUndefined();
    expect(again.result).toEqual({ ...first.result, duplicate: true });
  });

  it('creates no identity for a repeat naming a different sender', async () => {
    const { deliver, identity, batches } = await setup();
    const sent = payload();
    await deliver(sent);
    const announced = batches.length;
    const again = await deliver({ ...sent, from: 'someone-else@host-z.example' });
    expect(again.result?.duplicate).toBe(true);
    expect(await identity('someone-else@host-z.example')).toBeUndefined();
    expect(batches).toHaveLength(announced);
  });

  it('threads a reply to mail this server sent', async () => {
    const { deliver, messages, ds } = await setup();
    await ds.write('AgentMessage', [
      { id: 'sent-1', recipient: 'other', subject: 'question', body: 'b', status: 'unread' }
    ]);
    const { result } = await deliver(payload({ inReplyToRemoteId: 'sent-1' }));
    const row = (await messages()).find((m) => m.id === result?.id);
    expect(row?.inReplyTo).toBe('sent-1');
  });

  it('threads a reply to mail this peer delivered earlier', async () => {
    const { deliver, messages } = await setup();
    const parent = payload();
    const first = await deliver(parent);
    expect(first.errors).toBeUndefined();
    const { result } = await deliver(payload({ inReplyToRemoteId: parent.messageId }));
    const row = (await messages()).find((m) => m.id === result?.id);
    expect(row?.inReplyTo).toBe(first.result?.id);
  });

  it('arrives unthreaded when the parent is unknown', async () => {
    const { deliver, messages, ds } = await setup();
    // Another domain's message with this remoteId is not this peer's parent.
    await ds.write('AgentMessage', [
      {
        id: 'from-other',
        recipient: 'local',
        subject: 's',
        body: 'b',
        status: 'unread',
        viaDomain: 'other.example.net',
        remoteId: 'r-1'
      }
    ]);
    for (const parent of ['r-1', randomUUID()]) {
      const { errors, result } = await deliver(payload({ inReplyToRemoteId: parent }));
      expect(errors).toBeUndefined();
      const row = (await messages()).find((m) => m.id === result?.id);
      expect(row?.inReplyTo ?? null).toBeNull();
    }
  });

  it('accepts a 200-character subject, a 65,536-byte body and a 256-character messageId', async () => {
    const { deliver } = await setup();
    const { errors } = await deliver(
      payload({
        subject: '\u{1F600}'.repeat(200),
        body: 'é'.repeat(32_768),
        messageId: 'm'.repeat(256)
      })
    );
    expect(errors).toBeUndefined();
  });

  it.each([
    ['v: 2', { v: 2 }, PEER, 'unsupported_version'],
    ['signer is no peer', {}, STRANGER, 'unknown_peer'],
    ['201-character subject', { subject: 'x'.repeat(201) }, PEER, 'too_large'],
    ['65,537-byte body', { body: 'x'.repeat(65_537) }, PEER, 'too_large'],
    ['to is unknown', { to: 'nobody@host-a.example' }, PEER, 'unknown_recipient'],
    ['to is a remote row', { to: OTHER_REMOTE }, PEER, 'unknown_recipient'],
    ['to is inactive', { to: GONE }, PEER, 'unknown_recipient'],
    ['from is a local kid', { from: LEGACY }, PEER, 'foreign_sender'],
    ["from is another domain's kid", { from: OTHER_REMOTE }, PEER, 'foreign_sender']
  ])('refuses when %s', async (_case, extra, kid, code) => {
    const { deliver, messages, identities, batches } = await setup();
    const before = await identities();
    const { errors, result } = await deliver(payload(extra), kid);
    expect(result).toBeUndefined();
    expect(errors?.[0]?.code).toBe(code);
    expect(await messages()).toHaveLength(0);
    expect(await identities()).toEqual(before);
    expect(batches).toEqual([]);
  });

  it('rolls back the sender identity and announces nothing when the message write fails', async () => {
    const { deliver, messages, identity, ds, batches } = await setup();
    const write = ds.write.bind(ds);
    ds.write = async (type, rows, opts) => {
      if (type === 'AgentMessage') throw new Error('injected write failure');
      return write(type, rows, opts);
    };
    const { errors, result } = await deliver(payload());
    expect(result).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(await messages()).toHaveLength(0);
    expect(await identity(SENDER)).toBeUndefined();
    expect(batches).toEqual([]);
  });

  it.each(['messageId', 'instance', 'inReplyToRemoteId'])(
    'refuses a %s over 256 characters',
    async (key) => {
      const { deliver, messages } = await setup();
      expect((await deliver(payload({ [key]: 'r'.repeat(257) }))).errors?.[0]?.code).toBe(
        'too_large'
      );
      expect(await messages()).toHaveLength(0);
    }
  );

  it('accepts a 128-character kid and refuses a 129-character one, as from and as to', async () => {
    const { deliver, messages } = await setup();
    const host = '@host-b.example';
    const longest = `${'a'.repeat(128 - host.length)}${host}`;
    expect((await deliver(payload({ from: longest }))).errors).toBeUndefined();
    const over = `${'a'.repeat(129 - host.length)}${host}`;
    expect((await deliver(payload({ from: over }))).errors?.[0]?.code).toBe('invalid_param');
    expect((await deliver(payload({ to: over }))).errors?.[0]?.code).toBe('invalid_param');
    expect(await messages()).toHaveLength(1);
  });

  it.each([
    ['no @', 'no-at-sign'],
    ['two @', 'a@b@c.example'],
    ['an empty name', '@host-b.example'],
    ['an empty host', 'agent-b@'],
    ['a space', 'agent b@host-b.example'],
    ['a tab', 'agent-b@host-b\t.example'],
    ['a control character', 'agent-b\u0007@host-b.example'],
    ['a bidi override', 'agent-\u202eb@host-b.example'],
    ['a zero-width space', 'agent-b@host\u200b-b.example'],
    ['a Cyrillic letter in the host', 'agent-b@host-\u0430.example'],
    ['a blank-looking letter', 'agent-b@host-b\u3164.example']
  ])('refuses a kid with %s as from and as to', async (_case, bad) => {
    const { deliver, messages } = await setup();
    expect((await deliver(payload({ from: bad }))).errors?.[0]?.code).toBe('invalid_param');
    expect((await deliver(payload({ to: bad }))).errors?.[0]?.code).toBe('invalid_param');
    expect(await messages()).toHaveLength(0);
  });

  it("refuses a sender on one of this server's hosts, in any case", async () => {
    const { deliver, identity } = await setup();
    const { errors } = await deliver(payload({ from: 'intruder@HOST-A.example' }));
    expect(errors?.[0]?.code).toBe('foreign_sender');
    expect(await identity('intruder@HOST-A.example')).toBeUndefined();
  });

  it('refuses a sender on the machine in a local kid whose row has no host', async () => {
    const { deliver, identity, ds } = await setup();
    await ds.write('AgentIdentity', [
      { id: 'hostless', kid: 'agent-z@host-z.example', host: '', active: true }
    ]);
    const { errors } = await deliver(payload({ from: 'intruder@HOST-Z.example' }));
    expect(errors?.[0]?.code).toBe('foreign_sender');
    expect(await identity('intruder@HOST-Z.example')).toBeUndefined();
  });

  it("refuses its own domain's inactive sender and changes no row", async () => {
    const { deliver, identity, messages, ds, batches } = await setup();
    const asleep = { host: '', active: false };
    await ds.write('AgentIdentity', [
      { id: 'sleeper', kid: 'sleeper@host-b.example', domain: PEER_DOMAIN, ...asleep },
      { id: 'elsewhere', kid: 'agent-d@host-d.example', domain: 'other.example.net', ...asleep },
      { id: 'retired', kid: 'retired@oldname', host: 'host-a.example', active: false }
    ]);
    const untouched = ['sleeper@host-b.example', 'agent-d@host-d.example', 'retired@oldname', GONE];
    const before = await Promise.all(untouched.map(identity));
    for (const from of untouched) {
      expect((await deliver(payload({ from }))).errors?.[0]?.code).toBe('foreign_sender');
    }
    expect(await Promise.all(untouched.map(identity))).toEqual(before);
    expect(await messages()).toHaveLength(0);
    expect(batches).toEqual([]);
  });

  it("leaves a known sender's row exactly as it is", async () => {
    const { deliver, identity, ds } = await setup();
    await ds.write('AgentIdentity', [
      {
        id: 'known',
        kid: SENDER,
        host: '',
        domain: PEER_DOMAIN,
        active: true,
        listed: false,
        description: 'set by sync'
      }
    ]);
    const before = await identity(SENDER);
    expect((await deliver(payload())).errors).toBeUndefined();
    expect(await identity(SENDER)).toEqual(before);
  });

  it('refuses the 21st new sender in an hour, but not a known one, and reopens after the hour', async () => {
    let clock = new Date('2026-11-27T12:00:00.000Z');
    const { deliver, identity, messages } = await setup({ now: () => clock });
    const sender = (i: number) => `agent-${i}@host-b.example`;
    for (let i = 0; i < 20; i++) {
      expect((await deliver(payload({ from: sender(i) }))).errors).toBeUndefined();
    }
    expect((await deliver(payload({ from: sender(20) }))).errors?.[0]?.code).toBe('rate_limited');
    expect(await identity(sender(20))).toBeUndefined();
    expect(await messages()).toHaveLength(20);
    // A sender that already has a row uses none of the budget.
    expect((await deliver(payload({ from: sender(0) }))).errors).toBeUndefined();
    clock = new Date(clock.getTime() + 3_600_000);
    expect((await deliver(payload({ from: sender(20) }))).errors).toBeUndefined();
    expect(await identity(sender(20))).toMatchObject({ domain: PEER_DOMAIN, active: true });
  });

  it('strips control and format characters from subject and instance, and leaves the body as sent', async () => {
    const { deliver, messages } = await setup();
    const body = 'line one\nline\u0007 two\u202e';
    const { errors, result } = await deliver(
      payload({
        subject: 'line one\nline\u0007 two\u202e\r\nend',
        instance: 'session:\u200b1a2b',
        body
      })
    );
    expect(errors).toBeUndefined();
    const row = (await messages()).find((m) => m.id === result?.id);
    expect(row).toMatchObject({ subject: 'line one line two end', instance: 'session:1a2b', body });
  });

  it('applies the checks in order', async () => {
    const { deliver } = await setup();
    const steps: Array<[Record<string, unknown>, string, string]> = [
      [
        { v: 2, future: true, subject: 'x'.repeat(201), to: GONE, from: LOCAL },
        STRANGER,
        'unsupported_version'
      ],
      [{ subject: 'x'.repeat(201), to: GONE, from: LOCAL }, STRANGER, 'unknown_peer'],
      [{ subject: 'x'.repeat(201), to: GONE, from: LOCAL }, PEER, 'too_large'],
      [{ to: GONE, from: LOCAL }, PEER, 'unknown_recipient'],
      [{ from: LOCAL }, PEER, 'foreign_sender']
    ];
    for (const [extra, kid, code] of steps) {
      expect((await deliver(payload(extra), kid)).errors?.[0]?.code).toBe(code);
    }
    // A repeat answers before the recipient and sender checks.
    const sent = payload();
    expect((await deliver(sent)).errors).toBeUndefined();
    const again = await deliver({ ...sent, to: GONE, from: LOCAL });
    expect(again.result?.duplicate).toBe(true);
  });

  it('refuses a param it does not know and a malformed one', async () => {
    const { deliver, messages } = await setup();
    expect((await deliver(payload({ tags: ['priority:urgent'] }))).errors?.[0]?.code).toBe(
      'unknown_param'
    );
    expect((await deliver(payload({ body: 5 }))).errors?.[0]?.code).toBe('invalid_param');
    expect((await deliver(payload({ from: '' }))).errors?.[0]?.code).toBe('invalid_param');
    expect(await messages()).toHaveLength(0);
  });

  it('refuses the 61st delivery in a minute', async () => {
    let clock = new Date('2026-11-27T12:00:00.000Z');
    const { deliver, messages } = await setup({ now: () => clock });
    for (let i = 0; i < 60; i++) expect((await deliver(payload())).errors).toBeUndefined();
    expect((await deliver(payload())).errors?.[0]?.code).toBe('rate_limited');
    // After the size check, before the recipient check.
    expect((await deliver(payload({ body: 'x'.repeat(65_537) }))).errors?.[0]?.code).toBe(
      'too_large'
    );
    expect((await deliver(payload({ to: GONE }))).errors?.[0]?.code).toBe('rate_limited');
    expect(await messages()).toHaveLength(60);
    clock = new Date(clock.getTime() + 60_000);
    expect((await deliver(payload())).errors).toBeUndefined();
  });

  it('writes into the renamed coordinator namespace', async () => {
    const { deliver, messages, batches } = await setup({ namespace: 'codex' });
    const { errors, result } = await deliver(payload());
    expect(errors).toBeUndefined();
    expect((await messages()).map((m) => m.id)).toEqual([result?.id]);
    expect(batches.some((b) => b.namespace === 'codex' && b.type === 'AgentMessage')).toBe(true);
  });
});

describe('upsertRemoteIdentity without a scope', () => {
  const kid = 'agent-x@host-x.example';

  it('creates the identity in a transaction of its own and announces it', async () => {
    const { rt, batches } = await setup();
    const created = await upsertRemoteIdentity(rt, PEER_DOMAIN, { kid, project: 'proj' });
    expect(created).toMatchObject({
      kid,
      domain: PEER_DOMAIN,
      host: '',
      active: true,
      project: 'proj'
    });
    expect(batches).toContainEqual(
      expect.objectContaining({ type: 'AgentIdentity', operation: 'create', ids: [created.id] })
    );
  });

  it('returns the same row on a repeat and writes nothing', async () => {
    const { rt, batches } = await setup();
    const created = await upsertRemoteIdentity(rt, PEER_DOMAIN, { kid });
    const announced = batches.length;
    expect((await upsertRemoteIdentity(rt, PEER_DOMAIN, { kid })).id).toBe(created.id);
    expect(batches).toHaveLength(announced);
  });

  it('refuses a kid held by a local row or by another domain', async () => {
    const { rt, identities, batches } = await setup();
    const before = await identities();
    await expect(upsertRemoteIdentity(rt, PEER_DOMAIN, { kid: LOCAL })).rejects.toMatchObject({
      code: 'kid_collision'
    });
    await expect(
      upsertRemoteIdentity(rt, PEER_DOMAIN, { kid: OTHER_REMOTE })
    ).rejects.toMatchObject({ code: 'kid_collision' });
    expect(await identities()).toEqual(before);
    expect(batches).toEqual([]);
  });

  it('updates the fields given and announces the update', async () => {
    const { rt, batches } = await setup();
    await upsertRemoteIdentity(rt, PEER_DOMAIN, { kid, project: 'proj' });
    const updated = await upsertRemoteIdentity(rt, PEER_DOMAIN, { kid, description: 'does d' });
    expect(updated).toMatchObject({ project: 'proj', description: 'does d' });
    expect(batches).toContainEqual(
      expect.objectContaining({ type: 'AgentIdentity', operation: 'update', ids: [updated.id] })
    );
  });
});
