/**
 * cortext on a per-type tables store: the kernel migrations run without
 * touching `rows`, the coordinator composes over the pg dataset, the engine
 * holds the guarantees the legacy raw DDL used to (kid and HostInstall key
 * uniqueness, the Todo and AgentMessage vocabularies), and the audit and
 * repair take the engine-owned path.
 *
 * Runs in a schema of its own, rebuilt each run.
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
import { CORTEXT_COORDINATOR_NAME, CORTEXT_NAMESPACE } from '../../src/kernel/cortext-namespace.js';
import { reportInvariantAudit } from '../../src/kernel/invariant-audit.js';
import { storeLayout } from '../../src/kernel/layout.js';
import { createCortextKernelPlugin } from '../../src/kernel/plugin.js';
import { REPAIR_ENV_VAR, repairIfRequested } from '../../src/kernel/repair.js';
import {
  AGENT_MESSAGE_STATUS_VOCAB,
  TODO_LIFECYCLE_VOCAB,
  TODO_PRIORITY_VOCAB
} from '../../src/kernel/todo-vocab.js';
import { buildClaudeForTest } from '../_helpers.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PACKAGE = 'cortext-tables';

const ctx: Partial<RequestContext> = {
  identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate', 'admin'] } }
};

/**
 * A fresh store, migrated by the installed substrate. A substrate older than
 * 1.0.0-alpha.12 builds `rows` instead, and the suite skips.
 */
async function openStore(url: string): Promise<ReturnType<typeof postgres>> {
  await recreatePgTestSchema(url, pgTestSchemaName(PACKAGE));
  const sql = postgres(pgTestSchemaUrl(url, PACKAGE), { onnotice: () => {} });
  await runMigrations(sql);
  return sql;
}

const store = POSTGRES_URL ? await openStore(POSTGRES_URL) : undefined;
// Gated on `rows` alone, so a storeLayout that misreads tables fails below rather than skipping.
const onTables =
  store !== undefined &&
  (await store`SELECT to_regclass('rows') IS NULL AS absent`)[0]?.absent === true;
if (store !== undefined && !onTables) await dropStore(store);

async function dropStore(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${pgTestSchemaName(PACKAGE)}" CASCADE`);
  await sql.end({ timeout: 5 });
}

describe.skipIf(!onTables)('cortext on the per-type tables layout', () => {
  const sql = store as ReturnType<typeof postgres>;
  let composed: Awaited<ReturnType<typeof compose>>;
  const metrics: string[] = [];

  const mutate = (frame: Record<string, unknown>) =>
    composed.engine.mutate({ frame: frame as never, ctx: ctx as RequestContext });

  beforeAll(async () => {
    for (const migration of createCortextKernelPlugin().migrations ?? []) {
      const migrationCtx = { sql, layout: 'tables', metric: (name: string) => metrics.push(name) };
      await migration.apply(migrationCtx as never);
    }
    const coordinator = buildClaudeForTest({ namespace: CORTEXT_NAMESPACE });
    const types = coordinator.namespaces?.[0]?.types ?? {};
    const edgesStore = new PgEdgesStore({ sql });
    composed = await compose({
      server: new MemorySubstrateServer(),
      dataset: new PgDataset({
        namespace: 'default',
        sql,
        edgesStore,
        // The declared types, which the type tables, enum CHECKs and indexes are built from.
        typeDefLookup: (type, namespace) =>
          namespace === CORTEXT_NAMESPACE ? types[type] : undefined
      }),
      edges: edgesStore,
      coordinators: [coordinator],
      systemActor: 'test'
    });
    // As the binary's serve wiring does before it starts: table and unique indexes.
    const dataset = composed.engine.datasetFor(CORTEXT_NAMESPACE);
    const storage = { indexes: 'unique', newFields: 'column' } as const;
    for (const type of Object.keys(types)) await dataset?.ensureTypeStorage?.(type, storage);
  }, 120_000);

  afterAll(async () => {
    await composed?.stop();
    await dropStore(sql);
  });

  it('reads the layout from the catalog', async () => {
    expect(await storeLayout(sql)).toBe('tables');
  });

  it('runs the kernel migrations without creating or touching rows', async () => {
    const [row] = await sql`SELECT to_regclass('rows') IS NULL AS absent`;
    expect(row?.absent).toBe(true);
    expect(metrics).toEqual([]);
  });

  it('refuses a second live AgentIdentity with the same kid', async () => {
    const identity = { kid: 'dup@host-a', host: 'host-a', project: null };
    const first = await mutate({
      'cortext/createAgentIdentity': { params: identity, fields: { id: true } }
    });
    expect(first.errors).toBeUndefined();
    const second = await mutate({
      'cortext/createAgentIdentity': { params: identity, fields: { id: true } }
    });
    // The mailbox refuses it by name before the write; the index holds it underneath.
    expect(second.errors?.[0]).toMatchObject({ code: 'duplicate_kid' });
    const [index] = await sql`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = 'rows_agent_identity_kid_unique'
    `;
    expect(index?.indexdef).toMatch(/^CREATE UNIQUE INDEX .*WHERE \(deleted_at IS NULL\)/);
  });

  it('refuses a second live HostInstall with the same key', async () => {
    const record = {
      key: 'host-a/synoptic/claude-code',
      host: 'host-a',
      hostReported: 'host-a',
      project: 'synoptic',
      kid: 'synoptic-claude@host-a',
      harness: 'claude-code',
      pluginVersion: '2.9.0',
      fragmentVersion: '2.9.0',
      fragmentDigest: 'cb15e93a',
      fragmentState: 'source',
      refreshedAt: '2026-10-09T12:00:00.000Z'
    };
    const first = await mutate({
      'cortext/createHostInstall': { params: record, fields: { id: true } }
    });
    expect(first.errors).toBeUndefined();
    const second = await mutate({
      'cortext/createHostInstall': { params: record, fields: { id: true } }
    });
    expect(second.errors?.[0]).toMatchObject({ code: 'unique_violation' });
  });

  it('refuses an off-vocabulary Todo status and priority', async () => {
    const todo = { title: 't', area: 'a', status: 'open', priority: 'low' };
    for (const params of [
      { ...todo, status: 'bogus' },
      { ...todo, priority: 'urgent' }
    ]) {
      const env = await mutate({ 'cortext/createTodo': { params, fields: { id: true } } });
      expect(env.data['cortext/createTodo']).toBeUndefined();
      expect(env.errors?.length).toBeGreaterThan(0);
    }
    const ok = await mutate({ 'cortext/createTodo': { params: todo, fields: { id: true } } });
    expect(ok.errors).toBeUndefined();
  });

  it('carries each vocabulary as a column CHECK on its type table', async () => {
    const checks = (
      await sql`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE connamespace = current_schema()::regnamespace AND contype = 'c'
      `
    ).map((r) => r.def as string);
    for (const vocab of [TODO_LIFECYCLE_VOCAB, TODO_PRIORITY_VOCAB, AGENT_MESSAGE_STATUS_VOCAB]) {
      expect(checks.some((def) => vocab.every((v) => def.includes(`'${v}'::text`)))).toBe(true);
    }
  });

  it('audits clean, under the built-in namespace and a renamed one', async () => {
    const seen: Array<[string, unknown]> = [];
    const metric = (name: string, payload?: unknown): number => seen.push([name, payload]);
    expect(
      await reportInvariantAudit(
        { sql, coordinatorNamespaces: [CORTEXT_NAMESPACE], metric },
        () => {}
      )
    ).toEqual([]);
    expect(
      await reportInvariantAudit(
        {
          sql,
          coordinatorNamespaces: ['codex'],
          coordinatorNamespacesByPlugin: [{ plugin: CORTEXT_COORDINATOR_NAME, namespace: 'codex' }],
          metric
        },
        () => {}
      )
    ).toEqual([]);
    expect(seen).toContainEqual([
      'cortext_kernel.invariant_audit_complete',
      { checked: 0, findings: 0, catalogRead: true, layout: 'tables' }
    ]);
  });

  it('declines repair', async () => {
    const seen: string[] = [];
    const outcomes = await repairIfRequested(
      {
        sql,
        namespace: CORTEXT_NAMESPACE,
        env: { [REPAIR_ENV_VAR]: '1' },
        metric: (name, payload) => seen.push(`${name}:${JSON.stringify(payload)}`)
      },
      () => {}
    );
    expect(outcomes).toBeNull();
    expect(seen).toEqual(['cortext_kernel.repair_declined:{"reason":"tables"}']);
  });
});
