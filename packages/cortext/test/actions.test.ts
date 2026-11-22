/**
 * cortext's declared `act` actions, run through the composed `/substrate/v1/act`
 * route: Todo close/defer/block, SessionLog.log closing Todos in the same
 * transaction, and Decision.supersede.
 */

import type { SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import { compose, MemoryDataset, MemorySubstrateServer } from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'claude';

interface Envelope {
  data: Record<string, Record<string, unknown> | Record<string, unknown>[]>;
  errors?: { code?: string; message?: string }[];
}

interface ActReply {
  ok: boolean;
  ack?: string;
  result?: string;
  help?: unknown;
  refusal?: { code: string; token?: string; problem?: string };
  error?: { code: string; message: string };
}

function jsonBody<T>(res: SubstrateResponse): T {
  const b = res.body;
  const text =
    typeof b === 'string' ? b : b instanceof Uint8Array ? Buffer.from(b).toString('utf8') : '';
  return JSON.parse(text) as T;
}

async function setup(): Promise<{ server: MemorySubstrateServer; stop: () => Promise<void> }> {
  const server = new MemorySubstrateServer();
  const composed = await compose({
    systemActor: 'cortext-test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: {
      [NS]: new MemoryDataset({ namespace: NS }),
      architecture: new MemoryDataset({ namespace: 'architecture' })
    },
    coordinators: [buildClaudeForTest({ namespace: NS })]
  });
  await server.start();
  return { server, stop: async (): Promise<void> => void (await composed.stop()) };
}

async function post<T>(server: MemorySubstrateServer, path: string, payload: unknown): Promise<T> {
  const res = await server.inject({
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload))
  });
  return jsonBody<T>(res);
}

const act = (server: MemorySubstrateServer, sketch: string): Promise<ActReply> =>
  post<ActReply>(server, '/substrate/v1/act', { sketch, namespace: NS });

async function createTodo(server: MemorySubstrateServer, title: string): Promise<number> {
  const env = await post<Envelope>(server, '/substrate/v1/mutate', {
    [`${NS}/createTodo`]: {
      params: { title, area: 'act', status: 'open', priority: 'low' },
      fields: { shortId: true }
    }
  });
  expect(env.errors).toBeUndefined();
  return (env.data[`${NS}/createTodo`] as { shortId: number }).shortId;
}

async function readTodo(server: MemorySubstrateServer, shortId: number): Promise<unknown> {
  const env = await post<Envelope>(server, '/substrate/v1/query', {
    [`${NS}/Todo`]: {
      params: { where: { shortId: { eq: shortId } } },
      fields: { status: true, resolution: true, archived: true, revisitWhen: true, blockedBy: true }
    }
  });
  expect(env.errors).toBeUndefined();
  return (env.data[`${NS}/Todo`] as unknown[])[0];
}

describe('cortext act actions', () => {
  let server: MemorySubstrateServer;
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });
  const start = async (): Promise<void> => {
    const s = await setup();
    server = s.server;
    cleanup = s.stop;
  };

  it('close sets closed, the resolution (alias canonicalised) and archived', async () => {
    await start();
    const a = await createTodo(server, 'a');
    const b = await createTodo(server, 'b');
    const reply = await act(server, `close Todo #${a} resolution=wontfix; close Todo #${b}`);
    expect(reply).toMatchObject({ ok: true, ack: `closed ${NS}/Todo #${a} #${b}` });
    expect(await readTodo(server, a)).toMatchObject({
      status: 'closed',
      resolution: 'wont_do',
      archived: true
    });
    expect(await readTodo(server, b)).toMatchObject({ status: 'closed', resolution: 'completed' });
  });

  it('log writes a SessionLog and closes every Todo in closes, in one transaction', async () => {
    await start();
    const a = await createTodo(server, 'a');
    const b = await createTodo(server, 'b');
    const reply = await act(
      server,
      `log SessionLog summary="Shipped" branch=main project=synoptic closes=#${a},#${b}`
    );
    expect(reply.ok).toBe(true);
    expect(reply.ack).toMatch(
      new RegExp(`^logged ${NS}/SessionLog #\\d+; closed ${NS}/Todo #${a} #${b}$`)
    );
    for (const id of [a, b]) {
      expect(await readTodo(server, id)).toMatchObject({
        status: 'closed',
        resolution: 'completed',
        archived: true
      });
    }
    const env = await post<Envelope>(server, '/substrate/v1/query', {
      [`${NS}/SessionLog`]: {
        params: {},
        fields: { summary: true, branch: true, packages: true, decisionsCount: true, project: true }
      }
    });
    expect(env.data[`${NS}/SessionLog`]).toEqual([
      { summary: 'Shipped', branch: 'main', packages: '', decisionsCount: 0, project: 'synoptic' }
    ]);
  });

  it('log commits nothing when a Todo in closes does not exist', async () => {
    await start();
    const a = await createTodo(server, 'a');
    const reply = await act(server, `log SessionLog summary=s branch=main closes=#${a},#9999`);
    expect(reply.ok).toBe(false);
    expect(await readTodo(server, a)).toMatchObject({ status: 'open', archived: false });
    const env = await post<Envelope>(server, '/substrate/v1/query', {
      [`${NS}/SessionLog`]: { params: {}, fields: { id: true } }
    });
    expect(env.data[`${NS}/SessionLog`]).toEqual([]);
  });

  it('defer and block record their condition; deferring a closed Todo clears its resolution', async () => {
    await start();
    const a = await createTodo(server, 'a');
    const b = await createTodo(server, 'b');
    await act(server, `close Todo #${a}`);
    const reply = await act(
      server,
      `defer Todo #${a} revisitWhen="after beta.10"; block Todo #${b} blockedBy="#${a}"`
    );
    expect(reply).toMatchObject({
      ok: true,
      ack: `deferred ${NS}/Todo #${a}; blocked ${NS}/Todo #${b}`
    });
    expect(await readTodo(server, a)).toMatchObject({
      status: 'deferred',
      resolution: null,
      revisitWhen: 'after beta.10'
    });
    expect(await readTodo(server, b)).toMatchObject({ status: 'blocked', blockedBy: `#${a}` });
  });

  it('supersede marks a Decision superseded', async () => {
    await start();
    const env = await post<Envelope>(server, '/substrate/v1/mutate', {
      [`${NS}/createDecision`]: {
        params: { topic: 't', choice: 'c', rationale: 'r' },
        fields: { shortId: true }
      }
    });
    const d = (env.data[`${NS}/createDecision`] as { shortId: number }).shortId;
    expect(await act(server, `supersede Decision #${d}`)).toMatchObject({
      ok: true,
      ack: `superseded ${NS}/Decision #${d}`
    });
  });

  it('refuses a sketch that would undo what close guarantees, or omits a required param', async () => {
    await start();
    const a = await createTodo(server, 'a');
    const undo = await act(server, `close Todo #${a} archived=false`);
    expect(undo).toMatchObject({ ok: false, refusal: { code: 'sketch_unresolved' } });
    const bare = await act(server, `defer Todo #${a}`);
    expect(bare).toMatchObject({ ok: false, refusal: { code: 'sketch_unresolved' } });
    expect(await readTodo(server, a)).toMatchObject({ status: 'open', archived: false });
  });
});
