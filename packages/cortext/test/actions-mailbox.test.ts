/**
 * The mailbox's `act` actions, run through the composed `/substrate/v1/act`
 * route as signed callers: send, ack and read call the mailbox mutations, and
 * an inbox find addresses the caller with `recipient=kid:@me`.
 */

import type { SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'claude';
const ALICE = 'alice-claude@host-a';
const BOB = 'bob-claude@host-a';

interface ActReply {
  ok: boolean;
  ack?: string;
  found?: { rows: Record<string, unknown>[] }[];
  refusal?: { code: string };
  error?: { code: string };
}

async function post<T>(
  server: MemorySubstrateServer,
  path: string,
  sub: string,
  payload: unknown
): Promise<T> {
  const token = signHs256(
    { sub, exp: Math.floor(Date.now() / 1000) + 3600, capabilities: ['read', 'mutate'] },
    'test-secret',
    { kid: 'test' }
  );
  const res: SubstrateResponse = await server.inject({
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: Buffer.from(JSON.stringify(payload))
  });
  const b = res.body;
  const text =
    typeof b === 'string' ? b : b instanceof Uint8Array ? Buffer.from(b).toString('utf8') : '';
  return JSON.parse(text) as T;
}

const act = (server: MemorySubstrateServer, sub: string, sketch: string): Promise<ActReply> =>
  post<ActReply>(server, '/substrate/v1/act', sub, { sketch, namespace: NS });

async function inbox(server: MemorySubstrateServer, sub: string): Promise<unknown[]> {
  const reply = await act(
    server,
    sub,
    'find AgentMessage recipient=kid:@me status=unread archived=false fields=subject'
  );
  expect(reply).toMatchObject({ ok: true });
  return (reply.found?.[0]?.rows ?? []).map((r) => r.subject);
}

async function statusOf(server: MemorySubstrateServer, shortId: number): Promise<unknown> {
  const env = await post<{ data: Record<string, Record<string, unknown>[]>; errors?: unknown }>(
    server,
    '/substrate/v1/query',
    ALICE,
    {
      [`${NS}/AgentMessage`]: {
        params: { where: { shortId: { eq: shortId } } },
        fields: { status: true, ackedBy: true }
      }
    }
  );
  expect(env.errors).toBeUndefined();
  return env.data[`${NS}/AgentMessage`]?.[0];
}

describe('cortext mailbox act actions', () => {
  let server: MemorySubstrateServer;
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await stop?.();
    stop = null;
  });

  const start = async (): Promise<void> => {
    server = new MemorySubstrateServer();
    const composed = await compose({
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      datasets: {
        [NS]: new MemoryDataset({ namespace: NS }),
        architecture: new MemoryDataset({ namespace: 'architecture' })
      },
      coordinators: [buildClaudeForTest({ namespace: NS })],
      auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' }
    });
    await server.start();
    stop = async (): Promise<void> => void (await composed.stop());
    for (const kid of [ALICE, BOB]) {
      const env = await post<{ errors?: unknown }>(server, '/substrate/v1/mutate', ALICE, {
        [`${NS}/createAgentIdentity`]: {
          params: { kid, host: 'host-a', active: true },
          fields: { id: true }
        }
      });
      expect(env.errors).toBeUndefined();
    }
  };

  /** Sends one message from Alice to Bob and returns its shortId. */
  const sendToBob = async (subject: string): Promise<number> => {
    const reply = await act(
      server,
      ALICE,
      `send AgentMessage to=${BOB} subject="${subject}" body="hello"`
    );
    expect(reply).toMatchObject({ ok: true });
    const shortId = /#(\d+)/.exec(reply.ack ?? '')?.[1];
    expect(reply.ack).toMatch(new RegExp(`^sent ${NS}/AgentMessage #\\d+$`));
    return Number(shortId);
  };

  it('send reaches the addressed kid and shows in only that inbox', async () => {
    await start();
    await sendToBob('first');
    expect(await inbox(server, BOB)).toEqual(['first']);
    expect(await inbox(server, ALICE)).toEqual([]);
  });

  it('ack by shortId closes the message as the recipient and empties the inbox', async () => {
    await start();
    const n = await sendToBob('to ack');
    const reply = await act(server, BOB, `ack AgentMessage #${n}`);
    expect(reply).toMatchObject({ ok: true, ack: `acked ${NS}/AgentMessage #${n}` });
    expect(await statusOf(server, n)).toEqual({ status: 'acked', ackedBy: BOB });
    expect(await inbox(server, BOB)).toEqual([]);
  });

  it('read marks the message read', async () => {
    await start();
    const n = await sendToBob('to read');
    expect(await act(server, BOB, `read AgentMessage #${n}`)).toMatchObject({ ok: true });
    expect(await statusOf(server, n)).toMatchObject({ status: 'read' });
  });

  it("ack on someone else's mail is refused and changes nothing", async () => {
    await start();
    const n = await sendToBob('not yours');
    const reply = await act(server, ALICE, `ack AgentMessage #${n}`);
    expect(reply).toMatchObject({ ok: false, error: { code: 'not_recipient' } });
    expect(await statusOf(server, n)).toMatchObject({ status: 'unread' });
  });

  it('send refuses an argument that is not a sendAgentMessage param', async () => {
    await start();
    const reply = await act(
      server,
      ALICE,
      `send AgentMessage to=${BOB} subject="x" body="y" status=acked`
    );
    expect(reply).toMatchObject({ ok: false, refusal: { code: 'sketch_unresolved' } });
    expect(await inbox(server, BOB)).toEqual([]);
  });
});
