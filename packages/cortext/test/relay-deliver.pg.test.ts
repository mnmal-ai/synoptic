/**
 * `deliver` on Postgres, with the driver's default pool and more concurrent deliveries than it
 * has connections: each delivery works on its frame's one connection, concurrent repeats store
 * once, a failed delivery leaves nothing behind, and an upsert outside any frame works alongside
 * deliveries. Runs in a schema of its own, rebuilt each run.
 */

import type { RequestContext } from '@mnmal-ai/substrate/sdk';
import { ResolverFrameError } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemorySubstrateServer,
  PgDataset,
  PgEdgesStore,
  pgTestSchemaName,
  pgTestSchemaUrl,
  recreatePgTestSchema,
  runMigrations
} from '@mnmal-ai/substrate/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORTEXT_NAMESPACE } from '../src/kernel/cortext-namespace.js';
import { upsertRemoteIdentity } from '../src/relay/deliver.js';
import { createRelayRuntime, type RelayRuntime } from '../src/relay/runtime.js';
import { buildClaudeForTest } from './_helpers.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PACKAGE = 'cortext-relay-deliver';
const PEER = 'relay-peer@peer.example.net';

async function openStore(url: string): Promise<ReturnType<typeof postgres>> {
  await recreatePgTestSchema(url, pgTestSchemaName(PACKAGE));
  const sql = postgres(pgTestSchemaUrl(url, PACKAGE), { onnotice: () => {} });
  await runMigrations(sql);
  return sql;
}

const store = POSTGRES_URL ? await openStore(POSTGRES_URL) : undefined;

describe.skipIf(store === undefined)('cortext-relay/deliver on Postgres', () => {
  const sql = store as ReturnType<typeof postgres>;
  let composed: Awaited<ReturnType<typeof compose>>;
  let rt: RelayRuntime;
  // Each test starts a fresh rate window, so the suite's deliveries never reach the limit.
  let clock = Date.now();
  beforeEach(() => {
    clock += 61_000;
  });

  beforeAll(async () => {
    const cfg = { namespace: CORTEXT_NAMESPACE, mailDomain: 'substrate.example.org' };
    const coordinator = buildClaudeForTest(cfg, { relay: { now: () => new Date(clock) } });
    const types = coordinator.namespaces?.[0]?.types ?? {};
    const edgesStore = new PgEdgesStore({ sql });
    composed = await compose({
      server: new MemorySubstrateServer(),
      dataset: new PgDataset({
        namespace: 'default',
        sql,
        edgesStore,
        typeDefLookup: (type, namespace) =>
          namespace === CORTEXT_NAMESPACE ? types[type] : undefined
      }),
      edges: edgesStore,
      coordinators: [coordinator],
      systemActor: 'test'
    });
    rt = createRelayRuntime(cfg, { engine: composed.engine, edges: edgesStore });
    const ds = composed.engine.datasetFor(CORTEXT_NAMESPACE);
    if (ds === undefined) throw new Error('no cortext dataset');
    const storage = { indexes: 'unique', newFields: 'column' } as const;
    for (const type of Object.keys(types)) await ds.ensureTypeStorage?.(type, storage);
    await ds.write('MailPeer', [
      {
        domain: 'peer.example.net',
        origin: 'https://peer.example.net:3100',
        inboundKid: PEER,
        outboundKid: 'relay-out@substrate.example.org',
        outboundKeyPath: '/etc/substrate/keys/relay.key',
        active: true
      }
    ]);
    await ds.write('AgentIdentity', [
      { kid: 'agent-a@host-a.example', host: 'host-a.example', active: true }
    ]);
  }, 120_000);

  afterAll(async () => {
    await composed?.stop();
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${pgTestSchemaName(PACKAGE)}" CASCADE`);
    await sql.end({ timeout: 5 });
  });

  // The engine's grant gate reads the grant from the identity, as the HTTP route sets it.
  const ctx = {
    identity: { kind: 'agent', id: PEER, grants: { 'cortext-relay': ['read', 'mutate'] } }
  } as Partial<RequestContext> as RequestContext;
  const deliver = (params: Record<string, unknown>) =>
    composed.engine.mutate({
      frame: {
        'cortext-relay/deliver': {
          params: { v: 1, to: 'agent-a@host-a.example', subject: 'hello', body: 'b', ...params },
          fields: { id: true, shortId: true, duplicate: true }
        }
      },
      ctx
    });
  const count = async (type: string, where: Record<string, unknown>) =>
    (await composed.engine.datasetFor(CORTEXT_NAMESPACE)?.read(type, { where }))?.rows.length;
  const MANY = 25;

  it(`stores one row for ${MANY} concurrent deliveries of one message`, async () => {
    const envelopes = await Promise.all(
      Array.from({ length: MANY }, () =>
        deliver({ messageId: 'same-message', from: 'agent-b@host-b.example' })
      )
    );
    expect(envelopes.flatMap((e) => e.errors ?? [])).toEqual([]);
    const results = envelopes.map(
      (e) => e.data['cortext-relay/deliver'] as { id: string; duplicate: boolean }
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await count('AgentMessage', { remoteId: { eq: 'same-message' } })).toBe(1);
    expect(await count('AgentIdentity', { kid: { eq: 'agent-b@host-b.example' } })).toBe(1);
  });

  it(`stores ${MANY} messages from one new sender delivered at once`, async () => {
    const from = 'agent-c@host-c.example';
    const envelopes = await Promise.all(
      Array.from({ length: MANY }, (_, i) => deliver({ messageId: `burst-${i}`, from }))
    );
    expect(envelopes.flatMap((e) => e.errors ?? [])).toEqual([]);
    expect(await count('AgentMessage', { remoteFrom: { eq: from } })).toBe(MANY);
    expect(await count('AgentIdentity', { kid: { eq: from } })).toBe(1);
  });

  it('leaves no sender row when the delivery fails after the sender upsert', async () => {
    const from = 'agent-d@host-d.example';
    const write = PgDataset.prototype.write;
    PgDataset.prototype.write = function (this: PgDataset, type, rows, options) {
      if (type === 'AgentMessage') {
        return Promise.reject(new ResolverFrameError('injected_failure', 'injected write failure'));
      }
      return write.call(this, type, rows, options);
    };
    try {
      const envelope = await deliver({ messageId: 'doomed', from });
      expect(envelope.errors?.[0]?.code).toBe('injected_failure');
    } finally {
      PgDataset.prototype.write = write;
    }
    expect(await count('AgentIdentity', { kid: { eq: from } })).toBe(0);
    expect(await count('AgentMessage', { remoteId: { eq: 'doomed' } })).toBe(0);
  });

  it('completes upserts outside any frame alongside deliveries from the same new sender', async () => {
    const from = 'agent-e@host-e.example';
    const deliveries: Array<ReturnType<typeof deliver>> = [];
    const upserts: Array<ReturnType<typeof upsertRemoteIdentity>> = [];
    // Upserts that each write, spread through the deliveries, so the kid's lock changes hands often.
    for (let i = 0; i < 30; i++) {
      if (i % 3 === 0) {
        const description = `upsert ${i}`;
        upserts.push(upsertRemoteIdentity(rt, 'peer.example.net', { kid: from, description }));
      }
      deliveries.push(deliver({ messageId: `mixed-${i}`, from }));
    }
    const [envelopes, rows] = await Promise.all([Promise.all(deliveries), Promise.all(upserts)]);
    expect(envelopes.flatMap((e) => e.errors ?? [])).toEqual([]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(await count('AgentIdentity', { kid: { eq: from } })).toBe(1);
    expect(await count('AgentMessage', { remoteFrom: { eq: from } })).toBe(30);
  });
});
