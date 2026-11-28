// The relay Directory: the local agents a peer may address, answered only to an active MailPeer's inbound key.

import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { compose, MemoryDataset, MemorySubstrateServer } from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeForTest } from './_helpers.js';

const AGENT = 'agent-a@host-a.example';
const PEER = 'relay-peer@peer.example.net';
const STRANGER = 'stranger@peer.example.net';
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
    [PEER]: { namespaces: 'cortext-relay', capabilities: 'read,mutate' },
    [STRANGER]: { namespaces: 'cortext-relay', capabilities: 'read,mutate' }
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
  return { query, engine: composed.engine };
}

const DIRECTORY = {
  'cortext-relay/Directory': {
    params: {},
    fields: { id: true, kid: true, displayName: true, project: true, description: true }
  }
};

const PEER_ROW = {
  id: 'p1',
  domain: 'peer.example.net',
  origin: 'https://peer.example.net:3100',
  inboundKid: PEER,
  outboundKid: 'relay-out@host-a.example',
  outboundKeyPath: '/etc/substrate/keys/relay.key',
  active: true
};

async function directory(
  rows: Array<Record<string, unknown>>,
  peer: Record<string, unknown> = PEER_ROW,
  kid = PEER
) {
  const { query, engine } = await setup({ mailDomain: 'substrate.example.org' });
  const ds = engine.datasetFor('cortext');
  await ds?.write('MailPeer', [peer]);
  await ds?.write('AgentIdentity', rows);
  return query(DIRECTORY, kid);
}

const ident = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kid: `${id}@host-a.example`,
  host: 'secret-host',
  active: true,
  ...extra
});

describe('relay Directory', () => {
  it('lists active local agents with kid, displayName, project and description', async () => {
    const res = await directory([
      ident('a', { displayName: 'Agent A', project: 'proj', description: 'does things' })
    ]);
    expect(res.errors).toBeUndefined();
    expect(res.data?.['cortext-relay/Directory']).toEqual([
      {
        id: 'a',
        kid: 'a@host-a.example',
        displayName: 'Agent A',
        project: 'proj',
        description: 'does things'
      }
    ]);
  });

  it('omits listed:false, inactive and remote rows', async () => {
    const res = await directory([
      ident('a'),
      ident('hidden', { listed: false }),
      ident('gone', { active: false }),
      ident('remote', { domain: 'peer.example.net' })
    ]);
    expect(res.data?.['cortext-relay/Directory']?.map((r) => r.id)).toEqual(['a']);
  });

  it('lists a row written before the listed field existed', async () => {
    const res = await directory([ident('old')]);
    expect(res.data?.['cortext-relay/Directory']?.map((r) => r.id)).toEqual(['old']);
  });

  it('refuses a signed caller that is no peer', async () => {
    const res = await directory([ident('a')], PEER_ROW, STRANGER);
    expect(res.data?.['cortext-relay/Directory']).toBeUndefined();
    expect(res.errors?.[0]?.code).toBe('unknown_peer');
  });

  it('refuses an inactive peer', async () => {
    const res = await directory([ident('a')], { ...PEER_ROW, active: false });
    expect(res.data?.['cortext-relay/Directory']).toBeUndefined();
    expect(res.errors?.[0]?.code).toBe('unknown_peer');
  });
});
