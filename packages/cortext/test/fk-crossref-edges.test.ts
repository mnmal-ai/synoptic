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

describe('Flipped FK crossRef edges', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('Decision.sessionId: set_null when SessionLog is deleted', async () => {
    const { server, composed, stop } = await setup();
    cleanup = stop;

    const slRes = await mutate(server, {
      'claude/createSessionLog': {
        params: {
          branch: 'main',
          startedAt: '2026-04-29T00:00:00Z',
          summary: 'session for FK edge test',
          decisionsCount: 0,
          packages: 'cortext',
          archived: false,
          project: 'substrate'
        },
        fields: { id: true }
      }
    });
    const sl = jsonBody<PackEnvelope>(slRes).data['claude/createSessionLog'] as {
      id: string;
    };

    const dRes = await mutate(server, {
      'claude/createDecision': {
        params: {
          topic: 't',
          choice: 'x',
          rationale: 'r',
          status: 'active',
          revisitWhen: '',
          archived: false,
          project: 'substrate',
          sessionId: sl.id
        },
        fields: { id: true, sessionId: true }
      }
    });
    const dEnv = jsonBody<PackEnvelope>(dRes);
    expect(dEnv.errors, 'createDecision with sessionId crossRef should succeed').toBeUndefined();
    const d = dEnv.data['claude/createDecision'] as {
      id: string;
      sessionId: string | null;
    };
    expect(d.sessionId).toBe(sl.id);

    await mutate(server, {
      'claude/deleteSessionLog': { params: { id: sl.id }, fields: { id: true } }
    });
    await composed.runSweepNow();

    const readEnv = jsonBody<PackEnvelope>(
      await query(server, {
        'claude/getDecision': {
          params: { id: d.id },
          fields: { id: true, sessionId: true }
        }
      })
    );
    const row = readEnv.data['claude/getDecision'] as {
      id: string;
      sessionId: string | null;
    } | null;
    expect(row, 'Decision should survive SessionLog delete').not.toBeNull();
    expect(row?.sessionId, 'sessionId should be nulled by sweep').toBeNull();
  });

  it('CouncilAdvisor.councilSessionId: cascade when CouncilSession is deleted', async () => {
    const { server, composed, stop } = await setup();
    cleanup = stop;

    const csRes = await mutate(server, {
      'claude/createCouncilSession': {
        params: {
          question: 'q?',
          slug: 'fk-cascade-test',
          context: '',
          options: '',
          agreement: '',
          disagreement: '',
          blindSpots: '',
          verdict: '',
          verdictAlignment: 'unanimous',
          date: '2026-04-29',
          project: 'substrate'
        },
        fields: { id: true }
      }
    });
    const cs = jsonBody<PackEnvelope>(csRes).data['claude/createCouncilSession'] as {
      id: string;
    };

    const aRes = await mutate(server, {
      'claude/createCouncilAdvisor': {
        params: {
          councilSessionId: cs.id,
          role: 'reviewer',
          response: 'r',
          recommendation: 'rec'
        },
        fields: { id: true, councilSessionId: true }
      }
    });
    const aEnv = jsonBody<PackEnvelope>(aRes);
    expect(
      aEnv.errors,
      'createCouncilAdvisor with councilSessionId should succeed'
    ).toBeUndefined();
    const advisor = aEnv.data['claude/createCouncilAdvisor'] as {
      id: string;
      councilSessionId: string | null;
    };
    expect(advisor.councilSessionId).toBe(cs.id);

    await mutate(server, {
      'claude/deleteCouncilSession': { params: { id: cs.id }, fields: { id: true } }
    });
    await composed.runSweepNow();

    const readEnv = jsonBody<PackEnvelope>(
      await query(server, {
        'claude/getCouncilAdvisor': {
          params: { id: advisor.id },
          fields: { id: true }
        }
      })
    );
    const row = readEnv.data['claude/getCouncilAdvisor'];
    expect(row, 'CouncilAdvisor should cascade-delete with its CouncilSession').toBeNull();
  });
});
