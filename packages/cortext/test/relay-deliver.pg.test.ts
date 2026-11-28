/**
 * `deliver` on Postgres: the unique index on `(viaDomain, remoteId)` is what stores a message
 * once when the same delivery arrives several times at once. Runs in a schema of its own,
 * rebuilt each run.
 */

import type { RequestContext } from '@mnmal-ai/substrate/sdk';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORTEXT_NAMESPACE } from '../src/kernel/cortext-namespace.js';
import { buildClaudeForTest } from './_helpers.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PACKAGE = 'cortext-relay-deliver';
const PEER = 'relay-peer@peer.example.net';

async function openStore(url: string): Promise<ReturnType<typeof postgres>> {
  await recreatePgTestSchema(url, pgTestSchemaName(PACKAGE));
  // Each deliver holds its relay frame's transaction connection while it writes through the pool,
  // so ten at once need more than the driver's default ten connections.
  const sql = postgres(pgTestSchemaUrl(url, PACKAGE), { onnotice: () => {}, max: 20 });
  await runMigrations(sql);
  return sql;
}

const store = POSTGRES_URL ? await openStore(POSTGRES_URL) : undefined;

describe.skipIf(store === undefined)('cortext-relay/deliver on Postgres', () => {
  const sql = store as ReturnType<typeof postgres>;
  let composed: Awaited<ReturnType<typeof compose>>;

  beforeAll(async () => {
    const coordinator = buildClaudeForTest({
      namespace: CORTEXT_NAMESPACE,
      mailDomain: 'substrate.example.org'
    });
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

  it('stores one row for ten concurrent deliveries of one message', async () => {
    // The engine's grant gate reads the grant from the identity, as the HTTP route sets it.
    const ctx = {
      identity: { kind: 'agent', id: PEER, grants: { 'cortext-relay': ['read', 'mutate'] } }
    } as Partial<RequestContext> as RequestContext;
    const frame = {
      'cortext-relay/deliver': {
        params: {
          v: 1,
          messageId: '0196a0b2-0000-7000-8000-000000000001',
          from: 'agent-b@host-b.example',
          to: 'agent-a@host-a.example',
          subject: 'hello',
          body: 'once'
        },
        fields: { id: true, shortId: true, duplicate: true }
      }
    };
    const envelopes = await Promise.all(
      Array.from({ length: 10 }, () => composed.engine.mutate({ frame, ctx }))
    );
    expect(envelopes.flatMap((e) => e.errors ?? [])).toEqual([]);
    const results = envelopes.map(
      (e) => e.data['cortext-relay/deliver'] as { id: string; duplicate: boolean }
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const ds = composed.engine.datasetFor(CORTEXT_NAMESPACE);
    const { rows } = (await ds?.read('AgentMessage', {
      where: { viaDomain: { eq: 'peer.example.net' } }
    })) ?? { rows: [] };
    expect(rows).toHaveLength(1);
    const senders = await ds?.read('AgentIdentity', {
      where: { kid: { eq: 'agent-b@host-b.example' } }
    });
    expect(senders?.rows).toHaveLength(1);
  });
});
