// The HostInstall writer (synoptic host-report.js) against a composed substrate:
// create on first report, update on the second, one row throughout.

import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS module from the sibling package, no declarations
import { buildHostInstallRecord } from '../../synoptic/src/host-install.js';
// @ts-expect-error -- plain JS module from the sibling package, no declarations
import { reportHostInstall } from '../../synoptic/src/host-report.js';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'cortext';
let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

async function setup() {
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
  const token = signHs256(
    {
      sub: 'synoptic-claude@host-a',
      exp: Math.floor(Date.now() / 1000) + 3600,
      capabilities: ['read', 'mutate']
    },
    'test-secret',
    { kid: 'test' }
  );
  const fetchImpl = async (url: string, init: { body: string }) => {
    const res = await server.inject({
      method: 'POST',
      path: new URL(url).pathname,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: Buffer.from(init.body)
    });
    const text = Buffer.from(res.body as Uint8Array).toString('utf8');
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => JSON.parse(text)
    };
  };
  return { server, fetchImpl, token };
}

const record = (nowMs: number) =>
  buildHostInstallRecord({
    hostname: 'Host-A',
    project: 'synoptic',
    kid: 'synoptic-claude@host-a',
    harness: 'claude-code',
    pluginVersion: '2.9.0',
    drift: { state: 'current', installed: { version: '2.9.0', digest: 'cb15e93a' } },
    nowMs
  });

describe('reportHostInstall against a composed substrate', () => {
  it('creates, then updates the same row', async () => {
    const { fetchImpl } = await setup();
    const base = { substrateUrl: 'http://substrate.test', namespace: NS, fetchImpl };
    expect(await reportHostInstall({ ...base, record: record(Date.UTC(2026, 9, 9)) })).toBe(
      'created'
    );
    expect(await reportHostInstall({ ...base, record: record(Date.UTC(2026, 9, 10)) })).toBe(
      'updated'
    );

    const res = await fetchImpl('http://substrate.test/substrate/v1/query', {
      body: JSON.stringify({
        [`${NS}/HostInstall`]: { params: {}, fields: { key: true, refreshedAt: true } }
      })
    });
    const rows = (await res.json()).data[`${NS}/HostInstall`];
    expect(rows).toEqual([
      { key: 'host-a/synoptic/claude-code', refreshedAt: '2026-10-10T00:00:00.000Z' }
    ]);
  });

  it('round-trips the check verdicts and the settings snapshot', async () => {
    const { fetchImpl } = await setup();
    const checks = {
      pinState: 'ok',
      pinNote: 'installed 2.9.0 matches',
      mcpJsonState: 'ok',
      mcpJsonNote: 'no project .mcp.json',
      authorityState: 'warn',
      authorityNote: 'grant lacks mutate on recall',
      settingsState: 'ok',
      settingsNote: 'parses',
      settingsEnv: {
        SUBSTRATE_NAMESPACE: 'cortext',
        SUBSTRATE_AGENT_KEY_ID: true,
        SUBSTRATE_AGENT_KEY_PATH: true
      }
    };
    const base = { substrateUrl: 'http://substrate.test', namespace: NS, fetchImpl };
    expect(
      await reportHostInstall({ ...base, record: { ...record(Date.UTC(2026, 9, 9)), ...checks } })
    ).toBe('created');
    expect(
      await reportHostInstall({
        ...base,
        record: { ...record(Date.UTC(2026, 9, 10)), ...checks, authorityState: 'ok' }
      })
    ).toBe('updated');
    const res = await fetchImpl('http://substrate.test/substrate/v1/query', {
      body: JSON.stringify({
        [`${NS}/HostInstall`]: {
          params: {},
          fields: { authorityState: true, settingsEnv: true, pinNote: true }
        }
      })
    });
    expect((await res.json()).data[`${NS}/HostInstall`]).toEqual([
      { authorityState: 'ok', settingsEnv: checks.settingsEnv, pinNote: checks.pinNote }
    ]);
  });

  it('replaces a same-harness legacy host/project row, and leaves another harness alone', async () => {
    const { fetchImpl } = await setup();
    const legacy = (harness: string) => ({
      ...record(Date.UTC(2026, 9, 1)),
      key: 'host-a/synoptic',
      harness
    });
    for (const harness of ['claude-code', 'opencode']) {
      await fetchImpl('http://substrate.test/substrate/v1/mutate', {
        body: JSON.stringify({
          [`${NS}/createHostInstall`]: { params: legacy(harness), fields: { id: true } }
        })
      });
    }
    const base = { substrateUrl: 'http://substrate.test', namespace: NS, fetchImpl };
    expect(await reportHostInstall({ ...base, record: record(Date.UTC(2026, 9, 9)) })).toBe(
      'created'
    );

    const res = await fetchImpl('http://substrate.test/substrate/v1/query', {
      body: JSON.stringify({
        [`${NS}/HostInstall`]: { params: {}, fields: { key: true, harness: true } }
      })
    });
    const rows = (await res.json()).data[`${NS}/HostInstall`] as Array<{ key: string }>;
    expect(rows.map((r) => r.key).sort()).toEqual([
      'host-a/synoptic',
      'host-a/synoptic/claude-code'
    ]);
    expect(rows.find((r) => r.key === 'host-a/synoptic')).toMatchObject({ harness: 'opencode' });
  });
});
