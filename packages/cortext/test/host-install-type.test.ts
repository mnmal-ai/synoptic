// cortext/HostInstall: one row per (host, repo, harness),
// written by each session's cold-start. This pins the schema the writer and the
// fleet audit rely on, against a composed substrate rather than a hand-built shape.

import type { PackEnvelope } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_TYPE_NAMES,
  HOST_INSTALL_CHECK_STATES,
  HOST_INSTALL_FRAGMENT_STATES
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

const RECORD = {
  key: 'host-a/synoptic/claude-code',
  host: 'host-a',
  hostReported: 'Host-A',
  project: 'synoptic',
  kid: 'synoptic-claude@host-a',
  harness: 'claude-code',
  pluginVersion: '2.9.0',
  fragmentVersion: '2.9.0',
  fragmentDigest: 'cb15e93a',
  fragmentState: 'source',
  refreshedAt: '2026-10-09T12:00:00.000Z'
};

describe('cortext/HostInstall', () => {
  it('is a registered cortext type', () => {
    expect(CLAUDE_TYPE_NAMES).toContain('HostInstall');
    expect([...HOST_INSTALL_FRAGMENT_STATES]).toEqual([
      'current',
      'stale',
      'missing',
      'undigested',
      'uncomparable',
      'source',
      'absent'
    ]);
  });

  it('creates, updates, and filters by host and key', async () => {
    const server = await setup();
    const created = await call(server, '/substrate/v1/mutate', {
      [`${NS}/createHostInstall`]: { params: RECORD, fields: { id: true } }
    });
    expect(created.errors).toBeUndefined();
    const id = (created.data[`${NS}/createHostInstall`] as { id: string }).id;

    const updated = await call(server, '/substrate/v1/mutate', {
      [`${NS}/updateHostInstall`]: {
        params: { id, refreshedAt: '2026-10-10T08:00:00.000Z' },
        fields: { id: true, refreshedAt: true }
      }
    });
    expect(updated.errors).toBeUndefined();

    const byHost = await call(server, '/substrate/v1/query', {
      [`${NS}/HostInstall`]: {
        params: { where: { host: { eq: 'host-a' } } },
        fields: { key: true, refreshedAt: true }
      }
    });
    expect(byHost.data[`${NS}/HostInstall`]).toEqual([
      { key: 'host-a/synoptic/claude-code', refreshedAt: '2026-10-10T08:00:00.000Z' }
    ]);
  });

  it('carries the four check verdicts, filterable, and accepts a row without them', async () => {
    expect([...HOST_INSTALL_CHECK_STATES]).toEqual(['ok', 'warn', 'unknown']);
    const server = await setup();
    const checks = {
      pinState: 'ok',
      pinNote: 'installed 2.9.0 matches',
      mcpJsonState: 'ok',
      mcpJsonNote: null,
      authorityState: 'warn',
      authorityNote: 'grant lacks mutate on recall',
      settingsState: 'ok',
      settingsNote: null,
      settingsEnv: {
        SUBSTRATE_NAMESPACE: 'cortext',
        SYNOPTIC_INBOX_PUSH: 'on',
        SUBSTRATE_AGENT_KEY_ID: true
      }
    };
    const a = await call(server, '/substrate/v1/mutate', {
      [`${NS}/createHostInstall`]: { params: { ...RECORD, ...checks }, fields: { id: true } }
    });
    expect(a.errors).toBeUndefined();
    const b = await call(server, '/substrate/v1/mutate', {
      [`${NS}/createHostInstall`]: {
        params: { ...RECORD, key: 'other/p/claude-code', host: 'other' },
        fields: { id: true }
      }
    });
    expect(b.errors).toBeUndefined();

    const warned = await call(server, '/substrate/v1/query', {
      [`${NS}/HostInstall`]: {
        params: { where: { authorityState: { eq: 'warn' } } },
        fields: { key: true, authorityNote: true, settingsEnv: true }
      }
    });
    expect(warned.data[`${NS}/HostInstall`]).toEqual([
      {
        key: RECORD.key,
        authorityNote: 'grant lacks mutate on recall',
        settingsEnv: checks.settingsEnv
      }
    ]);
  });

  it('refuses a check state outside the vocabulary', async () => {
    const server = await setup();
    const env = await call(server, '/substrate/v1/mutate', {
      [`${NS}/createHostInstall`]: { params: { ...RECORD, pinState: 'fine' }, fields: { id: true } }
    });
    expect(env.errors?.[0]?.message ?? '').toMatch(/pinState/);
  });

  it('refuses a fragmentState outside the vocabulary', async () => {
    const server = await setup();
    const env = await call(server, '/substrate/v1/mutate', {
      [`${NS}/createHostInstall`]: {
        params: { ...RECORD, fragmentState: 'fine' },
        fields: { id: true }
      }
    });
    expect(env.errors?.[0]?.message ?? '').toMatch(/fragmentState/);
  });
});
