// cortext/Task + cortext/ExecutionCheckpoint: the identity a fresh session
// resumes by, and the acknowledged steps under it. Pins the schema and the
// resume read (latest = highest revision) against a composed substrate.

import type { PackEnvelope } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeNamespace, CLAUDE_TYPE_NAMES, TASK_STATUS_VOCAB } from '../src/index.js';
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

async function createTask(server: MemorySubstrateServer, params: object): Promise<string> {
  const env = await call(server, '/substrate/v1/mutate', {
    [`${NS}/createTask`]: { params, fields: { id: true } }
  });
  expect(env.errors).toBeUndefined();
  return (env.data[`${NS}/createTask`] as { id: string }).id;
}

describe('cortext/Task', () => {
  it('is a registered type with an active | paused | done status', () => {
    expect(CLAUDE_TYPE_NAMES).toContain('Task');
    expect([...TASK_STATUS_VOCAB]).toEqual(['active', 'paused', 'done']);
  });

  it('defaults status to active and filters by project and status', async () => {
    const server = await setup();
    await createTask(server, { title: 'audit the GGUF loader', project: 'example' });
    await createTask(server, { title: 'older work', project: 'example', status: 'done' });

    const active = await call(server, '/substrate/v1/query', {
      [`${NS}/Task`]: {
        params: { where: { project: { eq: 'example' }, status: { eq: 'active' } } },
        fields: { title: true, status: true }
      }
    });
    expect(active.errors).toBeUndefined();
    expect(active.data[`${NS}/Task`]).toEqual([
      { title: 'audit the GGUF loader', status: 'active' }
    ]);
  });

  it('refuses a status outside the vocabulary', async () => {
    const server = await setup();
    const env = await call(server, '/substrate/v1/mutate', {
      [`${NS}/createTask`]: { params: { title: 't', status: 'started' }, fields: { id: true } }
    });
    expect(env.errors?.[0]?.message ?? '').toMatch(/status/);
  });
});

describe('cortext/ExecutionCheckpoint', () => {
  it('declares task + revision unique among live rows', () => {
    const def = buildClaudeNamespace(NS).types?.ExecutionCheckpoint as unknown as {
      indexes?: unknown[];
    };
    expect(def.indexes).toEqual([
      {
        fields: ['task', { field: 'revision', dir: 'desc' }],
        unique: true,
        where: 'live',
        name: 'rows_execution_checkpoint_task_revision_unique'
      }
    ]);
  });

  it("resumes from the task's highest revision", async () => {
    const server = await setup();
    const task = await createTask(server, { title: 'audit the GGUF loader', project: 'example' });
    const steps = [
      { revision: 1, completed: 'read the header parser', nextAction: 'list tensor types' },
      {
        revision: 2,
        completed: 'listed tensor types',
        nextAction: 'check quantisation of each type',
        refs: ['src/loader.ts:120', '#42']
      }
    ];
    const written = await call(server, '/substrate/v1/mutate', {
      [`${NS}/createExecutionCheckpoint`]: steps.map((s) => ({
        params: { ...s, task, project: 'example' },
        fields: { id: true }
      }))
    });
    expect(written.errors).toBeUndefined();

    const latest = await call(server, '/substrate/v1/query', {
      [`${NS}/ExecutionCheckpoint`]: {
        params: { where: { task: { eq: task } }, orderBy: [{ revision: 'desc' }], limit: 1 },
        fields: { revision: true, nextAction: true, refs: true }
      }
    });
    expect(latest.errors).toBeUndefined();
    expect(latest.data[`${NS}/ExecutionCheckpoint`]).toEqual([
      {
        revision: 2,
        nextAction: 'check quantisation of each type',
        refs: ['src/loader.ts:120', '#42']
      }
    ]);
  });
});
