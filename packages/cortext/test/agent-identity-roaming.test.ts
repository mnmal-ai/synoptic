// AgentIdentity.roaming: an identity that works whichever repo it is sent
// into on its own host. Pinned against a composed substrate, as the fleet audit
// reads it over the wire.

import type { PackEnvelope } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'cortext';
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
    auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' },
    streamTicketSecret: 'test-stream-ticket-secret'
  });
  await server.start();
  stop = () => composed.stop();
  return server;
}

async function call(
  server: MemorySubstrateServer,
  path: '/substrate/v1/mutate' | '/substrate/v1/query',
  payload: unknown
): Promise<PackEnvelope> {
  const token = signHs256(
    {
      sub: 'synoptic-claude@host-a',
      exp: Math.floor(Date.now() / 1000) + 3600,
      capabilities: ['read', 'mutate']
    },
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

describe('cortext/AgentIdentity.roaming', () => {
  it('defaults false, takes true, and filters', async () => {
    const server = await setup();
    const created = await call(server, '/substrate/v1/mutate', {
      [`${NS}/createAgentIdentity`]: [
        { params: { kid: 'p1-claude@a', project: 'p1', host: 'a' }, fields: { roaming: true } },
        {
          params: { kid: 'codex@a', project: null, host: 'a', roaming: true },
          fields: { roaming: true }
        }
      ]
    });
    expect(created.errors).toBeUndefined();
    expect(created.data[`${NS}/createAgentIdentity`]).toMatchObject([
      { roaming: false },
      { roaming: true }
    ]);
    const found = await call(server, '/substrate/v1/query', {
      [`${NS}/AgentIdentity`]: {
        params: { where: { roaming: { eq: true } } },
        fields: { kid: true }
      }
    });
    expect(found.errors).toBeUndefined();
    expect(found.data[`${NS}/AgentIdentity`]).toEqual([{ kid: 'codex@a' }]);
  });
});
