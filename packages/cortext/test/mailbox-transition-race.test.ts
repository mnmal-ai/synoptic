// A mark-read and an ack racing on one message: two sessions share a kid, so
// both can transition the same row. The loser must re-check against the
// winner's status rather than overwrite it.
import type { PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { expect, it } from 'vitest';
import { buildClaudeForTest } from './_helpers.js';

const NS = 'claude';
const RECIPIENT = 'notes-claude@host-a';
const SENDER = 'sender-claude@host-a';

function jsonBody<T>(res: SubstrateResponse): T {
  const b = res.body;
  const text = typeof b === 'string' ? b : Buffer.from(b as Uint8Array).toString('utf8');
  return JSON.parse(text) as T;
}

function mutateAs(server: MemorySubstrateServer, sub: string, payload: unknown) {
  const token = signHs256(
    { sub, exp: Math.floor(Date.now() / 1000) + 3600, capabilities: ['read', 'mutate'] },
    'test-secret',
    { kid: 'test' }
  );
  return server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: Buffer.from(JSON.stringify(payload))
  });
}

it('a mark-read that loses to an ack leaves the message acked', async () => {
  const server = new MemorySubstrateServer();
  const ds = new MemoryDataset({ namespace: NS });
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: { [NS]: ds, architecture: new MemoryDataset({ namespace: 'architecture' }) },
    coordinators: [buildClaudeForTest({ namespace: NS })],
    auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' },
    streamTicketSecret: 'test-stream-ticket-secret'
  });
  await server.start();
  try {
    for (const kid of [RECIPIENT, SENDER]) {
      const res = await mutateAs(server, kid, {
        [`${NS}/createAgentIdentity`]: { params: { kid, host: 'host-a' }, fields: { id: true } }
      });
      expect(jsonBody<PackEnvelope>(res).errors).toBeUndefined();
    }
    const sent = jsonBody<PackEnvelope>(
      await mutateAs(server, SENDER, {
        [`${NS}/sendAgentMessage`]: {
          params: { to: RECIPIENT, subject: 's', body: 'b' },
          fields: { id: true }
        }
      })
    );
    expect(sent.errors).toBeUndefined();
    const raw = sent.data[`${NS}/sendAgentMessage`];
    const msgId = (Array.isArray(raw) ? raw[0] : raw) as { id: string };

    // The other session's ack lands between this mark-read's read and its write.
    const original = ds.conditionalUpdate.bind(ds);
    let raced = false;
    ds.conditionalUpdate = async (type, id, match, updates, actor, now) => {
      if (!raced && type === 'AgentMessage' && match.status === 'unread') {
        raced = true;
        await original(type, id, {}, { status: 'acked', ackedBy: RECIPIENT }, actor, now);
      }
      return original(type, id, match, updates, actor, now);
    };

    const read = jsonBody<PackEnvelope>(
      await mutateAs(server, RECIPIENT, {
        [`${NS}/markAgentMessageRead`]: {
          params: { id: msgId.id },
          fields: { id: true, status: true }
        }
      })
    );
    expect(raced).toBe(true);
    expect(read.errors).toBeUndefined();
    expect((read.data[`${NS}/markAgentMessageRead`] as { status: string }).status).toBe('acked');
    const { rows } = await ds.read('AgentMessage', { id: msgId.id });
    expect(rows[0]?.status).toBe('acked');
  } finally {
    await composed.stop();
  }
});
