// synoptic's `probeWhoami` + the audit encode assumptions about
// substrate's /substrate/v1/whoami wire shape (grants present for a dataset-backed key, a
// non-uniform grant, no flat capability fields). Every other test of
// them hand-builds the response, so they pin what synoptic BELIEVES and would
// stay green through any substrate change to the contract.
//
// This one does not. It composes a real substrate, registers a dataset-backed key
// with a NON-UNIFORM grant, signs with synoptic's own client signer, and runs
// the response through `probeWhoami`. Nothing in the path is hand-built, so a
// catalog bump that changes the contract fails here.

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compose, MemoryDataset, MemorySubstrateServer } from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS module from the sibling package, no declarations
import { createAgentAuth, makeSignedFetch } from '../../synoptic/src/agent-auth.js';
// @ts-expect-error -- plain JS module from the sibling package, no declarations
import { probeWhoami } from '../../synoptic/src/substrate-http.js';

const KID = 'probe-claude@test';

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

/** A substrate whose `_system` store holds one EdDSA key with the given grant entries. */
async function substrateWithKey(namespaces: string, capabilities: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'whoami-contract-'));
  const keyPath = join(dir, 'agent.key');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const substrateDataset = new MemoryDataset({ namespace: '_system' });
  await substrateDataset.write('Key', [
    {
      id: 'k1',
      kid: KID,
      algorithm: 'EdDSA',
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      namespaces,
      capabilities,
      revokedAt: null
    }
  ]);

  const server = new MemorySubstrateServer();
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: { _system: substrateDataset },
    auth: { keys: [], mode: 'attribute' },
    streamTicketSecret: 'test-stream-ticket-secret'
  });
  await server.start();
  stop = () => composed.stop();

  // The Fetch shape probeWhoami expects, served by in-process injection.
  const inject = async (url: string, init: { headers?: Record<string, string> } = {}) => {
    const res = await server.inject({
      method: 'GET',
      path: new URL(url).pathname,
      headers: init.headers ?? {}
    });
    const text = Buffer.from(res.body as Uint8Array).toString('utf8');
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => JSON.parse(text)
    };
  };
  const auth = createAgentAuth({ SUBSTRATE_AGENT_KEY_ID: KID, SUBSTRATE_AGENT_KEY_PATH: keyPath });
  expect(auth.warning).toBeNull();
  return makeSignedFetch(auth.getAuthHeader, inject);
}

const sorted = (g: Record<string, string[]> | null) =>
  g === null ? null : Object.fromEntries(Object.entries(g).map(([k, v]) => [k, [...v].sort()]));

describe('whoami contract, executed against a composed substrate', () => {
  it('a NON-UNIFORM dataset grant arrives as per-namespace grants', async () => {
    const fetchImpl = await substrateWithKey('cortext:read+mutate,recall:read', 'read,mutate');
    const who = await probeWhoami('http://substrate.test', { fetchImpl });

    expect(who.ok).toBe(true);
    expect(who.authEnabled).toBe(true);
    expect(who.authenticated).toBe(true);
    expect(who.id).toBe(KID);
    expect(sorted(who.grants)).toEqual({ cortext: ['mutate', 'read'], recall: ['read'] });
    // The flat fields are absent, and synoptic reads absent as
    // null (unknown), never as empty. The audit derives the namespace set from
    // the grant keys instead.
    expect(who.capabilities).toBeNull();
    expect(who.namespaces).toBeNull();
  });

  it('a uniform grant arrives with the same caps on every namespace', async () => {
    const fetchImpl = await substrateWithKey('cortext,recall', 'read,mutate');
    const who = await probeWhoami('http://substrate.test', { fetchImpl });
    expect(sorted(who.grants)).toEqual({ cortext: ['mutate', 'read'], recall: ['mutate', 'read'] });
  });

  it('an unsigned ask is anonymous: authEnabled answers, identity does not', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      auth: { keys: [], mode: 'attribute' },
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    await server.start();
    try {
      const res = await server.inject({ method: 'GET', path: '/substrate/v1/whoami', headers: {} });
      const fetchImpl = async () => ({
        ok: true,
        status: res.status,
        json: async () => JSON.parse(Buffer.from(res.body as Uint8Array).toString('utf8'))
      });
      const who = await probeWhoami('http://substrate.test', { fetchImpl });
      expect(who).toEqual({ ok: true, authEnabled: true, authenticated: false });
    } finally {
      await composed.stop();
    }
  });
});
