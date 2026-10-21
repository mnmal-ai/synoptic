import type { SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import { compose, MemoryDataset, MemorySubstrateServer } from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'claude';

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

function jsonBody<T>(res: SubstrateResponse): T {
  return JSON.parse(bodyToString(res)) as T;
}

interface FederatedSchemaShape {
  [ns: string]: {
    types: Record<
      string,
      {
        fields: Record<
          string,
          { kind?: string; type?: string; onDelete?: string; nullable?: boolean }
        >;
      }
    >;
  };
}

async function setup(): Promise<{
  server: MemorySubstrateServer;
  stop: () => Promise<void>;
}> {
  const server = new MemorySubstrateServer();
  const defaultDataset = new MemoryDataset({ namespace: 'default' });
  const claudeDataset = new MemoryDataset({ namespace: NS });
  const architectureDataset = new MemoryDataset({ namespace: 'architecture' });
  const plugin = buildClaudeForTest({ namespace: NS, compactRetention: 3 });
  const composed = await compose({
    // substrate refuses an unattributed write rather than defaulting it to
    // `system:anonymous` (which is how 1,367 such rows accumulated in the live
    // store). With no `auth` there is no caller to attribute to, so an
    // unauthenticated deployment DECLARES who it writes as. Ignored when `auth`
    // is set, so only the no-auth compose sites carry it.
    systemActor: 'cortext-test',
    server,
    dataset: defaultDataset,
    datasets: { [NS]: claudeDataset, architecture: architectureDataset },
    coordinators: [plugin]
  });
  await server.start();
  return {
    server,
    stop: async (): Promise<void> => {
      await composed.stop();
    }
  };
}

describe('Concept + ConceptLink schema', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('exposes Concept with the required fields', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const conceptType = schema[NS]?.types.Concept;
    expect(conceptType).toBeDefined();
    for (const f of ['name', 'description', 'kind', 'body', 'synopsis', 'archived', 'project']) {
      expect(conceptType?.fields[f], `Concept.${f} should be defined`).toBeDefined();
    }
  });

  it('exposes ConceptLink with cascade crossRefs to Concept', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const link = schema[NS]?.types.ConceptLink;
    expect(link).toBeDefined();
    expect(link?.fields.fromConcept).toMatchObject({
      kind: 'crossRef',
      type: 'Concept',
      onDelete: 'cascade'
    });
    expect(link?.fields.toConcept).toMatchObject({
      kind: 'crossRef',
      type: 'Concept',
      onDelete: 'cascade'
    });
    expect(link?.fields.kind).toBeDefined();
  });

  it('Decision.establishesConcept + AgentRule.expressesConcept point at Concept with set_null', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    expect(schema[NS]?.types.Decision?.fields.establishesConcept).toMatchObject({
      kind: 'crossRef',
      type: 'Concept',
      nullable: true,
      onDelete: 'set_null'
    });
    expect(schema[NS]?.types.AgentRule?.fields.expressesConcept).toMatchObject({
      kind: 'crossRef',
      type: 'Concept',
      nullable: true,
      onDelete: 'set_null'
    });
  });
});
