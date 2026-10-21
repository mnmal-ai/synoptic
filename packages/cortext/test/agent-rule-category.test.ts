/**
 * `AgentRule.category` accepts any string, and specifically the categories in
 * AGENT_RULE_CATEGORY_VOCAB. An enum over a subset would reject the rest, and
 * the failure is silent: agents pick the nearest legal word instead. See
 * AGENT_RULE_CATEGORY_VOCAB's docstring.
 */

import type { SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import { compose, MemoryDataset, MemorySubstrateServer } from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_RULE_CATEGORY_VOCAB } from '../src/namespace.js';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'claude';

/**
 * The seven an enum over the first five categories would reject. Named
 * explicitly rather than derived from AGENT_RULE_CATEGORY_VOCAB: deriving
 * would make this test agree with whatever that constant says, and these
 * values must remain writable no matter how the constant moves.
 */
const PREVIOUSLY_REJECTED = [
  'scope-discipline',
  'investigation',
  'communication',
  'migration-patterns',
  'verification',
  'side-findings',
  'permissions'
] as const;

function jsonBody<T>(res: SubstrateResponse): T {
  const b = res.body;
  const text =
    typeof b === 'string'
      ? b
      : Buffer.isBuffer(b)
        ? b.toString('utf8')
        : b instanceof Uint8Array
          ? Buffer.from(b).toString('utf8')
          : '';
  return JSON.parse(text) as T;
}

async function setup(): Promise<{ server: MemorySubstrateServer; stop: () => Promise<void> }> {
  const server = new MemorySubstrateServer();
  const composed = await compose({
    // substrate refuses an unattributed write rather than defaulting it to
    // `system:anonymous` (which is how 1,367 such rows accumulated in the live
    // store). With no `auth` there is no caller to attribute to, so an
    // unauthenticated deployment DECLARES who it writes as. Ignored when `auth`
    // is set, so only the no-auth compose sites carry it.
    systemActor: 'cortext-test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: {
      [NS]: new MemoryDataset({ namespace: NS }),
      architecture: new MemoryDataset({ namespace: 'architecture' })
    },
    coordinators: [buildClaudeForTest({ namespace: NS, compactRetention: 3 })]
  });
  await server.start();
  return { server, stop: async (): Promise<void> => void (await composed.stop()) };
}

interface Envelope {
  data: Record<string, unknown>;
  errors?: { code?: string; message?: string }[];
}

async function createRule(server: MemorySubstrateServer, category: string): Promise<Envelope> {
  const res = await server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(
      JSON.stringify({
        [`${NS}/createAgentRule`]: {
          params: { rule: 'probe', category, active: false, rationale: 'probe' },
          fields: { id: true, category: true }
        }
      })
    )
  });
  return jsonBody<Envelope>(res);
}

describe('AgentRule.category enum', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('accepts every documented category', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    for (const category of AGENT_RULE_CATEGORY_VOCAB) {
      const env = await createRule(server, category);
      expect(env.errors, `documented category '${category}' was rejected`).toBeUndefined();
    }
  });

  it.each(PREVIOUSLY_REJECTED)('accepts %s, which a closed enum would reject', async (category) => {
    const { server, stop } = await setup();
    cleanup = stop;
    const env = await createRule(server, category);
    expect(env.errors, `'${category}' rejected — active production rules use it`).toBeUndefined();
  });

  it('accepts a category nobody has used yet', async () => {
    // The one that makes this a fix rather than a widening. If this fails, the
    // enum has been re-added over a longer list and the thirteenth category
    // hits the same wall — which is the outcome the free-string choice exists
    // to prevent.
    const { server, stop } = await setup();
    cleanup = stop;
    const env = await createRule(server, 'observability');
    expect(env.errors).toBeUndefined();
  });

  it('still REJECTS a missing category — free does not mean optional', async () => {
    // `category` is non-nullable. Dropping the enum must not quietly make the
    // field skippable, or rules start arriving uncategorised and the taxonomy
    // erodes from the other end.
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/createAgentRule`]: {
            params: { rule: 'probe', active: false, rationale: 'probe' },
            fields: { id: true }
          }
        })
      )
    });
    expect(jsonBody<Envelope>(res).errors).toBeDefined();
  });
});
