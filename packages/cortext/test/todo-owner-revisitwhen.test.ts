/**
 * `Todo.owner` and `Todo.revisitWhen` — the two fields that let something
 * other than the operator answer "who is doing this" and "what would make this
 * worth looking at again".
 *
 * WHY THESE TWO, AND WHY NOW. 26 open Todos carry a `blockedBy`, and
 * classifying what that prose actually says gives ~22 conditions on WORLD
 * STATE, 2 dependencies on another item, 1 human pause. So `blockedBy`'s
 * dominant use was never "blocked by X" — it was a gate written in the only
 * field available, and `revisitWhen` already existed on Decision and
 * ArchitectureConcern but not here. Two rows recorded reaching for
 * it and finding a dead pointer.
 *
 * `owner` closes the other half: "nobody is doing this" had NO representation,
 * so a dropped item was indistinguishable from one in progress.
 *
 * THE LOAD-BEARING TEST IS `finds UNCLAIMED work`. Everything else here is
 * round-tripping. That one is the query a dispatcher runs on every wake, and
 * if `owner: { eq: null }` did not discriminate, the field would be
 * decorative — readable on a row you already have, useless for finding the
 * rows you don't.
 */

import type { PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import {
  type ComposeResult,
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'claude';

function jsonBody<T>(res: SubstrateResponse): T {
  const b = res.body;
  const s =
    b === undefined || b === null
      ? ''
      : typeof b === 'string'
        ? b
        : Buffer.isBuffer(b)
          ? b.toString('utf8')
          : b instanceof Uint8Array
            ? Buffer.from(b).toString('utf8')
            : '';
  return JSON.parse(s) as T;
}

async function setup(): Promise<{
  server: MemorySubstrateServer;
  composed: ComposeResult;
  stop: () => Promise<void>;
}> {
  const server = new MemorySubstrateServer();
  const composed: ComposeResult = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: {
      [NS]: new MemoryDataset({ namespace: NS }),
      architecture: new MemoryDataset({ namespace: 'architecture' })
    },
    coordinators: [buildClaudeForTest({ namespace: NS, compactRetention: 3 })],
    auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' },
    streamTicketSecret: 'test-stream-ticket-secret'
  });
  await server.start();
  return { server, composed, stop: () => composed.stop() };
}

const TEST_BEARER = `Bearer ${signHs256(
  {
    sub: 'owner-test',
    exp: Math.floor(Date.now() / 1000) + 3600,
    capabilities: ['read', 'mutate']
  },
  'test-secret',
  { kid: 'test' }
)}`;

const OPERATOR_BEARER = `Bearer ${signHs256(
  {
    sub: 'operator-test',
    exp: Math.floor(Date.now() / 1000) + 3600,
    capabilities: ['read', 'mutate', 'admin']
  },
  'test-secret',
  { kid: 'test' }
)}`;

const mutate = (server: MemorySubstrateServer, payload: unknown): Promise<SubstrateResponse> =>
  server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json', authorization: TEST_BEARER },
    body: Buffer.from(JSON.stringify(payload))
  });

const query = (server: MemorySubstrateServer, payload: unknown): Promise<SubstrateResponse> =>
  server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload))
  });

/** Asserts the frame ran at all — a rejected frame's key is ABSENT from data. */
function dataFor<T>(res: SubstrateResponse, key: string): T {
  const env = jsonBody<PackEnvelope>(res);
  expect(env.errors).toBeUndefined();
  expect(Object.keys(env.data)).toContain(key);
  return env.data[key] as T;
}

const todo = (title: string, extra: Record<string, unknown> = {}) => ({
  params: {
    title,
    area: 'coordination',
    status: 'open',
    priority: 'medium',
    archived: false,
    project: 'substrate',
    ...extra
  },
  fields: { id: true, title: true }
});

describe('Todo.owner', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) await cleanup();
    cleanup = null;
  });

  it('finds UNCLAIMED work — the query a dispatcher runs on every wake', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const id = dataFor<{ id: string }>(
      await mutate(server, {
        [`${NS}/createAgentIdentity`]: {
          params: {
            kid: 'substrate-claude@host-a',
            host: 'host-a',
            project: 'substrate',
            active: true
          },
          fields: { id: true }
        }
      }),
      `${NS}/createAgentIdentity`
    ).id;

    await mutate(server, { [`${NS}/createTodo`]: todo('claimed work', { owner: id }) });
    await mutate(server, { [`${NS}/createTodo`]: todo('unclaimed work') });

    // `eq: null` is the is-null filter, and it must DISCRIMINATE — returning
    // both rows would be the same failure as returning neither.
    const unclaimed = dataFor<Array<{ title: string }>>(
      await query(server, {
        [`${NS}/Todo`]: {
          params: { where: { owner: { eq: null } } },
          fields: { id: true, title: true }
        }
      }),
      `${NS}/Todo`
    );
    expect(unclaimed.map((t) => t.title)).toEqual(['unclaimed work']);

    const mine = dataFor<Array<{ title: string }>>(
      await query(server, {
        [`${NS}/Todo`]: {
          params: { where: { owner: { eq: id } } },
          fields: { id: true, title: true }
        }
      }),
      `${NS}/Todo`
    );
    expect(mine.map((t) => t.title)).toEqual(['claimed work']);
  });

  it('defaults to unclaimed rather than requiring an owner at creation', async () => {
    // Most Todos are filed by whoever noticed the gap, not by whoever will do
    // it. Requiring an owner would force a lie at the moment of least
    // information.
    const { server, stop } = await setup();
    cleanup = stop;
    const created = dataFor<{ id: string }>(
      await mutate(server, { [`${NS}/createTodo`]: todo('nobody has this yet') }),
      `${NS}/createTodo`
    );
    const [row] = dataFor<Array<{ owner: string | null }>>(
      await query(server, {
        [`${NS}/Todo`]: { params: { where: { id: { eq: created.id } } }, fields: { owner: true } }
      }),
      `${NS}/Todo`
    );
    expect(row?.owner ?? null).toBeNull();
  });

  it('releases the claim when the owning identity is deleted, leaving the work', async () => {
    // onDelete: 'set_null'. A retired agent must not take its queue with it —
    // the work reverts to unclaimed and the next dispatcher picks it up.
    //
    // The release is SWEEP-DRIVEN, not synchronous on delete — so a dispatcher
    // reading between the delete and the sweep sees work still owned by a
    // vanished identity. Eventually consistent, and worth knowing before
    // anything schedules against it.
    const { server, composed, stop } = await setup();
    cleanup = stop;

    const id = dataFor<{ id: string }>(
      await mutate(server, {
        [`${NS}/createAgentIdentity`]: {
          params: { kid: 'retiring@Host', host: 'Host', project: 'x', active: true },
          fields: { id: true }
        }
      }),
      `${NS}/createAgentIdentity`
    ).id;
    const t = dataFor<{ id: string }>(
      await mutate(server, { [`${NS}/createTodo`]: todo('outlives its owner', { owner: id }) }),
      `${NS}/createTodo`
    );

    // Identity deletes are operator-only.
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json', authorization: OPERATOR_BEARER },
      body: Buffer.from(
        JSON.stringify({ [`${NS}/deleteAgentIdentity`]: { params: { id }, fields: { id: true } } })
      )
    });
    await composed.runSweepNow();

    const [row] = dataFor<Array<{ title: string; owner: string | null }>>(
      await query(server, {
        [`${NS}/Todo`]: {
          params: { where: { id: { eq: t.id } } },
          fields: { title: true, owner: true }
        }
      }),
      `${NS}/Todo`
    );
    expect(row?.title).toBe('outlives its owner');
    expect(row?.owner ?? null).toBeNull();
  });
});

describe('Todo.revisitWhen', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) await cleanup();
    cleanup = null;
  });

  it('round-trips the gate text, independently of blockedBy', async () => {
    // The two must not collapse into each other: `blockedBy` means another
    // ITEM must land first and a scheduler can resolve it structurally;
    // `revisitWhen` is a condition on the world that needs a reader. Storing
    // both on one row is the case that proves they are separate fields.
    const { server, stop } = await setup();
    cleanup = stop;

    const created = dataFor<{ id: string }>(
      await mutate(server, {
        [`${NS}/createTodo`]: todo('per-type HNSW', {
          revisitWhen: 'embeddings crosses ~10k rows AND recall p95 is above target',
          blockedBy: 'needs #37 to land first'
        })
      }),
      `${NS}/createTodo`
    );

    const [row] = dataFor<Array<{ revisitWhen: string | null; blockedBy: string | null }>>(
      await query(server, {
        [`${NS}/Todo`]: {
          params: { where: { id: { eq: created.id } } },
          fields: { revisitWhen: true, blockedBy: true }
        }
      }),
      `${NS}/Todo`
    );
    expect(row?.revisitWhen).toBe('embeddings crosses ~10k rows AND recall p95 is above target');
    expect(row?.blockedBy).toBe('needs #37 to land first');
  });

  it('is unindexed, matching its Decision and ArchitectureConcern twins', async () => {
    // Asserted rather than assumed: it is prose for a reader to evaluate, not
    // a filter target, and a structural filter must therefore be REJECTED
    // rather than quietly table-scanning the corpus.
    const { server, stop } = await setup();
    cleanup = stop;

    const env = jsonBody<PackEnvelope>(
      await query(server, {
        [`${NS}/Todo`]: {
          params: { where: { revisitWhen: { eq: 'anything' } } },
          fields: { id: true }
        }
      })
    );
    expect(env.errors?.[0]?.code).toBe('unindexed_field');
    // The rejected frame's key is ABSENT — not present-and-empty.
    expect(Object.keys(env.data)).not.toContain(`${NS}/Todo`);
  });
});
