/**
 * The outbox on Postgres: the claim, the date filter and the outcome writes against real storage.
 * Two runtimes drain one store at once, as two processes would, and each message is sent once.
 * Runs in a schema of its own, rebuilt each run.
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { drainOutbox } from '../src/relay/outbox.js';
import { createRelayRuntime, type RelayRuntime } from '../src/relay/runtime.js';
import { buildClaudeForTest } from './_helpers.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PACKAGE = 'cortext-relay-outbox';
const SENDER = 'agent-a@host-a.example';
const REMOTE = 'agent-b@host-b.example';
const DELIVER = 'cortext-relay/deliver';

async function openStore(url: string): Promise<ReturnType<typeof postgres>> {
  await recreatePgTestSchema(url, pgTestSchemaName(PACKAGE));
  const sql = postgres(pgTestSchemaUrl(url, PACKAGE), { onnotice: () => {} });
  await runMigrations(sql);
  return sql;
}

const store = POSTGRES_URL ? await openStore(POSTGRES_URL) : undefined;

describe.skipIf(store === undefined)('the outbox on Postgres', () => {
  const sql = store as ReturnType<typeof postgres>;
  const dir = mkdtempSync(join(tmpdir(), 'cortext-outbox-pg-'));
  const keyPath = join(dir, 'relay.key');
  let composed: Awaited<ReturnType<typeof compose>>;
  let rt: RelayRuntime;
  let answer: (messageId: string) => unknown = () => ({});
  const sent: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const params = JSON.parse(String(init.body))[DELIVER].params as { messageId: string };
    sent.push(params.messageId);
    return new Response(JSON.stringify(answer(params.messageId)), { status: 200 });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const cfg = { namespace: CORTEXT_NAMESPACE, mailDomain: 'substrate.example.org' };
    // Without its post-commit hook, so each test drains when it chooses.
    const { onCommittedWrites: _hook, ...coordinator } = buildClaudeForTest(cfg, {
      relay: { fetchImpl }
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
    rt = createRelayRuntime(cfg, { engine: composed.engine, fetchImpl });
    const ds = composed.engine.datasetFor(CORTEXT_NAMESPACE);
    if (ds === undefined) throw new Error('no cortext dataset');
    const storage = { indexes: 'unique', newFields: 'column' } as const;
    for (const type of Object.keys(types)) await ds.ensureTypeStorage?.(type, storage);
    await ds.write('MailPeer', [
      {
        domain: 'peer.example.net',
        origin: 'https://peer.example.net',
        inboundKid: 'relay-in@peer.example.net',
        outboundKid: 'relay-out@substrate.example.org',
        outboundKeyPath: keyPath,
        active: true,
        // Checked by a directory sync, so mail may go to it.
        lastSyncAt: '2026-11-27T00:00:00.000Z'
      }
    ]);
    await ds.write('AgentIdentity', [
      { kid: SENDER, host: 'host-a.example', active: true },
      { kid: REMOTE, host: '', domain: 'peer.example.net', active: true }
    ]);
  }, 120_000);

  afterAll(async () => {
    await composed?.stop();
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${pgTestSchemaName(PACKAGE)}" CASCADE`);
    await sql.end({ timeout: 5 });
    rmSync(dir, { recursive: true, force: true });
  });

  const ctx = {
    identity: {
      agentKeyId: SENDER,
      id: SENDER,
      grants: { [CORTEXT_NAMESPACE]: ['read', 'mutate'] }
    },
    namespace: CORTEXT_NAMESPACE,
    operation: 'mutate',
    now: new Date(),
    headers: {},
    meta: {}
  } as Partial<RequestContext> as RequestContext;
  const send = async (subject: string): Promise<string> => {
    const env = await composed.engine.mutate({
      frame: {
        [`${CORTEXT_NAMESPACE}/sendAgentMessage`]: {
          params: { to: REMOTE, subject, body: 'b' },
          fields: { id: true }
        }
      },
      ctx: { ...ctx, now: new Date() }
    });
    expect(env.errors).toBeUndefined();
    return (env.data[`${CORTEXT_NAMESPACE}/sendAgentMessage`] as Array<{ id: string }>)[0]
      ?.id as string;
  };
  const message = async (id: string) =>
    (await composed.engine.datasetFor(CORTEXT_NAMESPACE)?.read('AgentMessage', { id }))?.rows[0];

  it('sends each message once when two runtimes drain at the same time', async () => {
    answer = () => ({ data: { [DELIVER]: { id: randomUUID(), shortId: 1, duplicate: false } } });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await send(`m${i}`));
    sent.length = 0;
    const results = await Promise.all([drainOutbox(rt), drainOutbox({ ...rt })]);
    expect(sent.sort()).toEqual([...ids].sort());
    expect(results.reduce((n, r) => n + r.delivered, 0)).toBe(10);
    for (const id of ids) {
      expect(await message(id)).toMatchObject({ delivery: 'delivered', deliveryAttempts: 1 });
    }
  });

  it('leaves a retried row until its time and bounces a refused one', async () => {
    const retried = await send('retry me');
    const refused = await send('refuse me');
    answer = (messageId) =>
      messageId === refused
        ? { data: {}, errors: [{ code: 'unknown_recipient', message: 'gone' }] }
        : { data: {}, errors: [{ code: 'rate_limited', message: 'later' }] };
    sent.length = 0;
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 1, failed: 1 });
    expect(await message(retried)).toMatchObject({ delivery: 'pending', deliveryAttempts: 1 });
    expect(await message(refused)).toMatchObject({ delivery: 'failed' });
    // The retried row is not due for a minute.
    expect(await drainOutbox(rt)).toEqual({ delivered: 0, retried: 0, failed: 0 });
    expect(sent).toHaveLength(2);
    const bounces = await composed.engine
      .datasetFor(CORTEXT_NAMESPACE)
      ?.read('AgentMessage', { where: { inReplyTo: { eq: refused } } });
    expect(bounces?.rows).toHaveLength(1);
    expect(bounces?.rows[0]).toMatchObject({ subject: 'Undelivered: refuse me' });
  });
});
