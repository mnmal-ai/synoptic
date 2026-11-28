// Directory sync: each active peer's Info and Directory are read on a schedule, so the agents it
// lists are addressable here and those it drops are marked unlisted. A peer whose server answers
// an unsigned read of its mailbox is blocked, unless its row allows open reads, and a peer is not
// used for sending until its first clean sync.

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Row, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { CortextAuthConfig } from '../src/config.js';
import { createRelayRuntime, type RelayRuntime } from '../src/relay/runtime.js';
import { syncPeer, syncPeers, warnOwnOpenReads } from '../src/relay/sync.js';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'cortext';
const MAIL_DOMAIN = 'substrate.example.org';
const LOCAL = 'agent-a@host-a.example';
const REMOTE = 'agent-b@host-b.example';
const NEIGHBOUR = 'agent-c@host-b.example';
const PEER_DOMAIN = 'peer.example.net';
const ORIGIN = 'https://peer.example.net';
// A second peer and one of its agents, whose rows the first peer's sync must leave alone.
const OTHER = 'agent-e@host-e.example';
const PEER_TWO_DOMAIN = 'peer-two.example.net';
const ORIGIN_TWO = 'https://peer-two.example.net';
const OUT_KID = 'relay-out@substrate.example.org';
const INFO = 'cortext-relay/Info';
const DIRECTORY = 'cortext-relay/Directory';
const MAILBOX = 'cortext/AgentMessage';
const NOW = new Date('2026-11-27T12:00:00.000Z');
const OPEN_READS = 'peer answers mail reads without a key';
const OTHER_VERSION = 'peer speaks another version of the relay protocol';
const OTHER_DOMAIN = 'peer reports another mail domain';
const OPEN: CortextAuthConfig = { reads: 'open', writes: 'open', deletes: 'identity' };
const GATED: CortextAuthConfig = { reads: 'identity', writes: 'identity', deletes: 'identity' };

/** What a scripted peer answers. */
interface Peer {
  info: unknown;
  directory: unknown[];
  openReads: boolean;
  down: boolean;
}
interface Call {
  url: string;
  key: string;
  signed: boolean;
}

const json = (env: unknown, status = 200): Response =>
  new Response(JSON.stringify(env), { status, headers: { 'content-type': 'application/json' } });
const refused = (status: number): Response =>
  json({ data: {}, errors: [{ code: 'forbidden', message: 'a key is required' }] }, status);
const text = (res: SubstrateResponse): string => {
  const b = res.body;
  if (b === undefined || typeof b === 'string') return b ?? '';
  return b instanceof Uint8Array ? Buffer.from(b).toString('utf8') : '';
};
const scripted = (domain: string): Peer => ({
  info: { id: 'info', v: 1, domain, mailNamespace: NS },
  directory: [],
  openReads: false,
  down: false
});
/** Info and Directory for a signed caller; the mailbox for an unsigned one only if reads are open. */
function answer(peer: Peer, key: string, signed: boolean): Response {
  if (key === INFO || key === DIRECTORY) {
    if (!signed) return refused(401);
    return json({ data: { [key]: key === INFO ? [peer.info] : peer.directory } });
  }
  return !signed && peer.openReads ? json({ data: { [key]: [] } }) : refused(403);
}

const cleanup: Array<() => Promise<void> | void> = [];
let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  warn.mockRestore();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const warnings = (): string[] => warn.mock.calls.map((c) => String(c[0]));

/** A server with one local agent and two peers, each answering as its `Peer` script says. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cortext-sync-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const keyPath = join(dir, 'relay.key');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const peers: Record<string, Peer> = {
    [ORIGIN]: scripted(PEER_DOMAIN),
    [ORIGIN_TWO]: scripted(PEER_TWO_DOMAIN)
  };
  const calls: Call[] = [];
  const h = {
    respond: (
      url: string,
      _init: RequestInit,
      key: string,
      signed: boolean
    ): Response | Promise<Response> => {
      const peer = peers[new URL(url).origin];
      if (peer === undefined || peer.down) throw new TypeError('fetch failed');
      return answer(peer, key, signed);
    }
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const key = Object.keys(JSON.parse(String(init.body)))[0] ?? '';
    const signed = (init.headers as Record<string, string>).authorization !== undefined;
    calls.push({ url, key, signed });
    return h.respond(url, init, key, signed);
  }) as unknown as typeof fetch;

  const plugin = buildClaudeForTest(
    { namespace: NS, mailDomain: MAIL_DOMAIN },
    { relay: { fetchImpl, now: () => NOW } }
  );
  const { onCommittedWrites: _hook, ...withoutHook } = plugin;
  const server = new MemorySubstrateServer();
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: {
      [NS]: new MemoryDataset({ namespace: NS }),
      architecture: new MemoryDataset({ namespace: 'architecture' }),
      'cortext-relay': new MemoryDataset({ namespace: 'cortext-relay' })
    },
    coordinators: [withoutHook],
    auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' }
  });
  await server.start();
  cleanup.push(() => composed.stop());

  const ds = composed.engine.datasetFor(NS);
  if (ds === undefined) throw new Error(`no dataset for ${NS}`);
  const peerRow = (id: string, domain: string, origin: string) => ({
    id,
    domain,
    origin,
    inboundKid: `relay-in@${domain}`,
    outboundKid: OUT_KID,
    outboundKeyPath: keyPath,
    active: true
  });
  await ds.write('MailPeer', [
    peerRow('peer', PEER_DOMAIN, ORIGIN),
    peerRow('peer-two', PEER_TWO_DOMAIN, ORIGIN_TWO)
  ]);
  await ds.write('AgentIdentity', [
    { id: 'local', kid: LOCAL, host: 'host-a.example', active: true },
    { id: 'other', kid: OTHER, host: '', domain: PEER_TWO_DOMAIN, active: true }
  ]);

  const metrics: Array<{ name: string; payload: unknown }> = [];
  const rt: RelayRuntime = createRelayRuntime(
    { namespace: NS, mailDomain: MAIL_DOMAIN },
    {
      engine: composed.engine,
      edges: composed.edges,
      fetchImpl,
      now: () => NOW,
      metric: (name, payload) => metrics.push({ name, payload })
    }
  );
  const peerOf = async (id: string): Promise<Row> => {
    const row = (await ds.read('MailPeer', { id })).rows[0];
    if (row === undefined) throw new Error(`no MailPeer ${id}`);
    return { ...row };
  };
  const identity = async (kid: string): Promise<Row | undefined> =>
    (await ds.read('AgentIdentity', { where: { kid: { eq: kid } }, limit: 1 })).rows[0];
  const identities = async (): Promise<Row[]> =>
    (await ds.read('AgentIdentity', { limit: 1000 })).rows;
  /** One mutate frame through the server, signed as `sub`. */
  const mutate = async (key: string, params: Record<string, unknown>, sub: string) => {
    const token = signHs256(
      { sub, exp: Math.floor(Date.now() / 1000) + 3600, capabilities: ['read', 'mutate'] },
      'test-secret',
      { kid: 'test' }
    );
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: Buffer.from(JSON.stringify({ [key]: { params, fields: { id: true } } }))
    });
    return JSON.parse(text(res)) as { errors?: Array<{ code: string; message: string }> };
  };
  return {
    ds,
    rt,
    composed,
    keyPath,
    publicKey,
    peer: peers[ORIGIN] as Peer,
    peerTwo: peers[ORIGIN_TWO] as Peer,
    calls,
    metrics,
    h,
    peerOf,
    identity,
    identities,
    sync: async () => syncPeer(rt, await peerOf('peer')),
    /** A local agent's send. */
    send: (params: Record<string, unknown>) => mutate(`${NS}/sendAgentMessage`, params, LOCAL),
    /** The first peer's delivery of one message to LOCAL. */
    deliver: (messageId: string, from: string) =>
      mutate(
        'cortext-relay/deliver',
        { v: 1, messageId, from, to: LOCAL, subject: 'hello', body: 'b' },
        `relay-in@${PEER_DOMAIN}`
      )
  };
}

describe('syncPeer', () => {
  it('creates remote rows with domain, displayName, project and description', async () => {
    const { peer, sync, identity, calls } = await setup();
    peer.directory = [
      {
        id: 'b',
        kid: REMOTE,
        displayName: 'Agent B',
        project: 'substrate',
        description: 'maintains the server'
      },
      { id: 'c', kid: NEIGHBOUR, displayName: null, project: null, description: null }
    ];
    expect(await sync()).toEqual({
      upserted: 2,
      unlisted: 0,
      collisions: [],
      skipped: 0,
      blocked: null,
      changed: false
    });
    expect(await identity(REMOTE)).toMatchObject({
      kid: REMOTE,
      host: '',
      domain: PEER_DOMAIN,
      active: true,
      displayName: 'Agent B',
      project: 'substrate',
      description: 'maintains the server',
      _metadata: expect.objectContaining({ createdBy: { kind: 'system', id: 'cortext:relay' } })
    });
    expect(await identity(NEIGHBOUR)).toMatchObject({ domain: PEER_DOMAIN, active: true });
    // Info and Directory are signed; the mailbox read is not.
    expect(calls).toEqual([
      { url: `${ORIGIN}/substrate/v1/query`, key: INFO, signed: true },
      { url: `${ORIGIN}/substrate/v1/query`, key: MAILBOX, signed: false },
      { url: `${ORIGIN}/substrate/v1/query`, key: DIRECTORY, signed: true }
    ]);
  });

  it('updates description when the peer changes it', async () => {
    const { peer, sync, identity } = await setup();
    peer.directory = [{ kid: REMOTE, displayName: 'Agent B', description: 'maintains the server' }];
    await sync();
    peer.directory = [{ kid: REMOTE, displayName: 'Agent B', description: 'maintains the TUI' }];
    expect((await sync()).upserted).toBe(1);
    expect(await identity(REMOTE)).toMatchObject({
      displayName: 'Agent B',
      description: 'maintains the TUI'
    });
    // A field the peer stops sending is cleared.
    peer.directory = [{ kid: REMOTE, displayName: 'Agent B' }];
    await sync();
    expect((await identity(REMOTE))?.description ?? null).toBeNull();
  });

  it('unlists a remote row the peer no longer lists, leaving it active', async () => {
    const { peer, sync, identity } = await setup();
    peer.directory = [{ kid: REMOTE }, { kid: NEIGHBOUR }];
    await sync();
    peer.directory = [{ kid: REMOTE }];
    expect(await sync()).toMatchObject({ upserted: 1, unlisted: 1 });
    expect(await identity(NEIGHBOUR)).toMatchObject({ active: true, listed: false });
    expect(await identity(REMOTE)).toMatchObject({ active: true, listed: true });
    // Only this peer's rows: a local row and another peer's row are left alone.
    expect(await identity(LOCAL)).toMatchObject({ active: true });
    expect((await identity(LOCAL))?.domain ?? null).toBeNull();
    expect((await identity(LOCAL))?.listed).not.toBe(false);
    expect(await identity(OTHER)).toMatchObject({ active: true, domain: PEER_TWO_DOMAIN });
    expect((await identity(OTHER))?.listed).not.toBe(false);
    // Listed again, it is listed again.
    peer.directory = [{ kid: REMOTE }, { kid: NEIGHBOUR }];
    expect(await sync()).toMatchObject({ upserted: 2, unlisted: 0 });
    expect(await identity(NEIGHBOUR)).toMatchObject({ active: true, listed: true });
  });

  it('never changes whether an existing row is active', async () => {
    const { peer, sync, identity, ds } = await setup();
    await ds.write('AgentIdentity', [
      { id: 'asleep', kid: NEIGHBOUR, host: '', domain: PEER_DOMAIN, active: false }
    ]);
    peer.directory = [{ kid: NEIGHBOUR, description: 'back' }];
    await sync();
    expect(await identity(NEIGHBOUR)).toMatchObject({ active: false, description: 'back' });
  });

  it('keeps a row made by first-contact delivery active, and answerable, when the peer does not list it', async () => {
    const { peer, sync, identity, deliver, send } = await setup();
    const hidden = 'hidden@host-b.example';
    expect((await deliver('m-1', hidden)).errors).toBeUndefined();
    expect(await identity(hidden)).toMatchObject({ domain: PEER_DOMAIN, active: true });
    peer.directory = [{ kid: REMOTE }];
    expect(await sync()).toMatchObject({ upserted: 1, unlisted: 1 });
    expect(await identity(hidden)).toMatchObject({ active: true, listed: false });
    expect((await send({ to: hidden, subject: 're: hello', body: 'b' })).errors).toBeUndefined();
  });

  it('refuses a send to a peer until its first clean sync', async () => {
    const { peer, sync, ds, send } = await setup();
    await ds.write('AgentIdentity', [
      { id: 'remote', kid: REMOTE, host: '', domain: PEER_DOMAIN, active: true }
    ]);
    const mail = { to: REMOTE, subject: 's', body: 'b' };
    const unchecked = (await send(mail)).errors?.[0];
    expect(unchecked?.code).toBe('relay_unavailable');
    expect(unchecked?.message).toContain(`the mail peer for ${PEER_DOMAIN} is not checked yet`);
    // A sync that blocks the peer does not make it usable.
    peer.openReads = true;
    await sync();
    expect((await send(mail)).errors?.[0]?.message).toContain('is blocked');
    peer.openReads = false;
    peer.directory = [{ kid: REMOTE }];
    expect((await sync()).blocked).toBeNull();
    expect((await send(mail)).errors).toBeUndefined();
  });

  it.each([
    ['switched off', { active: false }, false],
    ['blocked by an operator', { blockedReason: 'abuse report' }, false],
    ['switched off, as its open reads are found', { active: false }, true],
    ['blocked by an operator, as its open reads are found', { blockedReason: 'abuse report' }, true]
  ])('writes nothing when the peer is %s during the sync', async (_case, patch, openReads) => {
    const { peer, sync, h, ds, peerOf, identity, metrics } = await setup();
    peer.openReads = openReads;
    peer.directory = [{ kid: REMOTE }];
    const scripted = h.respond;
    h.respond = async (url, init, key, signed) => {
      if (key === MAILBOX) await ds.write('MailPeer', [{ id: 'peer', ...patch }]);
      return scripted(url, init, key, signed);
    };
    expect(await sync()).toMatchObject({ changed: true, blocked: null, upserted: 0 });
    // The operator's change stands, and sync added nothing to it.
    const row = await peerOf('peer');
    expect({ active: row.active, blockedReason: row.blockedReason ?? null }).toEqual({
      active: true,
      blockedReason: null,
      ...patch
    });
    expect(row.lastSyncAt ?? null).toBeNull();
    expect(await identity(REMOTE)).toBeUndefined();
    expect(metrics).toEqual([
      { name: 'cortext.mail_peer_changed_during_sync', payload: { domain: PEER_DOMAIN } }
    ]);
  });

  it('skips and reports a kid that collides with a local agent', async () => {
    const { peer, sync, identity, metrics } = await setup();
    peer.directory = [
      { kid: LOCAL, displayName: 'impostor' },
      { kid: OTHER, displayName: 'impostor' },
      { kid: REMOTE }
    ];
    expect(await sync()).toEqual({
      upserted: 1,
      unlisted: 0,
      collisions: [LOCAL, OTHER],
      skipped: 0,
      blocked: null,
      changed: false
    });
    expect(await identity(REMOTE)).toMatchObject({ domain: PEER_DOMAIN });
    // Never merged: each holder keeps its row as it was.
    expect((await identity(LOCAL))?.domain ?? null).toBeNull();
    expect((await identity(LOCAL))?.displayName ?? null).toBeNull();
    expect(await identity(OTHER)).toMatchObject({ domain: PEER_TWO_DOMAIN });
    expect((await identity(OTHER))?.displayName ?? null).toBeNull();
    expect(metrics).toEqual([
      {
        name: 'cortext.mail_peer_kid_collision',
        payload: { domain: PEER_DOMAIN, kid: LOCAL, holder: null, claimant: PEER_DOMAIN }
      },
      {
        name: 'cortext.mail_peer_kid_collision',
        payload: { domain: PEER_DOMAIN, kid: OTHER, holder: PEER_TWO_DOMAIN, claimant: PEER_DOMAIN }
      }
    ]);
    const [first, second] = warnings();
    expect(first).toContain(LOCAL);
    expect(first).toContain('a local identity');
    expect(first).toContain(PEER_DOMAIN);
    expect(second).toContain(OTHER);
    expect(second).toContain(PEER_TWO_DOMAIN);
    expect(second).toContain(PEER_DOMAIN);
  });

  it('blocks a peer whose unsigned mail read is answered', async () => {
    const { peer, sync, peerOf, calls, metrics, identity } = await setup();
    peer.openReads = true;
    peer.directory = [{ kid: REMOTE }];
    expect(await sync()).toMatchObject({ blocked: OPEN_READS, upserted: 0 });
    expect(await peerOf('peer')).toMatchObject({ blockedReason: OPEN_READS, active: true });
    expect((await peerOf('peer')).lastSyncAt ?? null).toBeNull();
    expect(calls.map((c) => c.key)).toEqual([INFO, MAILBOX]);
    expect(await identity(REMOTE)).toBeUndefined();
    expect(metrics).toEqual([
      { name: 'cortext.mail_peer_blocked', payload: { domain: PEER_DOMAIN, reason: OPEN_READS } }
    ]);
    expect(warnings()).toEqual([
      `cortext relay: mail peer ${PEER_DOMAIN} is blocked: ${OPEN_READS}`
    ]);
  });

  it('does not block when allowOpenReads is true', async () => {
    const { peer, sync, peerOf, ds, identity } = await setup();
    peer.openReads = true;
    peer.directory = [{ kid: REMOTE }];
    await ds.write('MailPeer', [{ id: 'peer', allowOpenReads: true }]);
    expect(await sync()).toMatchObject({ blocked: null, upserted: 1 });
    expect((await peerOf('peer')).blockedReason ?? null).toBeNull();
    expect(await identity(REMOTE)).toMatchObject({ domain: PEER_DOMAIN });
  });

  it('blocks a peer whose Info names another domain', async () => {
    const { peer, sync, peerOf, calls } = await setup();
    peer.info = { id: 'info', v: 1, domain: PEER_TWO_DOMAIN, mailNamespace: NS };
    expect((await sync()).blocked).toBe(OTHER_DOMAIN);
    expect((await peerOf('peer')).blockedReason).toBe(OTHER_DOMAIN);
    expect(calls.map((c) => c.key)).toEqual([INFO]);
  });

  it('blocks a peer on protocol version 2', async () => {
    const { peer, sync, peerOf, calls } = await setup();
    peer.info = { id: 'info', v: 2, domain: PEER_DOMAIN, mailNamespace: NS };
    expect((await sync()).blocked).toBe(OTHER_VERSION);
    expect((await peerOf('peer')).blockedReason).toBe(OTHER_VERSION);
    expect(calls.map((c) => c.key)).toEqual([INFO]);
  });

  it('clears blockedReason after a clean sync', async () => {
    const { peer, sync, peerOf } = await setup();
    peer.openReads = true;
    await sync();
    expect((await peerOf('peer')).blockedReason).toBe(OPEN_READS);
    peer.openReads = false;
    expect((await sync()).blocked).toBeNull();
    const row = await peerOf('peer');
    expect(row.blockedReason ?? null).toBeNull();
    expect(Date.parse(String(row.lastSyncAt))).toBe(NOW.getTime());
  });

  it("keeps a reason this server did not write, such as an operator's", async () => {
    const { peer, sync, peerOf, ds } = await setup();
    await ds.write('MailPeer', [{ id: 'peer', blockedReason: 'abuse report' }]);
    expect((await sync()).blocked).toBeNull();
    expect(await peerOf('peer')).toMatchObject({ blockedReason: 'abuse report' });
    peer.openReads = true;
    expect((await sync()).blocked).toBe(OPEN_READS);
    expect(await peerOf('peer')).toMatchObject({ blockedReason: 'abuse report' });
  });

  it('skips and counts a malformed kid', async () => {
    const { peer, sync, identities, metrics } = await setup();
    const bidi = 'agent‮b@host-b.example';
    peer.directory = [
      { kid: 42 },
      { kid: 'no-at-sign' },
      { kid: 'two@at@signs' },
      { kid: 'white space@host-b.example' },
      { kid: bidi },
      { kid: `${'x'.repeat(250)}@host-b.example` },
      'not a row',
      null,
      { displayName: 'no kid' },
      { kid: REMOTE }
    ];
    expect(await sync()).toMatchObject({ upserted: 1, skipped: 9, collisions: [] });
    const kids = (await identities()).map((r) => r.kid);
    expect(kids.sort()).toEqual([LOCAL, REMOTE, OTHER].sort());
    expect(metrics).toEqual([
      { name: 'cortext.mail_peer_entries_skipped', payload: { domain: PEER_DOMAIN, skipped: 9 } }
    ]);
    expect(warnings().join('\n')).not.toContain('‮');
  });

  it('skips a kid naming a host of this server, in any case', async () => {
    const { peer, sync, identity } = await setup();
    peer.directory = [{ kid: 'intruder@HOST-A.example' }, { kid: REMOTE }];
    expect(await sync()).toMatchObject({ upserted: 1, skipped: 1, collisions: [] });
    expect(await identity('intruder@HOST-A.example')).toBeUndefined();
  });

  it('strips control and format characters and caps displayName, project and description', async () => {
    const { peer, sync, identity } = await setup();
    peer.directory = [
      {
        kid: REMOTE,
        displayName: `A\u0007gent​ B‮${'n'.repeat(300)}`,
        project: `p\n${'p'.repeat(250)}`,
        description: 'd⁦'.repeat(1500)
      },
      { kid: NEIGHBOUR, displayName: 42, project: { name: 'x' }, description: ['x'] }
    ];
    expect((await sync()).upserted).toBe(2);
    const row = await identity(REMOTE);
    expect(row?.displayName).toBe(`Agent B${'n'.repeat(193)}`);
    expect(row?.project).toBe('p'.repeat(200));
    expect(row?.description).toBe('d'.repeat(1000));
    const other = await identity(NEIGHBOUR);
    expect(other?.displayName ?? null).toBeNull();
    expect(other?.project ?? null).toBeNull();
    expect(other?.description ?? null).toBeNull();
  });

  it.each([
    ['more than 1,000 entries', (n: number) => ({ data: { [DIRECTORY]: rows(n + 1) } })],
    [
      'a page with more to come',
      (n: number) => ({
        data: { [DIRECTORY]: rows(n) },
        _pagination: { [DIRECTORY]: { hasMore: true, nextCursor: 'c' } }
      })
    ]
  ])('fails, writing nothing, when the directory has %s', async (_case, envelope) => {
    const { sync, h, identities, peerOf } = await setup();
    const scripted = h.respond;
    h.respond = (url, init, key, signed) =>
      key === DIRECTORY ? json(envelope(1000)) : scripted(url, init, key, signed);
    await expect(sync()).rejects.toThrow("the peer's directory has more than 1000 entries");
    expect(await identities()).toHaveLength(2);
    const row = await peerOf('peer');
    expect(row.blockedReason ?? null).toBeNull();
    expect(row.lastSyncAt ?? null).toBeNull();
  });

  it.each([
    ['an error message', { data: {}, errors: [{ code: 'peer-written', message: 'peer-written' }] }],
    ['a non-row Info', { data: { [INFO]: ['peer-written'] } }],
    ['a version string', { data: { [INFO]: [{ v: 'peer-written', domain: PEER_DOMAIN }] } }],
    ['a domain', { data: { [INFO]: [{ v: 1, domain: 'peer-written.example' }] } }]
  ])('keeps a peer-written %s out of blockedReason and the warnings', async (_case, envelope) => {
    const { rt, h, peerOf, metrics } = await setup();
    h.respond = () => json(envelope);
    await syncPeers(rt);
    const reason = (await peerOf('peer')).blockedReason ?? null;
    expect([null, OPEN_READS, OTHER_VERSION, OTHER_DOMAIN]).toContain(reason);
    expect(metrics.length).toBeGreaterThan(0);
    expect(JSON.stringify([await peerOf('peer'), metrics, warnings()])).not.toContain(
      'peer-written'
    );
  });
});

describe('syncPeers', () => {
  it('keeps syncing other peers when one is unreachable', async () => {
    const { rt, peer, peerTwo, identity, peerOf, metrics } = await setup();
    peer.down = true;
    peerTwo.directory = [{ kid: 'agent-f@host-f.example' }];
    await syncPeers(rt);
    expect(await identity('agent-f@host-f.example')).toMatchObject({
      domain: PEER_TWO_DOMAIN,
      active: true
    });
    expect(Date.parse(String((await peerOf('peer-two')).lastSyncAt))).toBe(NOW.getTime());
    // The unreachable peer is reported, not blocked.
    const unreachable = await peerOf('peer');
    expect(unreachable.blockedReason ?? null).toBeNull();
    expect(unreachable.lastSyncAt ?? null).toBeNull();
    expect(metrics).toEqual([
      {
        name: 'cortext.mail_peer_sync_failed',
        payload: { domain: PEER_DOMAIN, reason: 'no answer (network)' }
      }
    ]);
    expect(warnings()).toEqual([
      `cortext relay: directory sync with ${PEER_DOMAIN} failed: no answer (network)`
    ]);
  });

  it('syncs active peers only', async () => {
    const { rt, ds, calls } = await setup();
    await ds.write('MailPeer', [{ id: 'peer', active: false }]);
    await syncPeers(rt);
    expect(calls.some((c) => c.url.startsWith(`${ORIGIN}/`))).toBe(false);
    expect(calls.some((c) => c.url.startsWith(ORIGIN_TWO))).toBe(true);
  });

  it('leaves no key path in any row when the key cannot be used', async () => {
    const { rt, ds, keyPath, calls, metrics, peerOf, identities } = await setup();
    const missing = join(keyPath, '..', 'missing.key');
    await ds.write('MailPeer', [{ id: 'peer', outboundKeyPath: missing }]);
    await syncPeers(rt);
    expect(calls.some((c) => c.url.startsWith(`${ORIGIN}/`))).toBe(false);
    expect(warnings()).toContainEqual(expect.stringContaining(missing));
    expect(metrics).toContainEqual({
      name: 'cortext.mail_peer_sync_failed',
      payload: { domain: PEER_DOMAIN, reason: expect.stringContaining(missing) }
    });
    const row = await peerOf('peer');
    const { outboundKeyPath: _path, ...rest } = row;
    expect(JSON.stringify([rest, await peerOf('peer-two'), await identities()])).not.toContain(
      missing
    );
    expect(row.blockedReason ?? null).toBeNull();
  });

  it.each([
    ['syncs a peer that runs this plugin', GATED, null, 1],
    ['blocks a peer that runs this plugin with open reads', undefined, OPEN_READS, 0]
  ])('%s', async (_case, auth, blocked, upserted) => {
    const local = await setup();
    // The peer knows this server's relay key and lists one of its two agents.
    const system = new MemoryDataset({ namespace: '_system' });
    await system.write('Key', [
      {
        id: 'k-relay',
        kid: OUT_KID,
        algorithm: 'EdDSA',
        publicKey: local.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        namespaces: 'cortext-relay',
        capabilities: 'read,mutate',
        revokedAt: null
      }
    ]);
    const server = new MemorySubstrateServer();
    const remote = await compose({
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      datasets: {
        _system: system,
        [NS]: new MemoryDataset({ namespace: NS }),
        architecture: new MemoryDataset({ namespace: 'architecture' }),
        'cortext-relay': new MemoryDataset({ namespace: 'cortext-relay' })
      },
      coordinators: [buildClaudeForTest({ namespace: NS, mailDomain: PEER_DOMAIN, auth })],
      auth: { keys: [], mode: 'attribute' }
    });
    await server.start();
    cleanup.push(() => remote.stop());
    const rds = remote.engine.datasetFor(NS);
    if (rds === undefined) throw new Error('no peer dataset');
    await rds.write('MailPeer', [
      {
        id: 'back',
        domain: MAIL_DOMAIN,
        origin: 'https://substrate.example.org',
        inboundKid: OUT_KID,
        outboundKid: 'relay-out@peer.example.net',
        outboundKeyPath: '/etc/substrate/keys/relay.key',
        active: true
      }
    ]);
    await rds.write('AgentIdentity', [
      {
        id: 'b',
        kid: REMOTE,
        host: 'host-b.example',
        active: true,
        project: 'substrate',
        description: 'maintains the server'
      },
      { id: 'hidden', kid: NEIGHBOUR, host: 'host-b.example', active: true, listed: false }
    ]);
    local.h.respond = async (url, init) => {
      const res = await server.inject({
        method: 'POST',
        path: new URL(url).pathname,
        headers: init.headers as Record<string, string>,
        body: Buffer.from(String(init.body))
      });
      return new Response(text(res), { status: res.status });
    };
    expect(await local.sync()).toEqual({
      upserted,
      unlisted: 0,
      collisions: [],
      skipped: 0,
      blocked,
      changed: false
    });
    expect(await local.identity(NEIGHBOUR)).toBeUndefined();
    if (blocked !== null) return;
    expect(await local.identity(REMOTE)).toMatchObject({
      domain: PEER_DOMAIN,
      project: 'substrate',
      description: 'maintains the server'
    });
  });
});

describe('warnOwnOpenReads', () => {
  it('warns at start when own reads are open and a peer exists', async () => {
    const { rt, ds } = await setup();
    const seen: string[] = [];
    expect(await warnOwnOpenReads(rt, OPEN, (m) => seen.push(m))).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('readable without a key');
    // Silent when reads need a key, or when there is no peer.
    expect(await warnOwnOpenReads(rt, GATED, (m) => seen.push(m))).toBe(false);
    await ds.tombstone('MailPeer', ['peer', 'peer-two']);
    expect(await warnOwnOpenReads(rt, OPEN, (m) => seen.push(m))).toBe(false);
    expect(seen).toHaveLength(1);
  });
});

describe('sync wiring', () => {
  it('registers a 15-minute sync that runs at start, only with mailDomain', () => {
    const off = buildClaudeForTest({ namespace: NS });
    expect((off.schedule ?? []).map((t) => t.name)).not.toContain(`${NS}-mail-sync`);
    const on = buildClaudeForTest({ namespace: NS, mailDomain: MAIL_DOMAIN });
    expect(on.schedule?.find((t) => t.name === `${NS}-mail-sync`)).toMatchObject({
      intervalMs: 15 * 60_000,
      runOnStart: true
    });
  });

  it.each([
    ['warns at start', MAIL_DOMAIN, undefined, 1],
    ['stays silent at start when reads need a key', MAIL_DOMAIN, GATED, 0],
    ['stays silent at start without mailDomain', undefined, undefined, 0]
  ])('%s with a peer on record', async (_case, mailDomain, auth, expected) => {
    const store = new MemoryDataset({ namespace: NS });
    await store.write('MailPeer', [
      {
        id: 'peer',
        domain: PEER_DOMAIN,
        origin: ORIGIN,
        inboundKid: 'relay-in@peer.example.net',
        outboundKid: OUT_KID,
        outboundKeyPath: '/etc/substrate/keys/relay.key',
        active: true
      }
    ]);
    const composed = await compose({
      server: new MemorySubstrateServer(),
      dataset: new MemoryDataset({ namespace: 'default' }),
      datasets: {
        [NS]: store,
        architecture: new MemoryDataset({ namespace: 'architecture' }),
        'cortext-relay': new MemoryDataset({ namespace: 'cortext-relay' })
      },
      coordinators: [buildClaudeForTest({ namespace: NS, mailDomain, auth })],
      systemActor: 'test'
    });
    cleanup.push(() => composed.stop());
    expect(warnings().filter((w) => w.includes('readable without a key'))).toHaveLength(expected);
  });

  it('the scheduled task syncs through the plugin', async () => {
    const { composed, peer, identity } = await setup();
    peer.directory = [{ kid: REMOTE }];
    await composed.scheduler?.runNow('cortext', `${NS}-mail-sync`);
    expect(await identity(REMOTE)).toMatchObject({ domain: PEER_DOMAIN, active: true });
  });
});

function rows(n: number): Array<{ kid: string }> {
  return Array.from({ length: n }, (_, i) => ({ kid: `agent-${i}@host-b.example` }));
}
