/**
 * Two composed servers on Postgres, each in a schema of its own and each the other's MailPeer. A
 * server's `fetchImpl` hands its calls to the other server's `inject`, so a send, a directory
 * sync and a reply cross the same routes, keys and grants they would over a network. The cases run
 * in order and share the two servers; time comes from one injected clock.
 */

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Row } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  PgDataset,
  PgEdgesStore,
  pgTestSchemaName,
  pgTestSchemaUrl,
  recreatePgTestSchema,
  runMigrations,
  signHs256
} from '@mnmal-ai/substrate/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORTEXT_NAMESPACE as NS } from '../src/kernel/cortext-namespace.js';
import { drainOutbox, peerAuthorization } from '../src/relay/outbox.js';
import { createRelayRuntime, type RelayRuntime } from '../src/relay/runtime.js';
import { syncPeer } from '../src/relay/sync.js';
import { buildClaudeForTest } from './_helpers.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const GATED = { reads: 'identity', writes: 'identity', deletes: 'identity' } as const;
const MINUTE = 60_000;

const AGENT_A = 'agent-a@host-a.example';
const HIDDEN_A = 'agent-c@host-a.example';
const AGENT_B = 'agent-b@host-b.example';
const OPERATOR = 'ops@host-a.example';

interface Side {
  name: 'a' | 'b';
  domain: string;
  origin: string;
  relayKid: string;
  keyPath: string;
  publicKey: KeyObject;
}
const SIDE_A: Omit<Side, 'keyPath' | 'publicKey'> = {
  name: 'a',
  domain: 'substrate.example.org',
  origin: 'https://substrate.example.org',
  relayKid: 'relay@substrate.example.org'
};
const SIDE_B: Omit<Side, 'keyPath' | 'publicKey'> = {
  name: 'b',
  domain: 'peer.example.net',
  origin: 'https://peer.example.net',
  relayKid: 'relay@peer.example.net'
};

interface Envelope {
  data?: Record<string, unknown>;
  errors?: Array<{ code: string; message: string }>;
}

const text = (body: unknown): string =>
  typeof body === 'string' ? body : Buffer.from(body as Uint8Array).toString('utf8');

async function openStore(url: string, name: string): Promise<ReturnType<typeof postgres>> {
  const pkg = `cortext-two-servers-${name}`;
  await recreatePgTestSchema(url, pgTestSchemaName(pkg));
  const sql = postgres(pgTestSchemaUrl(url, pkg), { onnotice: () => {} });
  await runMigrations(sql);
  return sql;
}

const stores = POSTGRES_URL
  ? { a: await openStore(POSTGRES_URL, 'a'), b: await openStore(POSTGRES_URL, 'b') }
  : undefined;

describe.skipIf(stores === undefined)('two servers exchanging agent mail on Postgres', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cortext-two-servers-'));
  const clock = { skew: 0 };
  const now = () => new Date(Date.now() + clock.skew);
  // Whether a server answers calls from the other one.
  const down = { a: false, b: false };
  const servers = new Map<string, { server: MemorySubstrateServer; down: () => boolean }>();
  const metrics: Array<{ name: string; payload: unknown }> = [];

  const routed = (
    () =>
    async (url: string, init: RequestInit): Promise<Response> => {
      const target = servers.get(new URL(url).origin);
      if (target === undefined || target.down()) throw new TypeError('fetch failed');
      const res = await target.server.inject({
        method: 'POST',
        path: new URL(url).pathname,
        headers: init.headers as Record<string, string>,
        body: Buffer.from(String(init.body))
      });
      return new Response(text(res.body), { status: res.status });
    }
  )() as unknown as typeof fetch;

  async function start(side: Omit<Side, 'keyPath' | 'publicKey'>, other: Side) {
    const sql = (stores as NonNullable<typeof stores>)[side.name];
    const cfg = { namespace: NS, mailDomain: side.domain, auth: GATED };
    // Without the post-commit send and the schedules, so each case drains and syncs when it chooses.
    const {
      onCommittedWrites: _hook,
      schedule: _schedule,
      ...coordinator
    } = buildClaudeForTest(cfg, { relay: { fetchImpl: routed, now } });
    const types = coordinator.namespaces?.[0]?.types ?? {};
    const edgesStore = new PgEdgesStore({ sql });
    // The other server's relay key, granted the relay namespace alone.
    const system = new MemoryDataset({ namespace: '_system' });
    await system.write('Key', [
      {
        id: 'k-relay',
        kid: other.relayKid,
        algorithm: 'EdDSA',
        publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        namespaces: 'cortext-relay',
        capabilities: 'read,mutate',
        revokedAt: null
      }
    ]);
    const server = new MemorySubstrateServer();
    const composed = await compose({
      server,
      dataset: new PgDataset({
        namespace: 'default',
        sql,
        edgesStore,
        typeDefLookup: (type, namespace) => (namespace === NS ? types[type] : undefined)
      }),
      datasets: { _system: system },
      edges: edgesStore,
      coordinators: [coordinator],
      auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' }
    });
    await server.start();
    const ds = composed.engine.datasetFor(NS);
    if (ds === undefined) throw new Error('no cortext dataset');
    const storage = { indexes: 'unique', newFields: 'column' } as const;
    for (const type of Object.keys(types)) await ds.ensureTypeStorage?.(type, storage);
    const rt = createRelayRuntime(cfg, {
      engine: composed.engine,
      edges: edgesStore,
      fetchImpl: routed,
      now,
      metric: (name, payload) => metrics.push({ name, payload })
    });
    return { composed, server, ds, rt, sql, side };
  }

  type Running = Awaited<ReturnType<typeof start>>;
  let a: Running;
  let b: Running;

  beforeAll(async () => {
    const keys = [SIDE_A, SIDE_B].map((s) => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const keyPath = join(dir, `${s.name}.key`);
      writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      return { ...s, keyPath, publicKey } as Side;
    });
    const [sideA, sideB] = keys as [Side, Side];
    a = await start(SIDE_A, sideB);
    b = await start(SIDE_B, sideA);
    servers.set(SIDE_A.origin, { server: a.server, down: () => down.a });
    servers.set(SIDE_B.origin, { server: b.server, down: () => down.b });
    const peerRow = (self: Side, other: Side) => ({
      domain: other.domain,
      origin: other.origin,
      inboundKid: other.relayKid,
      outboundKid: self.relayKid,
      outboundKeyPath: self.keyPath,
      active: true
    });
    await a.ds.write('MailPeer', [peerRow(sideA, sideB)]);
    await b.ds.write('MailPeer', [peerRow(sideB, sideA)]);
    await a.ds.write('AgentIdentity', [
      { kid: AGENT_A, host: 'host-a.example', active: true, project: 'alpha' },
      { kid: HIDDEN_A, host: 'host-a.example', active: true, listed: false }
    ]);
    await b.ds.write('AgentIdentity', [
      { kid: AGENT_B, host: 'host-b.example', active: true, project: 'beta' }
    ]);
  }, 180_000);

  afterAll(async () => {
    await a?.composed.stop();
    await b?.composed.stop();
    for (const name of ['a', 'b'] as const) {
      const sql = stores?.[name];
      await sql?.unsafe(
        `DROP SCHEMA IF EXISTS "${pgTestSchemaName(`cortext-two-servers-${name}`)}" CASCADE`
      );
      await sql?.end({ timeout: 5 });
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const agentToken = (sub: string, capabilities = ['read', 'mutate']): string =>
    `Bearer ${signHs256({ sub, exp: Math.floor(Date.now() / 1000) + 3600, capabilities }, 'test-secret', { kid: 'test' })}`;
  async function call(
    on: Running,
    route: 'query' | 'mutate',
    frame: unknown,
    authorization?: string
  ): Promise<Envelope> {
    const res = await on.server.inject({
      method: 'POST',
      path: `/substrate/v1/${route}`,
      headers: {
        'content-type': 'application/json',
        ...(authorization !== undefined ? { authorization } : {})
      },
      body: Buffer.from(JSON.stringify(frame))
    });
    return JSON.parse(text(res.body)) as Envelope;
  }
  const send = (on: Running, from: string, params: Record<string, unknown>) =>
    call(
      on,
      'mutate',
      { [`${NS}/sendAgentMessage`]: { params, fields: { id: true } } },
      agentToken(from)
    );
  const sentId = (env: Envelope): string =>
    String((env.data?.[`${NS}/sendAgentMessage`] as Array<{ id: string }> | undefined)?.[0]?.id);
  const identity = async (on: Running, kid: string): Promise<Row | undefined> =>
    (await on.ds.read('AgentIdentity', { where: { kid: { eq: kid } }, limit: 1 })).rows[0];
  const messages = async (on: Running, where: Record<string, unknown> = {}): Promise<Row[]> =>
    (await on.ds.read('AgentMessage', { where, limit: 1000 })).rows;
  const peerOf = async (on: Running, domain: string): Promise<Row> => {
    const row = (await on.ds.read('MailPeer', { where: { domain: { eq: domain } } })).rows[0];
    if (row === undefined) throw new Error(`no peer ${domain}`);
    return { ...row };
  };
  const sync = async (on: Running, other: Omit<Side, 'keyPath' | 'publicKey'>) =>
    syncPeer(on.rt, await peerOf(on, other.domain));
  const drain = (on: Running) => drainOutbox(on.rt as RelayRuntime);
  const inbox = async (on: Running, kid: string): Promise<Array<Record<string, unknown>>> => {
    const me = await identity(on, kid);
    const env = await call(
      on,
      'query',
      {
        [`${NS}/AgentMessage`]: {
          params: { where: { recipient: { eq: me?.id }, archived: { eq: false } } },
          fields: { id: true, subject: true, remoteFrom: true, viaDomain: true, inReplyTo: true }
        }
      },
      agentToken(kid)
    );
    expect(env.errors).toBeUndefined();
    return env.data?.[`${NS}/AgentMessage`] as Array<Record<string, unknown>>;
  };

  it('refuses a send to an agent of a peer that has not been synced', async () => {
    const env = await send(a, AGENT_A, { to: AGENT_B, subject: 'too early', body: 'b' });
    expect(env.errors).toBeDefined();
    expect(await messages(a)).toHaveLength(0);
  });

  it('makes each side addressable on the other after one sync', async () => {
    expect(await sync(a, SIDE_B)).toMatchObject({ upserted: 1, blocked: null, changed: false });
    expect(await sync(b, SIDE_A)).toMatchObject({ upserted: 1, blocked: null, changed: false });
    expect(await identity(a, AGENT_B)).toMatchObject({
      domain: SIDE_B.domain,
      active: true,
      listed: true,
      project: 'beta'
    });
    expect(await identity(b, AGENT_A)).toMatchObject({ domain: SIDE_A.domain, project: 'alpha' });
    // An agent its operator hides is not in the other side's book.
    expect(await identity(b, HIDDEN_A)).toBeUndefined();
    expect((await peerOf(a, SIDE_B.domain)).lastSyncAt).toBeTruthy();
    expect((await peerOf(a, SIDE_B.domain)).blockedReason ?? null).toBeNull();
  });

  let first = '';
  it('delivers mail to the other server, naming the sender and the peer', async () => {
    const env = await send(a, AGENT_A, { to: AGENT_B, subject: 'hello', body: 'over there' });
    expect(env.errors).toBeUndefined();
    first = sentId(env);
    expect(await drain(a)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect((await messages(a, { id: { eq: first } }))[0]).toMatchObject({ delivery: 'delivered' });

    const [mail] = await inbox(b, AGENT_B);
    expect(mail).toMatchObject({
      subject: 'hello',
      remoteFrom: AGENT_A,
      viaDomain: SIDE_A.domain
    });
    // Signed by the peer's relay key; the sender is only what that server named.
    const [row] = await messages(b, { remoteId: { eq: first } });
    expect(row?._metadata?.createdBy).toMatchObject({ id: SIDE_A.relayKid });
    expect(row).toMatchObject({ body: 'over there', status: 'unread' });
  });

  it('threads a reply on the sending server', async () => {
    const [received] = await inbox(b, AGENT_B);
    const env = await send(b, AGENT_B, {
      to: AGENT_A,
      subject: 'Re: hello',
      body: 'back again',
      inReplyTo: received?.id
    });
    expect(env.errors).toBeUndefined();
    expect(await drain(b)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    const [reply] = await inbox(a, AGENT_A);
    expect(reply).toMatchObject({
      subject: 'Re: hello',
      remoteFrom: AGENT_B,
      viaDomain: SIDE_B.domain,
      inReplyTo: first
    });
  });

  it('stores a repeated delivery once', async () => {
    const peerA = await peerOf(a, SIDE_B.domain);
    const params = {
      v: 1,
      messageId: first,
      from: AGENT_A,
      to: AGENT_B,
      subject: 'hello',
      body: 'x'
    };
    const env = await call(
      b,
      'mutate',
      {
        'cortext-relay/deliver': { params, fields: { id: true, duplicate: true } }
      },
      peerAuthorization(peerA)
    );
    expect(env.errors).toBeUndefined();
    expect(env.data?.['cortext-relay/deliver']).toMatchObject({ duplicate: true });
    expect(await messages(b, { remoteId: { eq: first } })).toHaveLength(1);
  });

  it("keeps the other server's relay key out of everything but the relay namespace", async () => {
    const token = peerAuthorization(await peerOf(b, SIDE_A.domain));
    const read = await call(
      a,
      'query',
      { [`${NS}/AgentMessage`]: { params: {}, fields: { id: true } } },
      token
    );
    expect(read.data?.[`${NS}/AgentMessage`]).toBeUndefined();
    expect(read.errors?.[0]?.code).toBe('unauthorized_namespace');
    const write = await call(
      a,
      'mutate',
      {
        [`${NS}/sendAgentMessage`]: {
          params: { to: AGENT_A, subject: 'forged', body: 'b' },
          fields: { id: true }
        }
      },
      token
    );
    expect(write.data?.[`${NS}/sendAgentMessage`]).toBeUndefined();
    expect(write.errors?.[0]?.code).toBe('unauthorized_namespace');
    // Nor does an unsigned caller read mail, which is what the open-reads check relies on.
    const anon = await call(a, 'query', {
      [`${NS}/AgentMessage`]: { params: { limit: 1 }, fields: { id: true } }
    });
    expect(anon.data?.[`${NS}/AgentMessage`]).toBeUndefined();
    expect(anon.errors).toBeDefined();
  });

  it('refuses a non-operator any read of MailPeer, a count included', async () => {
    const countFrame = {
      [`${NS}/MailPeer`]: { params: { count: true }, fields: { id: true } }
    };
    const refused = await call(a, 'query', countFrame, agentToken(AGENT_A));
    expect(refused.data?.[`${NS}/MailPeer`]).toBeUndefined();
    expect(refused.errors?.[0]?.code).toBe('operator_only');
    // The same frame answers an operator, so the refusal is the gate and not the frame's shape.
    const allowed = await call(a, 'query', countFrame, agentToken(OPERATOR, ['read', 'admin']));
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data?.[`${NS}/MailPeer`]).toBeDefined();
  });

  it('keeps a broadcast on the sending server', async () => {
    const before = (await messages(a)).length;
    const env = await send(a, AGENT_A, { to: '*', subject: 'all hands', body: 'b' });
    expect(env.errors).toBeUndefined();
    const sent = env.data?.[`${NS}/sendAgentMessage`] as Array<{ id: string }>;
    // The one other local agent; the remote row gets none.
    expect(sent).toHaveLength(1);
    expect((await messages(a)).length).toBe(before + 1);
    expect(await messages(a, { delivery: { eq: 'pending' } })).toHaveLength(0);
    expect(await drain(a)).toEqual({ delivered: 0, retried: 0, failed: 0 });
  });

  it('delivers after the clock advances once a peer that was down answers again', async () => {
    down.b = true;
    const env = await send(a, AGENT_A, { to: AGENT_B, subject: 'later', body: 'b' });
    const id = sentId(env);
    expect(await drain(a)).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect((await messages(a, { id: { eq: id } }))[0]).toMatchObject({
      delivery: 'pending',
      deliveryError: 'network'
    });
    down.b = false;
    // Not due yet.
    expect(await drain(a)).toEqual({ delivered: 0, retried: 0, failed: 0 });
    clock.skew += 2 * MINUTE;
    expect(await drain(a)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect((await messages(a, { id: { eq: id } }))[0]).toMatchObject({ delivery: 'delivered' });
    expect(await messages(b, { remoteId: { eq: id } })).toHaveLength(1);
  });

  it('bounces mail the other server refuses for good', async () => {
    const mine = await identity(b, AGENT_B);
    await b.ds.write('AgentIdentity', [{ id: String(mine?.id), active: false }]);
    const env = await send(a, AGENT_A, { to: AGENT_B, subject: 'gone', body: 'b' });
    const id = sentId(env);
    expect(await drain(a)).toEqual({ delivered: 0, retried: 0, failed: 1 });
    expect((await messages(a, { id: { eq: id } }))[0]).toMatchObject({
      delivery: 'failed',
      deliveryError: 'unknown_recipient'
    });
    const [bounce] = await messages(a, { inReplyTo: { eq: id } });
    expect(bounce).toMatchObject({
      subject: 'Undelivered: gone',
      body: `Your message to ${AGENT_B} on ${SIDE_B.domain} was not delivered: that server has no active agent of that name.`
    });
    expect(bounce?.tags).toContain('system:bounce');
    await b.ds.write('AgentIdentity', [{ id: String(mine?.id), active: true }]);
  });

  it('still delivers by kid to an agent the other server has hidden', async () => {
    const mine = await identity(b, AGENT_B);
    await b.ds.write('AgentIdentity', [{ id: String(mine?.id), listed: false }]);
    expect(await sync(a, SIDE_B)).toMatchObject({ upserted: 0, unlisted: 1 });
    expect(await identity(a, AGENT_B)).toMatchObject({ active: true, listed: false });
    const env = await send(a, AGENT_A, { to: AGENT_B, subject: 'still there', body: 'b' });
    expect(env.errors).toBeUndefined();
    expect(await drain(a)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect((await inbox(b, AGENT_B)).map((m) => m.subject)).toContain('still there');
  });
});
