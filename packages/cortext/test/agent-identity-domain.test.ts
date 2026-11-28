// AgentIdentity.domain marks a directory row that stands for an agent on another server, and the
// AgentMessage delivery fields belong to the relay. Pinned against a composed substrate.

import type { PackEnvelope } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { isLocalIdentity } from '../src/participants.js';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'cortext';
const LOCAL_A = 'agent-a@host-a.example';
const LOCAL_B = 'agent-b@host-b.example';
const REMOTE = 'agent-c@peer.example.net';
const OPERATOR = 'ops@host-a.example';
let stop: (() => Promise<void>) | null = null;
/** The coordinator dataset of the last `setup`, for writing rows directly. */
let store: MemoryDataset;
afterEach(async () => {
  await stop?.();
  stop = null;
});

async function setup(): Promise<MemorySubstrateServer> {
  store = new MemoryDataset({ namespace: NS });
  const server = new MemorySubstrateServer();
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: {
      [NS]: store,
      architecture: new MemoryDataset({ namespace: 'architecture' })
    },
    coordinators: [buildClaudeForTest({ namespace: NS })],
    auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' }
  });
  await server.start();
  stop = () => composed.stop();
  return server;
}

async function call(
  server: MemorySubstrateServer,
  sub: string,
  path: '/substrate/v1/mutate' | '/substrate/v1/query',
  payload: unknown,
  capabilities: string[] = ['read', 'mutate']
): Promise<PackEnvelope> {
  const token = signHs256(
    { sub, exp: Math.floor(Date.now() / 1000) + 3600, capabilities },
    'test-secret',
    { kid: 'test' }
  );
  const res = await server.inject({
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: Buffer.from(JSON.stringify(payload))
  });
  return JSON.parse(Buffer.from(res.body as Uint8Array).toString('utf8')) as PackEnvelope;
}

const mutate = (server: MemorySubstrateServer, sub: string, payload: unknown) =>
  call(server, sub, '/substrate/v1/mutate', payload);
const asOperator = (server: MemorySubstrateServer, payload: unknown) =>
  call(server, OPERATOR, '/substrate/v1/mutate', payload, ['read', 'mutate', 'admin']);
const code = (env: PackEnvelope): string | undefined =>
  (env.errors?.[0] as { code?: string } | undefined)?.code;

const local = (kid: string) => ({ kid, host: kid.slice(kid.indexOf('@') + 1), project: null });
const remote = { kid: REMOTE, host: '', project: null, domain: 'peer.example.net' };

async function createIdentity(
  server: MemorySubstrateServer,
  params: Record<string, unknown>
): Promise<string> {
  const env = await asOperator(server, {
    [`${NS}/createAgentIdentity`]: { params, fields: { id: true } }
  });
  expect(env.errors).toBeUndefined();
  return (env.data[`${NS}/createAgentIdentity`] as { id: string }).id;
}

describe('AgentIdentity.domain', () => {
  it('lists a row by default', async () => {
    const server = await setup();
    const id = await createIdentity(server, local(LOCAL_A));
    const env = await call(server, OPERATOR, '/substrate/v1/query', {
      [`${NS}/AgentIdentity`]: {
        params: { where: { id: { eq: id } } },
        fields: { listed: true }
      }
    });
    expect(env.data[`${NS}/AgentIdentity`]).toEqual([{ listed: true }]);
  });

  it('tells local rows from remote ones', () => {
    expect(isLocalIdentity({ id: 'x', domain: null } as never)).toBe(true);
    expect(isLocalIdentity({ id: 'x' } as never)).toBe(true);
    expect(isLocalIdentity({ id: 'x', domain: 'peer.example.net' } as never)).toBe(false);
  });

  it('lets an operator create a remote row', async () => {
    const server = await setup();
    await createIdentity(server, remote);
  });

  it('refuses domain from a non-operator, on create and on update', async () => {
    const server = await setup();
    const created = await mutate(server, LOCAL_A, {
      [`${NS}/createAgentIdentity`]: {
        params: { ...local(LOCAL_A), domain: 'peer.example.net' },
        fields: { id: true }
      }
    });
    expect(code(created)).toBe('operator_only');

    const id = await createIdentity(server, local(LOCAL_A));
    const updated = await mutate(server, LOCAL_A, {
      [`${NS}/updateAgentIdentity`]: {
        params: { id, domain: 'peer.example.net' },
        fields: { id: true }
      }
    });
    expect(code(updated)).toBe('operator_only');
  });

  it('refuses roaming and a host on a row with a domain', async () => {
    const server = await setup();
    for (const extra of [{ roaming: true }, { host: 'host-c.example' }]) {
      const env = await asOperator(server, {
        [`${NS}/createAgentIdentity`]: {
          params: { ...remote, ...extra },
          fields: { id: true }
        }
      });
      expect(code(env)).toBe('invalid_remote_identity');
    }
    const id = await createIdentity(server, remote);
    const env = await asOperator(server, {
      [`${NS}/updateAgentIdentity`]: { params: { id, roaming: true }, fields: { id: true } }
    });
    expect(code(env)).toBe('invalid_remote_identity');
  });

  it("skips rows with a domain on to:'*'", async () => {
    const server = await setup();
    await createIdentity(server, local(LOCAL_A));
    const b = await createIdentity(server, local(LOCAL_B));
    await createIdentity(server, remote);
    const sent = await mutate(server, LOCAL_A, {
      [`${NS}/sendAgentMessage`]: {
        params: { to: ['*'], subject: 's', body: 'b' },
        fields: { id: true }
      }
    });
    expect(sent.errors).toBeUndefined();
    const env = await call(server, OPERATOR, '/substrate/v1/query', {
      [`${NS}/AgentMessage`]: { params: {}, fields: { recipient: true } }
    });
    expect(env.data[`${NS}/AgentMessage`]).toEqual([{ recipient: b }]);
  });

  it("reaches every local agent on to:'*' however many newer remote rows there are", async () => {
    const server = await setup();
    const locals = [LOCAL_A, LOCAL_B, 'agent-d@host-d.example'].map((kid, i) => ({
      id: `local-${i}`,
      ...local(kid),
      active: true
    }));
    await store.write('AgentIdentity', locals, { now: new Date('2026-11-01T00:00:00.000Z') });
    // More remote rows than one read takes, newer and with lower ids, so a read of every active
    // row would fill its limit with them whichever order the store returns.
    const remotes = Array.from({ length: 1000 }, (_, i) => ({
      id: `0${i}`,
      kid: `r${i}@host-r.example`,
      host: '',
      domain: 'peer.example.net',
      active: true
    }));
    await store.write('AgentIdentity', remotes, { now: new Date('2026-11-27T00:00:00.000Z') });
    const sent = await mutate(server, LOCAL_A, {
      [`${NS}/sendAgentMessage`]: {
        params: { to: ['*'], subject: 's', body: 'b' },
        fields: { id: true }
      }
    });
    expect(sent.errors).toBeUndefined();
    const env = await call(server, OPERATOR, '/substrate/v1/query', {
      [`${NS}/AgentMessage`]: { params: {}, fields: { recipient: true } }
    });
    const recipients = (env.data[`${NS}/AgentMessage`] as Array<{ recipient: string }>)
      .map((m) => m.recipient)
      .sort();
    expect(recipients).toEqual(['local-1', 'local-2']);
  });

  it('refuses a remote row as Todo owner', async () => {
    const server = await setup();
    const owner = await createIdentity(server, remote);
    const todo = { title: 't', area: 'a', status: 'open', priority: 'low' };
    const created = await mutate(server, LOCAL_A, {
      [`${NS}/createTodo`]: { params: { ...todo, owner }, fields: { id: true } }
    });
    expect(code(created)).toBe('remote_owner');

    const ok = await mutate(server, LOCAL_A, {
      [`${NS}/createTodo`]: { params: todo, fields: { id: true } }
    });
    const id = (ok.data[`${NS}/createTodo`] as { id: string }).id;
    const updated = await mutate(server, LOCAL_A, {
      [`${NS}/updateTodo`]: { params: { id, owner }, fields: { id: true } }
    });
    expect(code(updated)).toBe('remote_owner');
  });
});

describe('AgentMessage delivery fields', () => {
  it('defaults delivery attempts to 0 and leaves delivery unset', async () => {
    const server = await setup();
    await createIdentity(server, local(LOCAL_A));
    await createIdentity(server, local(LOCAL_B));
    await mutate(server, LOCAL_A, {
      [`${NS}/sendAgentMessage`]: {
        params: { to: [LOCAL_B], subject: 's', body: 'b' },
        fields: { id: true }
      }
    });
    const env = await call(server, OPERATOR, '/substrate/v1/query', {
      [`${NS}/AgentMessage`]: {
        params: {},
        fields: { deliveryAttempts: true }
      }
    });
    expect(env.data[`${NS}/AgentMessage`]).toEqual([{ deliveryAttempts: 0 }]);
  });

  it.each([
    ['delivery', 'delivered'],
    ['deliveryAttempts', 1],
    ['deliveryNextAt', '2026-11-27T10:00:00.000Z'],
    ['deliveryError', 'x'],
    ['remoteFrom', REMOTE],
    ['viaDomain', 'peer.example.net'],
    ['remoteId', 'r1']
  ])('refuses %s through updateAgentMessage', async (key, value) => {
    const server = await setup();
    await createIdentity(server, local(LOCAL_A));
    await createIdentity(server, local(LOCAL_B));
    await mutate(server, LOCAL_A, {
      [`${NS}/sendAgentMessage`]: {
        params: { to: [LOCAL_B], subject: 's', body: 'b' },
        fields: { id: true }
      }
    });
    const list = await call(server, OPERATOR, '/substrate/v1/query', {
      [`${NS}/AgentMessage`]: { params: {}, fields: { id: true } }
    });
    const id = (list.data[`${NS}/AgentMessage`] as Array<{ id: string }>)[0]?.id;
    const env = await mutate(server, LOCAL_B, {
      [`${NS}/updateAgentMessage`]: { params: { id, [key]: value }, fields: { id: true } }
    });
    expect(env.errors?.length).toBeGreaterThan(0);
  });
});
