/**
 * Governed vocabularies on cortext. The server, not the
 * agent, maps the words agents reach for onto canonical values, on write and
 * in filters. Decision.status stays OPEN: an undeclared state is still
 * written as-is. AgentRule.severity is CLOSED.
 */

import type { SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import { compose, MemoryDataset, MemorySubstrateServer } from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'claude';

function jsonBody<T>(res: SubstrateResponse): T {
  const b = res.body;
  const text =
    typeof b === 'string'
      ? b
      : Buffer.isBuffer(b)
        ? b.toString('utf8')
        : b instanceof Uint8Array
          ? Buffer.from(b).toString('utf8')
          : '';
  return JSON.parse(text) as T;
}

async function setup(): Promise<{ server: MemorySubstrateServer; stop: () => Promise<void> }> {
  const server = new MemorySubstrateServer();
  const composed = await compose({
    // substrate refuses an unattributed write rather than defaulting it to
    // `system:anonymous` (which is how 1,367 such rows accumulated in the live
    // store). With no `auth` there is no caller to attribute to, so an
    // unauthenticated deployment DECLARES who it writes as. Ignored when `auth`
    // is set, so only the no-auth compose sites carry it.
    systemActor: 'cortext-test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: {
      [NS]: new MemoryDataset({ namespace: NS }),
      architecture: new MemoryDataset({ namespace: 'architecture' })
    },
    coordinators: [buildClaudeForTest({ namespace: NS, compactRetention: 3 })]
  });
  await server.start();
  return { server, stop: async (): Promise<void> => void (await composed.stop()) };
}

interface Envelope {
  data: Record<string, Record<string, unknown> | Record<string, unknown>[]>;
  errors?: { code?: string; message?: string }[];
}

async function call(
  server: MemorySubstrateServer,
  path: '/substrate/v1/mutate' | '/substrate/v1/query',
  payload: unknown
): Promise<Envelope> {
  const res = await server.inject({
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload))
  });
  return jsonBody<Envelope>(res);
}

const createDecision = (server: MemorySubstrateServer, status: string): Promise<Envelope> =>
  call(server, '/substrate/v1/mutate', {
    [`${NS}/createDecision`]: {
      params: { topic: 'probe', choice: 'probe', rationale: 'probe', status },
      fields: { id: true, status: true }
    }
  });

const createRule = (server: MemorySubstrateServer, severity: string): Promise<Envelope> =>
  call(server, '/substrate/v1/mutate', {
    [`${NS}/createAgentRule`]: {
      params: { rule: 'probe', category: 'process', active: false, rationale: 'probe', severity },
      fields: { id: true, severity: true }
    }
  });

describe('cortext vocabulary aliases', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it.each([
    ['accepted', 'active'],
    ['adopted', 'active'],
    ['decided', 'active'],
    ['proposed', 'open']
  ])('Decision.status %s is written as %s', async (alias, canonical) => {
    const { server, stop } = await setup();
    cleanup = stop;
    const env = await createDecision(server, alias);
    expect(env.errors).toBeUndefined();
    expect(env.data[`${NS}/createDecision`]).toMatchObject({ status: canonical });
  });

  it('Decision.status still admits an undeclared state, as written', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const env = await createDecision(server, 'experimental');
    expect(env.errors, 'a non-strict vocabulary must not reject').toBeUndefined();
    expect(env.data[`${NS}/createDecision`]).toMatchObject({ status: 'experimental' });
  });

  it('a filter on an alias finds the canonical rows', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await createDecision(server, 'active');
    const env = await call(server, '/substrate/v1/query', {
      [`${NS}/Decision`]: {
        params: { where: { status: { eq: 'accepted' } } },
        fields: { status: true }
      }
    });
    expect(env.errors).toBeUndefined();
    expect(env.data[`${NS}/Decision`]).toEqual([{ status: 'active' }]);
  });

  it.each([
    ['high', 'must'],
    ['medium', 'should']
  ])('AgentRule.severity %s is written as %s', async (alias, canonical) => {
    const { server, stop } = await setup();
    cleanup = stop;
    const env = await createRule(server, alias);
    expect(env.errors).toBeUndefined();
    expect(env.data[`${NS}/createAgentRule`]).toMatchObject({ severity: canonical });
  });

  it('AgentRule.severity is closed: an unknown severity is rejected', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const env = await createRule(server, 'critical');
    expect(env.errors?.[0]?.code).toBe('invalid_enum_value');
  });

  const createTodo = (server: MemorySubstrateServer, params: Record<string, unknown>) =>
    call(server, '/substrate/v1/mutate', {
      [`${NS}/createTodo`]: {
        params: { title: 'probe', area: 'test', priority: 'low', ...params },
        fields: { id: true, status: true, resolution: true }
      }
    });

  it.each([
    ['done', 'completed'],
    ['cancelled', 'wont_do'],
    ['superseded', 'superseded']
  ])('Todo status %s closes it with resolution %s', async (word, resolution) => {
    const { server, stop } = await setup();
    cleanup = stop;
    const env = await createTodo(server, { status: word });
    expect(env.errors).toBeUndefined();
    expect(env.data[`${NS}/createTodo`]).toMatchObject({ status: 'closed', resolution });
  });

  it('refuses a closing word that contradicts an explicit resolution', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const env = await createTodo(server, { status: 'done', resolution: 'wont_do' });
    expect(env.errors?.[0]?.code).toBe('conflicting_implication');
  });

  it('a live Todo has no resolution', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const env = await createTodo(server, { status: 'not_started' });
    const row = env.data[`${NS}/createTodo`] as Record<string, unknown>;
    expect(row.status).toBe('open');
    expect(row.resolution ?? null).toBeNull();
  });
});
