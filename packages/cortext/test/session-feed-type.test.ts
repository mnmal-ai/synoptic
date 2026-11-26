// cortext/SessionFeed + cortext/SessionFeedEvent: a session shared read-only and
// its steps. Pins the schema and the owner-only guards, including the array and
// by-filter paths that would otherwise reach autoCRUD around them.

import type { PackEnvelope } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_TYPE_NAMES, SESSION_FEED_EVENT_KINDS } from '../src/index.js';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'cortext';
const OWNER = 'synoptic-claude@host-a';
const STRANGER = 'peer-claude@host-b';
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
  call(server, 'ops@host-a', '/substrate/v1/mutate', payload, ['read', 'mutate', 'admin']);
const code = (env: PackEnvelope): string | undefined =>
  (env.errors?.[0] as { code?: string } | undefined)?.code;

async function createFeed(
  server: MemorySubstrateServer,
  sub = OWNER,
  instance = 'session:1a2b3c4d'
): Promise<string> {
  const env = await mutate(server, sub, {
    [`${NS}/createSessionFeed`]: {
      params: { instance, title: 'wire the relay', lastEventAt: '2026-11-25T18:00:00.000Z' },
      fields: { id: true }
    }
  });
  expect(env.errors).toBeUndefined();
  return (env.data[`${NS}/createSessionFeed`] as { id: string }).id;
}

async function addEvent(
  server: MemorySubstrateServer,
  sub: string,
  feed: string,
  step: number
): Promise<PackEnvelope> {
  return mutate(server, sub, {
    [`${NS}/createSessionFeedEvent`]: {
      params: { feed, step, kind: 'prompt', text: `step ${step}` },
      fields: { id: true }
    }
  });
}

describe('cortext/SessionFeed schema', () => {
  it('registers both types and the event kinds', () => {
    expect(CLAUDE_TYPE_NAMES).toContain('SessionFeed');
    expect(CLAUDE_TYPE_NAMES).toContain('SessionFeedEvent');
    expect(CLAUDE_TYPE_NAMES).not.toContain('SessionTurn');
    expect([...SESSION_FEED_EVENT_KINDS]).toEqual([
      'prompt',
      'reply',
      'tool',
      'mail-in',
      'mail-out'
    ]);
  });

  it('lets two keys hold the same instance, so nobody can claim a tag first', async () => {
    const server = await setup();
    await createFeed(server, STRANGER);
    await createFeed(server, OWNER);
    const env = await call(server, OWNER, '/substrate/v1/query', {
      [`${NS}/SessionFeed`]: {
        params: { where: { instance: { eq: 'session:1a2b3c4d' }, createdBy: { eq: OWNER } } },
        fields: { sharing: true, archived: true }
      }
    });
    expect(env.errors).toBeUndefined();
    expect(env.data[`${NS}/SessionFeed`]).toEqual([{ sharing: true, archived: false }]);
  });

  it('refuses an event kind outside the vocabulary', async () => {
    const server = await setup();
    const feed = await createFeed(server);
    const env = await mutate(server, OWNER, {
      [`${NS}/createSessionFeedEvent`]: {
        params: { feed, step: 1, kind: 'output', text: 'x' },
        fields: { id: true }
      }
    });
    expect(env.errors?.[0]?.message ?? '').toMatch(/kind/);
  });

  it('reads a feed in step order after a given step', async () => {
    const server = await setup();
    const feed = await createFeed(server);
    for (const step of [1, 2, 3])
      expect((await addEvent(server, OWNER, feed, step)).errors).toBeUndefined();
    const env = await call(server, STRANGER, '/substrate/v1/query', {
      [`${NS}/SessionFeedEvent`]: {
        params: { where: { feed: { eq: feed }, step: { gt: 1 } }, orderBy: [{ step: 'asc' }] },
        fields: { step: true, text: true }
      }
    });
    expect(env.errors).toBeUndefined();
    expect(env.data[`${NS}/SessionFeedEvent`]).toEqual([
      { step: 2, text: 'step 2' },
      { step: 3, text: 'step 3' }
    ]);
  });
});

describe('cortext/SessionFeed guards', () => {
  it('only the owner adds events; an operator cannot put words in its mouth', async () => {
    const server = await setup();
    const feed = await createFeed(server);
    expect((await addEvent(server, OWNER, feed, 1)).errors).toBeUndefined();
    expect(code(await addEvent(server, STRANGER, feed, 2))).toBe('not_owner');
    expect(
      code(
        await asOperator(server, {
          [`${NS}/createSessionFeedEvent`]: {
            params: { feed, step: 2, kind: 'reply', text: 'forged' },
            fields: { id: true }
          }
        })
      )
    ).toBe('not_owner');
  });

  it('refuses events once sharing is off', async () => {
    const server = await setup();
    const feed = await createFeed(server);
    const off = await mutate(server, OWNER, {
      [`${NS}/updateSessionFeed`]: { params: { id: feed, sharing: false }, fields: { id: true } }
    });
    expect(off.errors).toBeUndefined();
    expect(code(await addEvent(server, OWNER, feed, 1))).toBe('feed_not_sharing');
  });

  it('never lets an event change, even for its owner', async () => {
    const server = await setup();
    const feed = await createFeed(server);
    const made = await addEvent(server, OWNER, feed, 1);
    const id = (made.data[`${NS}/createSessionFeedEvent`] as { id: string }).id;
    const env = await mutate(server, OWNER, {
      [`${NS}/updateSessionFeedEvent`]: { params: { id, text: 'rewritten' }, fields: { id: true } }
    });
    expect(code(env)).toBe('immutable');
  });

  it('lets only the owner or an operator change or delete a feed and its events', async () => {
    const server = await setup();
    const feed = await createFeed(server);
    const made = await addEvent(server, OWNER, feed, 1);
    const event = (made.data[`${NS}/createSessionFeedEvent`] as { id: string }).id;
    const update = {
      [`${NS}/updateSessionFeed`]: { params: { id: feed, title: 'x' }, fields: { id: true } }
    };
    expect(code(await mutate(server, STRANGER, update))).toBe('not_owner');
    expect((await mutate(server, OWNER, update)).errors).toBeUndefined();
    expect((await asOperator(server, update)).errors).toBeUndefined();
    const delEvent = {
      [`${NS}/deleteSessionFeedEvent`]: { params: { id: event }, fields: { id: true } }
    };
    expect(code(await mutate(server, STRANGER, delEvent))).toBe('not_owner');
    const delFeed = { [`${NS}/deleteSessionFeed`]: { params: { id: feed }, fields: { id: true } } };
    expect(code(await mutate(server, STRANGER, delFeed))).toBe('not_owner');
    expect((await mutate(server, OWNER, delEvent)).errors).toBeUndefined();
    expect((await mutate(server, OWNER, delFeed)).errors).toBeUndefined();
  });

  it('guards array writes, which would otherwise take the batch resolver around the guard', async () => {
    const server = await setup();
    const feed = await createFeed(server);
    const events = await mutate(server, STRANGER, {
      [`${NS}/createSessionFeedEvent`]: [1, 2].map((step) => ({
        params: { feed, step, kind: 'reply', text: 'forged' },
        fields: { id: true }
      }))
    });
    expect(code(events)).toBe('not_owner');
    const updates = await mutate(server, STRANGER, {
      [`${NS}/updateSessionFeed`]: [
        { params: { id: feed, title: 'mine now' }, fields: { id: true } }
      ]
    });
    expect(code(updates)).toBe('not_owner');
  });

  it('retires the by-filter writes that would reach autoCRUD around the guard', async () => {
    const server = await setup();
    await createFeed(server);
    const env = await mutate(server, STRANGER, {
      [`${NS}/updateManySessionFeed`]: {
        params: { where: { instance: { eq: 'session:1a2b3c4d' } }, set: { title: 'mine now' } },
        fields: { count: true }
      }
    });
    expect(env.errors).toBeDefined();
    const left = await call(server, OWNER, '/substrate/v1/query', {
      [`${NS}/SessionFeed`]: { params: {}, fields: { title: true } }
    });
    expect(left.data[`${NS}/SessionFeed`]).toEqual([{ title: 'wire the relay' }]);
  });
});
