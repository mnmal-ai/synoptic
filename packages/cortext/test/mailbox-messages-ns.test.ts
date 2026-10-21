// The mailbox's refusal messages name mutations a caller should use instead,
// so they must name them in the namespace the caller is actually in. Run here
// under `cortext`, not the test default `claude`, so a hard-coded prefix
// cannot pass.

import type { PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'cortext';
const SENDER = 'sender-claude@test';
const PEER = 'peer-claude@test';

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

function bearer(sub: string): string {
  return `Bearer ${signHs256(
    { sub, exp: Math.floor(Date.now() / 1000) + 3600, capabilities: ['read', 'mutate'] },
    'test-secret',
    { kid: 'test' }
  )}`;
}

async function mutate(
  server: MemorySubstrateServer,
  payload: unknown,
  sub: string | null = SENDER
): Promise<PackEnvelope> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sub !== null) headers.authorization = bearer(sub);
  const res: SubstrateResponse = await server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers,
    body: Buffer.from(JSON.stringify(payload))
  });
  return JSON.parse(Buffer.from(res.body as Uint8Array).toString('utf8')) as PackEnvelope;
}

async function sendOne(server: MemorySubstrateServer): Promise<string> {
  await mutate(server, {
    [`${NS}/createAgentIdentity`]: {
      params: { kid: PEER, host: 'test', active: true },
      fields: { id: true }
    }
  });
  const env = await mutate(server, {
    [`${NS}/sendAgentMessage`]: {
      params: { to: PEER, subject: 's', body: 'b' },
      fields: { id: true }
    }
  });
  return (env.data[`${NS}/sendAgentMessage`] as Array<{ id: string }>)[0]?.id as string;
}

const messageOf = (env: PackEnvelope): string => env.errors?.[0]?.message ?? '';

describe('mailbox refusals name the namespace they run in', () => {
  it('an unknown kid names cortext/AgentIdentity', async () => {
    const server = await setup();
    const env = await mutate(server, {
      [`${NS}/sendAgentMessage`]: {
        params: { to: 'nobody@test', subject: 's', body: 'b' },
        fields: { id: true }
      }
    });
    expect(messageOf(env)).toContain('cortext/AgentIdentity');
    expect(messageOf(env)).not.toContain('claude/');
  });

  it('a transition-field update names the cortext transition mutations', async () => {
    const server = await setup();
    const id = await sendOne(server);
    const env = await mutate(
      server,
      { [`${NS}/updateAgentMessage`]: { params: { id, status: 'read' }, fields: { id: true } } },
      PEER
    );
    expect(messageOf(env)).toContain('cortext/markAgentMessageRead');
    expect(messageOf(env)).not.toContain('claude/');
  });

  it('an instance update names cortext/sendAgentMessage', async () => {
    const server = await setup();
    const id = await sendOne(server);
    const env = await mutate(
      server,
      { [`${NS}/updateAgentMessage`]: { params: { id, instance: 'x' }, fields: { id: true } } },
      PEER
    );
    expect(messageOf(env)).toContain('cortext/sendAgentMessage');
    expect(messageOf(env)).not.toContain('claude/');
  });
});
