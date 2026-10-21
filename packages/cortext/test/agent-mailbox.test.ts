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
  const plugin = buildClaudeForTest({ namespace: NS });
  const composed: ComposeResult = await compose({
    server,
    dataset: defaultDataset,
    datasets: { [NS]: claudeDataset, architecture: architectureDataset },
    coordinators: [plugin],
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

function bearer(sub: string): string {
  return `Bearer ${signHs256(
    { sub, exp: Math.floor(Date.now() / 1000) + 3600, capabilities: ['read', 'mutate'] },
    'test-secret',
    { kid: 'test' }
  )}`;
}

async function mutateAs(
  server: MemorySubstrateServer,
  sub: string,
  payload: unknown
): Promise<SubstrateResponse> {
  return server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json', authorization: bearer(sub) },
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

describe('claude/AgentIdentity directory', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('round-trips a directory row and filters by kid', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await mutateAs(server, 'cortext@host-a', {
      'claude/createAgentIdentity': {
        params: {
          kid: 'peer-claude@host-a',
          project: 'app',
          host: 'host-a',
          displayName: 'App',
          description: 'learned-selves architecture agent',
          active: true
        },
        fields: { id: true, kid: true, active: true }
      }
    });
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors, 'createAgentIdentity should succeed').toBeUndefined();
    const created = env.data['claude/createAgentIdentity'] as {
      id: string;
      kid: string;
      active: boolean;
    };
    expect(created.kid).toBe('peer-claude@host-a');
    expect(created.active).toBe(true);

    const qRes = await query(server, {
      'claude/AgentIdentity': {
        params: { where: { kid: { eq: 'peer-claude@host-a' } } },
        fields: { id: true, kid: true, project: true, host: true }
      }
    });
    const qEnv = jsonBody<PackEnvelope>(qRes);
    expect(qEnv.errors).toBeUndefined();
    const rows = qEnv.data['claude/AgentIdentity'] as Array<{ kid: string; project: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.project).toBe('app');
  });

  it('defaults active to true when omitted', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await mutateAs(server, 'cortext@host-a', {
      'claude/createAgentIdentity': {
        params: { kid: 'baseline-claude@host-a', host: 'host-a' },
        fields: { id: true, active: true }
      }
    });
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeUndefined();
    const created = env.data['claude/createAgentIdentity'] as { active: boolean };
    expect(created.active).toBe(true);
  });
});

// Send/fan-out semantics, recipient-only transitions, and the retired direct
// write paths live in agent-mailbox-send.test.ts.

describe('claude/AgentMessage — non-repudiable sender (spec §3)', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  async function makeIdentity(server: MemorySubstrateServer, kid: string): Promise<string> {
    const res = await mutateAs(server, 'cortext@host-a', {
      'claude/createAgentIdentity': { params: { kid, host: 'host-a' }, fields: { id: true } }
    });
    return (jsonBody<PackEnvelope>(res).data['claude/createAgentIdentity'] as { id: string }).id;
  }

  it('stamps createdBy from the signed principal and filters "sent by X" via createdById', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const notesId = await makeIdentity(server, 'notes-claude@host-a');

    await mutateAs(server, 'peer-claude@host-a', {
      'claude/sendAgentMessage': {
        params: { to: 'notes-claude@host-a', subject: 'from peer', body: 'x' },
        fields: { id: true }
      }
    });
    await mutateAs(server, 'baseline-claude@host-a', {
      'claude/sendAgentMessage': {
        params: { to: 'notes-claude@host-a', subject: 'from baseline', body: 'y' },
        fields: { id: true }
      }
    });

    const allRes = await query(server, {
      'claude/AgentMessage': {
        params: { where: { recipient: { eq: notesId } } },
        fields: { subject: true, _metadata: true }
      }
    });
    const all = jsonBody<PackEnvelope>(allRes).data['claude/AgentMessage'] as Array<{
      subject: string;
      _metadata: { createdBy: { kind: string; id: string } };
    }>;
    const fromPeer = all.find((r) => r.subject === 'from peer');
    // kind is 'user' because the test harness signs HS256 static-key tokens
    // (→ tokenId → kind:'user'). In production, agents authenticate with JWTs
    // backed by registered _system/Key rows (→ agentKeyId → kind:'agent'). Either
    // way `id` is the signer — that's the non-repudiation property under test.
    expect(fromPeer?._metadata.createdBy).toEqual({ kind: 'user', id: 'peer-claude@host-a' });

    const sentRes = await query(server, {
      'claude/AgentMessage': {
        params: { where: { createdById: { eq: 'peer-claude@host-a' } } },
        fields: { subject: true }
      }
    });
    const sent = jsonBody<PackEnvelope>(sentRes).data['claude/AgentMessage'] as Array<{
      subject: string;
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe('from peer');
  });

  it('rejects a client attempt to smuggle createdBy through send params', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, 'notes-claude@host-a');

    // The forge attempt: smuggle a different sender via _metadata. The send
    // path's param allow-list refuses it outright (and the underlying create
    // resolver would refuse client-supplied server fields anyway), so there is
    // no path by which the stored createdBy could be the spoofed value.
    // (The positive half of non-repudiation — a clean send stamps the real
    // signer — is proven by the preceding test.)
    const res = await mutateAs(server, 'peer-claude@host-a', {
      'claude/sendAgentMessage': {
        params: {
          to: 'notes-claude@host-a',
          subject: 'spoof',
          body: 'z',
          _metadata: { createdBy: { kind: 'agent', id: 'cortext@host-a' } }
        },
        fields: { id: true }
      }
    });
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors, 'client-supplied _metadata must be rejected').toBeDefined();
    expect(env.errors?.[0]?.code).toBe('unknown_field');
  });
});
