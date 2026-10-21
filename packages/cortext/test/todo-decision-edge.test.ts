import type { PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import {
  type ComposeResult,
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'claude';

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

function jsonBody<T>(res: SubstrateResponse): T {
  return JSON.parse(bodyToString(res)) as T;
}

async function setup(): Promise<{
  server: MemorySubstrateServer;
  composed: ComposeResult;
  stop: () => Promise<void>;
}> {
  const server = new MemorySubstrateServer();
  const defaultDataset = new MemoryDataset({ namespace: 'default' });
  const claudeDataset = new MemoryDataset({ namespace: NS });
  const architectureDataset = new MemoryDataset({ namespace: 'architecture' });
  const plugin = buildClaudeForTest({ namespace: NS, compactRetention: 3 });
  const composed = await compose({
    server,
    dataset: defaultDataset,
    datasets: { [NS]: claudeDataset, architecture: architectureDataset },
    coordinators: [plugin],
    // Identity-gated deletes: these suites exercise edge-sweep
    // semantics THROUGH delete mutations, so they run as an identified
    // caller (attribute-mode auth + Bearer below) — matching how the real
    // agent operates against the commodity stack.
    auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' },
    // substrate fails compose() closed when auth is on and this is absent
    // or <16 chars — it is the sole auth on the ungated SSE GET routes.
    streamTicketSecret: 'test-stream-ticket-secret'
  });
  await server.start();
  return {
    server,
    composed,
    stop: async (): Promise<void> => {
      await composed.stop();
    }
  };
}

const TEST_BEARER = `Bearer ${signHs256(
  { sub: 'edge-test', exp: Math.floor(Date.now() / 1000) + 3600, capabilities: ['read', 'mutate'] },
  'test-secret',
  { kid: 'test' }
)}`;

async function mutate(server: MemorySubstrateServer, payload: unknown): Promise<SubstrateResponse> {
  return server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json', authorization: TEST_BEARER },
    body: Buffer.from(JSON.stringify(payload))
  });
}

async function query(server: MemorySubstrateServer, payload: unknown): Promise<SubstrateResponse> {
  return server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload))
  });
}

describe('Todo.implementsDecision edge behavior', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('round-trips a Todo with implementsDecision set to a Decision id', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const dRes = await mutate(server, {
      'claude/createDecision': {
        params: {
          topic: 'crossRef pattern',
          choice: 'use field.crossRef',
          rationale: 'r',
          status: 'active',
          revisitWhen: '',
          archived: false,
          project: 'substrate'
        },
        fields: { id: true }
      }
    });
    const dEnv = jsonBody<PackEnvelope>(dRes);
    expect(dEnv.errors).toBeUndefined();
    const d = dEnv.data['claude/createDecision'] as { id: string };

    const tRes = await mutate(server, {
      'claude/createTodo': {
        params: {
          title: 'implement the pattern',
          area: 'cortext',
          status: 'open',
          priority: 'high',
          notes: '',
          blockedBy: '',
          archived: false,
          project: 'substrate',
          implementsDecision: d.id
        },
        fields: { id: true, implementsDecision: true }
      }
    });
    const tEnv = jsonBody<PackEnvelope>(tRes);
    expect(tEnv.errors, 'createTodo with implementsDecision should succeed').toBeUndefined();
    const t = tEnv.data['claude/createTodo'] as {
      id: string;
      implementsDecision: string | null;
    };
    expect(t.implementsDecision).toBe(d.id);
  });

  it('set_null when the target Decision is deleted', async () => {
    const { server, composed, stop } = await setup();
    cleanup = stop;

    const dRes = await mutate(server, {
      'claude/createDecision': {
        params: {
          topic: 'doomed',
          choice: 'x',
          rationale: 'r',
          status: 'active',
          revisitWhen: '',
          archived: false,
          project: 'substrate'
        },
        fields: { id: true }
      }
    });
    const dEnv = jsonBody<PackEnvelope>(dRes);
    expect(dEnv.errors).toBeUndefined();
    const d = dEnv.data['claude/createDecision'] as { id: string };

    const tRes = await mutate(server, {
      'claude/createTodo': {
        params: {
          title: 'follows doomed decision',
          area: 'cortext',
          status: 'open',
          priority: 'low',
          notes: '',
          blockedBy: '',
          archived: false,
          project: 'substrate',
          implementsDecision: d.id
        },
        fields: { id: true, implementsDecision: true }
      }
    });
    const tEnv = jsonBody<PackEnvelope>(tRes);
    expect(tEnv.errors).toBeUndefined();
    const t = tEnv.data['claude/createTodo'] as {
      id: string;
      implementsDecision: string | null;
    };
    expect(t.implementsDecision).toBe(d.id);

    await mutate(server, {
      'claude/deleteDecision': { params: { id: d.id }, fields: { id: true } }
    });
    await composed.runSweepNow();

    const readEnv = jsonBody<PackEnvelope>(
      await query(server, {
        'claude/getTodo': {
          params: { id: t.id },
          fields: { id: true, implementsDecision: true }
        }
      })
    );
    expect(readEnv.errors).toBeUndefined();
    const row = readEnv.data['claude/getTodo'] as {
      id: string;
      implementsDecision: string | null;
    } | null;
    expect(row, 'Todo should survive Decision delete').not.toBeNull();
    expect(row?.implementsDecision, 'implementsDecision should be nulled').toBeNull();
  });
});
