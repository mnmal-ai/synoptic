// The relay namespace is the only surface a peer server's key is granted. These tests compose a
// real server and check what each key can reach: Info for a relay key, nothing in the coordinator
// namespace for it, and no relay namespace at all unless `mailDomain` is set.

import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { compose, MemoryDataset, MemorySubstrateServer } from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeForTest } from './_helpers.js';

const AGENT = 'agent-a@host-a.example';
const PEER = 'relay-peer@peer.example.net';
interface Envelope {
  data?: Record<string, Array<Record<string, unknown>>>;
  errors?: Array<{ code: string }>;
}
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

/** One EdDSA key per identity: its `_system/Key` row carries the namespace grant, the token only names the kid. */
async function setup(opts: { mailDomain?: string; namespace?: string } = {}) {
  const ns = opts.namespace ?? 'cortext';
  const grants: Record<string, { namespaces: string; capabilities: string }> = {
    [AGENT]: { namespaces: ns, capabilities: 'read,mutate' },
    [PEER]: { namespaces: 'cortext-relay', capabilities: 'read,mutate' }
  };
  const privateKeys = new Map<string, KeyObject>();
  const system = new MemoryDataset({ namespace: '_system' });
  await system.write(
    'Key',
    Object.entries(grants).map(([kid, g], i) => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      privateKeys.set(kid, privateKey);
      return {
        id: `k${i}`,
        kid,
        algorithm: 'EdDSA',
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        ...g,
        revokedAt: null
      };
    })
  );
  const server = new MemorySubstrateServer();
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: {
      _system: system,
      [ns]: new MemoryDataset({ namespace: ns }),
      architecture: new MemoryDataset({ namespace: 'architecture' }),
      'cortext-relay': new MemoryDataset({ namespace: 'cortext-relay' })
    },
    coordinators: [buildClaudeForTest({ namespace: ns, mailDomain: opts.mailDomain })],
    auth: { keys: [], mode: 'attribute' }
  });
  await server.start();
  stop = () => composed.stop();

  const token = (kid: string) => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
    const body = b64url(
      JSON.stringify({
        sub: kid,
        iat: now,
        exp: now + 3600,
        ns: ['*'],
        capabilities: ['read', 'mutate']
      })
    );
    const sig = sign(null, Buffer.from(`${head}.${body}`), privateKeys.get(kid) as KeyObject);
    return `${head}.${body}.${b64url(sig)}`;
  };
  const post = async (path: string, payload: unknown, kid?: string) => {
    const res = await server.inject({
      method: 'POST',
      path,
      headers: {
        'content-type': 'application/json',
        ...(kid !== undefined ? { authorization: `Bearer ${token(kid)}` } : {})
      },
      body: Buffer.from(JSON.stringify(payload))
    });
    const text = Buffer.from(res.body as Uint8Array).toString('utf8');
    return { status: res.status, body: JSON.parse(text) as Envelope };
  };
  const query = (frame: unknown, kid?: string) =>
    post('/substrate/v1/query', frame, kid).then((r) => r.body);
  const mutate = (frame: unknown, kid?: string) =>
    post('/substrate/v1/mutate', frame, kid).then((r) => r.body);
  return { query, mutate, engine: composed.engine };
}

const INFO = {
  'cortext-relay/Info': {
    params: {},
    fields: { id: true, v: true, domain: true, mailNamespace: true }
  }
};

describe('relay namespace boundary', () => {
  it('registers no relay namespace without mailDomain', async () => {
    const { query } = await setup();
    const res = await query(INFO, PEER);
    expect(res.errors?.[0]?.code).toBe('unknown_namespace');
  });

  it('answers Info to a relay key', async () => {
    const { query } = await setup({ mailDomain: 'substrate.example.org' });
    const res = await query(INFO, PEER);
    expect(res.errors).toBeUndefined();
    expect(res.data?.['cortext-relay/Info']?.[0]).toEqual({
      id: 'info',
      v: 1,
      domain: 'substrate.example.org',
      mailNamespace: 'cortext'
    });
  });

  it('refuses Info without a key', async () => {
    const { query } = await setup({ mailDomain: 'substrate.example.org' });
    const res = await query(INFO);
    expect(res.data?.['cortext-relay/Info']).toBeUndefined();
    expect(res.errors?.[0]?.code).toBe('policy_denied');
  });

  it('refuses Info to a key granted only the coordinator namespace', async () => {
    const { query } = await setup({ mailDomain: 'substrate.example.org' });
    const res = await query(INFO, AGENT);
    expect(res.data?.['cortext-relay/Info']).toBeUndefined();
    expect(res.errors?.[0]?.code).toBe('unauthorized_namespace');
  });

  it('refuses a relay key on cortext/AgentMessage', async () => {
    const { query } = await setup({ mailDomain: 'substrate.example.org' });
    const res = await query({ 'cortext/AgentMessage': { params: {}, fields: { id: true } } }, PEER);
    expect(res.errors?.[0]?.code).toBe('unauthorized_namespace');
  });

  it('refuses a relay key on cortext/sendAgentMessage', async () => {
    const { mutate } = await setup({ mailDomain: 'substrate.example.org' });
    const res = await mutate(
      {
        'cortext/sendAgentMessage': {
          params: { to: [AGENT], subject: 's', body: 'b' },
          fields: { id: true }
        }
      },
      PEER
    );
    expect(res.errors?.[0]?.code).toBe('unauthorized_namespace');
  });

  it('refuses a relay key on recall with namespace cortext', async () => {
    // POST /substrate/v1/recall is a kernel route the binary mounts; it gates each (namespace, type)
    // through engine.evaluateReadPolicy with the caller's identity, which is the call made here.
    const { engine } = await setup({ mailDomain: 'substrate.example.org' });
    const peer = { id: PEER, grants: { 'cortext-relay': ['read', 'mutate'] } };
    const agent = { id: AGENT, grants: { cortext: ['read', 'mutate'] } };
    expect(engine.evaluateReadPolicy('cortext', 'Memory', peer).allow).toBe(false);
    expect(engine.evaluateReadPolicy('cortext', 'Memory', agent).allow).toBe(true);
  });

  it('reports mailNamespace when the coordinator is renamed', async () => {
    const { query } = await setup({ mailDomain: 'substrate.example.org', namespace: 'codex' });
    const res = await query(INFO, PEER);
    expect(res.data?.['cortext-relay/Info']?.[0]?.mailNamespace).toBe('codex');
  });
});
