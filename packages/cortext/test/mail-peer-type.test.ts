// cortext/MailPeer: one row per peer server, operator-only because a row names a key path.

import type { PackEnvelope } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_MESSAGE_DELIVERY_VOCAB, CLAUDE_TYPE_NAMES } from '../src/index.js';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'cortext';
const AGENT = 'agent-a@host-a.example';
const OPERATOR = 'ops@host-a.example';
const PEER = {
  domain: 'peer.example.net',
  origin: 'https://peer.example.net:3100',
  inboundKid: 'relay-in@peer.example.net',
  outboundKid: 'relay-out@host-a.example',
  outboundKeyPath: '/etc/substrate/keys/relay.key'
};
let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

async function setup(): Promise<MemorySubstrateServer> {
  const server = new MemorySubstrateServer();
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: {
      [NS]: new MemoryDataset({ namespace: NS }),
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
  capabilities: string[]
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

const asOperator = (
  s: MemorySubstrateServer,
  path: '/substrate/v1/mutate' | '/substrate/v1/query',
  p: unknown
) => call(s, OPERATOR, path, p, ['read', 'mutate', 'admin']);
const asAgent = (
  s: MemorySubstrateServer,
  path: '/substrate/v1/mutate' | '/substrate/v1/query',
  p: unknown
) => call(s, AGENT, path, p, ['read', 'mutate']);
const code = (env: PackEnvelope): string | undefined =>
  (env.errors?.[0] as { code?: string } | undefined)?.code;

const create = (params: Record<string, unknown> = PEER) => ({
  [`${NS}/createMailPeer`]: { params, fields: { id: true } }
});

describe('cortext/MailPeer', () => {
  it('is registered, and the delivery vocabulary is fixed', () => {
    expect(CLAUDE_TYPE_NAMES).toContain('MailPeer');
    expect([...AGENT_MESSAGE_DELIVERY_VOCAB]).toEqual(['pending', 'delivered', 'failed']);
  });

  it('lets an operator create a MailPeer, with its defaults', async () => {
    const server = await setup();
    const env = await asOperator(server, '/substrate/v1/mutate', create());
    expect(env.errors).toBeUndefined();
    const read = await asOperator(server, '/substrate/v1/query', {
      [`${NS}/MailPeer`]: {
        params: {},
        fields: { domain: true, active: true, allowOpenReads: true }
      }
    });
    expect(read.data[`${NS}/MailPeer`]).toEqual([
      { domain: PEER.domain, active: true, allowOpenReads: false }
    ]);
  });

  it('refuses a non-operator create, update, delete and read', async () => {
    const server = await setup();
    const made = await asOperator(server, '/substrate/v1/mutate', create());
    const id = (made.data[`${NS}/createMailPeer`] as { id: string }).id;
    const attempts: Array<[string, PackEnvelope]> = [
      [
        'create',
        await asAgent(
          server,
          '/substrate/v1/mutate',
          create({ ...PEER, domain: 'other.example.net', inboundKid: 'x@other' })
        )
      ],
      [
        'update',
        await asAgent(server, '/substrate/v1/mutate', {
          [`${NS}/updateMailPeer`]: { params: { id, active: false }, fields: { id: true } }
        })
      ],
      [
        'delete',
        await asAgent(server, '/substrate/v1/mutate', {
          [`${NS}/deleteMailPeer`]: { params: { id }, fields: { id: true } }
        })
      ],
      [
        'list',
        await asAgent(server, '/substrate/v1/query', {
          [`${NS}/MailPeer`]: { params: {}, fields: { outboundKeyPath: true } }
        })
      ],
      [
        'get',
        await asAgent(server, '/substrate/v1/query', {
          [`${NS}/MailPeer`]: {
            params: { where: { id: { eq: id } } },
            fields: { outboundKeyPath: true }
          }
        })
      ]
    ];
    for (const [verb, env] of attempts) {
      expect(code(env), verb).toBe('operator_only');
      expect(JSON.stringify(env)).not.toContain(PEER.outboundKeyPath);
    }
  });
});
