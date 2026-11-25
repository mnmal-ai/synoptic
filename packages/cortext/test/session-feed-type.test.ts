// cortext/SessionFeed + cortext/SessionFeedEvent: a session shared read-only
// and its steps. Pins the schema, the per-feed step guard and the viewer's read.

import type { PackEnvelope } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClaudeNamespace,
  CLAUDE_TYPE_NAMES,
  SESSION_FEED_EVENT_KINDS
} from '../src/index.js';
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
    auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' }
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
      sub: 'synoptic-opencode@host-a',
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

async function createFeed(server: MemorySubstrateServer, instance: string): Promise<string> {
  const env = await call(server, '/substrate/v1/mutate', {
    [`${NS}/createSessionFeed`]: {
      params: {
        instance,
        host: 'host-a',
        title: 'wire the relay',
        lastEventAt: '2026-11-25T18:00:00.000Z',
        project: 'example'
      },
      fields: { id: true }
    }
  });
  expect(env.errors).toBeUndefined();
  return (env.data[`${NS}/createSessionFeed`] as { id: string }).id;
}

describe('cortext/SessionFeed', () => {
  it('is registered beside its events', () => {
    expect(CLAUDE_TYPE_NAMES).toContain('SessionFeed');
    expect(CLAUDE_TYPE_NAMES).toContain('SessionFeedEvent');
    expect([...SESSION_FEED_EVENT_KINDS]).toEqual(['prompt', 'reply', 'tool']);
  });

  it('declares instance unique among live rows', () => {
    const def = buildClaudeNamespace(NS).types?.SessionFeed as unknown as { indexes?: unknown[] };
    expect(def.indexes).toEqual([
      {
        fields: ['instance'],
        unique: true,
        where: 'live',
        name: 'rows_session_feed_instance_unique'
      }
    ]);
  });

  it('defaults sharing to true', async () => {
    const server = await setup();
    await createFeed(server, 'session:1a2b3c4d');
    const env = await call(server, '/substrate/v1/query', {
      [`${NS}/SessionFeed`]: {
        params: { where: { instance: { eq: 'session:1a2b3c4d' } } },
        fields: { sharing: true, archived: true }
      }
    });
    expect(env.errors).toBeUndefined();
    expect(env.data[`${NS}/SessionFeed`]).toEqual([{ sharing: true, archived: false }]);
  });
});

describe('cortext/SessionFeedEvent', () => {
  it('declares feed + step unique among live rows', () => {
    const def = buildClaudeNamespace(NS).types?.SessionFeedEvent as unknown as {
      indexes?: unknown[];
    };
    expect(def.indexes).toEqual([
      {
        fields: ['feed', { field: 'step', dir: 'desc' }],
        unique: true,
        where: 'live',
        name: 'rows_session_feed_event_feed_step_unique'
      }
    ]);
  });

  it('refuses a kind outside the vocabulary', async () => {
    const server = await setup();
    const feed = await createFeed(server, 'session:1a2b3c4d');
    const env = await call(server, '/substrate/v1/mutate', {
      [`${NS}/createSessionFeedEvent`]: {
        params: { feed, step: 1, kind: 'output', text: 'x' },
        fields: { id: true }
      }
    });
    expect(env.errors?.[0]?.message ?? '').toMatch(/kind/);
  });

  it('reads a feed in step order after a given step', async () => {
    const server = await setup();
    const feed = await createFeed(server, 'session:1a2b3c4d');
    const steps = [
      { step: 1, kind: 'prompt', text: 'wire the relay' },
      { step: 2, kind: 'tool', tool: 'Bash', text: 'Run the relay tests' },
      { step: 3, kind: 'reply', text: 'The relay tests pass.' }
    ];
    const written = await call(server, '/substrate/v1/mutate', {
      [`${NS}/createSessionFeedEvent`]: steps.map((s) => ({
        params: { ...s, feed, project: 'example' },
        fields: { id: true }
      }))
    });
    expect(written.errors).toBeUndefined();

    const after = await call(server, '/substrate/v1/query', {
      [`${NS}/SessionFeedEvent`]: {
        params: {
          where: { feed: { eq: feed }, step: { gt: 1 } },
          orderBy: [{ step: 'asc' }]
        },
        fields: { step: true, kind: true, tool: true, text: true }
      }
    });
    expect(after.errors).toBeUndefined();
    expect(after.data[`${NS}/SessionFeedEvent`]).toEqual([
      { step: 2, kind: 'tool', tool: 'Bash', text: 'Run the relay tests' },
      { step: 3, kind: 'reply', text: 'The relay tests pass.' }
    ]);
  });
});
