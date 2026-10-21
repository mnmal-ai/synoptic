/**
 * claude/AgentMessage mutation family — sendAgentMessage (kid addressing +
 * fan-out) and the recipient-only transition
 * mutations markAgentMessageRead / ackAgentMessage.
 *
 * Direct createAgentMessage is retired (not registered at all — the type
 * declares autoCrud:false); updateAgentMessage
 * keeps working for archive/tags edits but the transition fields (status,
 * ackedBy, ackedAt) are locked to the dedicated mutations.
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

const SENDER = 'peer-claude@host-a';
const NOTES = 'notes-claude@host-a';
const BASELINE = 'baseline-claude@host-a';
const RETIRED = 'legacy-claude@host-a';

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

async function setup(): Promise<{
  server: MemorySubstrateServer;
  composed: ComposeResult;
  stop: () => Promise<void>;
}> {
  const server = new MemorySubstrateServer();
  const defaultDataset = new MemoryDataset({ namespace: 'default' });
  const claudeDataset = new MemoryDataset({ namespace: NS });
  const architectureDataset = new MemoryDataset({ namespace: 'architecture' });
  const plugin = buildClaudeForTest({ namespace: NS });
  const composed: ComposeResult = await compose({
    server,
    dataset: defaultDataset,
    datasets: { [NS]: claudeDataset, architecture: architectureDataset },
    coordinators: [plugin],
    auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' },
    // substrate fails compose() closed when auth is on and this is absent
    // or <16 chars — it is the sole auth on the ungated SSE GET routes.
    streamTicketSecret: 'test-stream-ticket-secret'
  });
  await server.start();
  return {
    server,
    composed,
    stop: async (): Promise<void> => {
      await composed.stop();
    }
  };
}

function bearer(sub: string): string {
  return `Bearer ${signHs256(
    { sub, exp: Math.floor(Date.now() / 1000) + 3600, capabilities: ['read', 'mutate'] },
    'test-secret',
    { kid: 'test' }
  )}`;
}

/** An operator token: identity deletes are operator-only. */
function operatorBearer(sub: string): string {
  return `Bearer ${signHs256(
    { sub, exp: Math.floor(Date.now() / 1000) + 3600, capabilities: ['read', 'mutate', 'admin'] },
    'test-secret',
    { kid: 'test' }
  )}`;
}

async function mutateAsOperator(
  server: MemorySubstrateServer,
  payload: unknown
): Promise<SubstrateResponse> {
  return server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json', authorization: operatorBearer('operator@Host') },
    body: Buffer.from(JSON.stringify(payload))
  });
}

async function mutateAs(
  server: MemorySubstrateServer,
  sub: string,
  payload: unknown
): Promise<SubstrateResponse> {
  return server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json', authorization: bearer(sub) },
    body: Buffer.from(JSON.stringify(payload))
  });
}

async function mutateAnon(
  server: MemorySubstrateServer,
  payload: unknown
): Promise<SubstrateResponse> {
  return server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload))
  });
}

async function query(server: MemorySubstrateServer, payload: unknown): Promise<SubstrateResponse> {
  return server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload))
  });
}

async function makeIdentity(
  server: MemorySubstrateServer,
  kid: string,
  active = true,
  // Left UNDEFINED rather than defaulting to true, so the existing suite keeps
  // creating rows that do not carry the key at all — which is the shape every
  // AgentIdentity predating the field has. If these helpers set it
  // explicitly, nothing would exercise the absent case.
  broadcastEligible?: boolean
): Promise<string> {
  const res = await mutateAs(server, 'cortext@host-a', {
    'claude/createAgentIdentity': {
      params: {
        kid,
        host: 'host-a',
        active,
        ...(broadcastEligible === undefined ? {} : { broadcastEligible })
      },
      fields: { id: true }
    }
  });
  const env = jsonBody<PackEnvelope>(res);
  expect(env.errors).toBeUndefined();
  return (env.data['claude/createAgentIdentity'] as { id: string }).id;
}

interface SentMessage {
  id: string;
  recipient: string | null;
  status: string;
  subject: string;
  ackedBy: string | null;
  ackedAt: string | null;
}

async function send(
  server: MemorySubstrateServer,
  asKid: string,
  params: Record<string, unknown>
): Promise<PackEnvelope> {
  const res = await mutateAs(server, asKid, {
    'claude/sendAgentMessage': {
      params,
      fields: {
        id: true,
        recipient: true,
        status: true,
        subject: true,
        ackedBy: true,
        ackedAt: true
      }
    }
  });
  return jsonBody<PackEnvelope>(res);
}

describe('claude/sendAgentMessage — kid addressing + fan-out', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('sends to a single kid: resolves the directory row, lands unread in the inbox', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const notesId = await makeIdentity(server, NOTES);

    const env = await send(server, SENDER, {
      to: NOTES,
      subject: 'recall calibration',
      body: 'Can you confirm the bge-m3 cosine band?'
    });
    expect(env.errors, 'sendAgentMessage should succeed').toBeUndefined();
    const rows = env.data['claude/sendAgentMessage'] as SentMessage[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipient).toBe(notesId);
    expect(rows[0]?.status).toBe('unread');

    const inboxEnv = jsonBody<PackEnvelope>(
      await query(server, {
        'claude/AgentMessage': {
          params: {
            where: {
              recipient: { eq: notesId },
              status: { eq: 'unread' },
              archived: { eq: false }
            }
          },
          fields: { id: true, subject: true, _metadata: true }
        }
      })
    );
    expect(inboxEnv.errors).toBeUndefined();
    const inbox = inboxEnv.data['claude/AgentMessage'] as Array<{
      subject: string;
      _metadata: { createdBy: { id: string } };
    }>;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.subject).toBe('recall calibration');
    // Non-repudiable sender: stamped from the signed principal, not params.
    expect(inbox[0]?._metadata.createdBy.id).toBe(SENDER);
  });

  // Two writers holding one kid are indistinguishable in the record, so the
  // sender states which instance it is, and every fanned-out row carries
  // it, indexed so a reader can filter on it.
  it('stamps the sender-supplied instance on every fanned-out row, filterable', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    await makeIdentity(server, BASELINE);
    const env = await send(server, SENDER, {
      to: [NOTES, BASELINE],
      subject: 'from one instance',
      body: 'b',
      instance: 'session:1a2b3c4d'
    });
    expect(env.errors).toBeUndefined();
    const res = await query(server, {
      'claude/AgentMessage': {
        params: { where: { instance: { eq: 'session:1a2b3c4d' } } },
        fields: { id: true, instance: true }
      }
    });
    const rows = jsonBody<PackEnvelope>(res).data['claude/AgentMessage'] as Array<{
      instance: string;
    }>;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.instance).toBe('session:1a2b3c4d');
  });

  it('leaves instance null when the sender does not state one', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    await send(server, SENDER, { to: NOTES, subject: 's', body: 'b' });
    const res = await query(server, {
      'claude/AgentMessage': { params: {}, fields: { id: true, instance: true } }
    });
    const rows = jsonBody<PackEnvelope>(res).data['claude/AgentMessage'] as Array<{
      instance: string | null;
    }>;
    expect(rows[0]?.instance ?? null).toBeNull();
  });

  it('fans out one row per kid on a multi-recipient send', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const notesId = await makeIdentity(server, NOTES);
    const baselineId = await makeIdentity(server, BASELINE);

    const env = await send(server, SENDER, {
      to: [NOTES, BASELINE],
      subject: 'multicast',
      body: 'one row each'
    });
    expect(env.errors).toBeUndefined();
    const rows = env.data['claude/sendAgentMessage'] as SentMessage[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.recipient))).toEqual(new Set([notesId, baselineId]));
    for (const row of rows) {
      expect(row.status).toBe('unread');
      expect(row.subject).toBe('multicast');
    }
  });

  it("fans out to every active identity except the sender on to:'*'", async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const notesId = await makeIdentity(server, NOTES);
    const baselineId = await makeIdentity(server, BASELINE);
    await makeIdentity(server, RETIRED, false);
    await makeIdentity(server, SENDER);

    const env = await send(server, SENDER, {
      to: '*',
      subject: 'cohort notice',
      body: 'announcement'
    });
    expect(env.errors).toBeUndefined();
    const rows = env.data['claude/sendAgentMessage'] as SentMessage[];
    // Active recipients only, sender excluded, inactive excluded.
    expect(new Set(rows.map((r) => r.recipient))).toEqual(new Set([notesId, baselineId]));
  });

  describe('broadcast eligibility', () => {
    it('still reaches identities that predate the field entirely', async () => {
      // `broadcastEligible` defaults true, but a default applies on WRITE —
      // rows that predate the field have no such key. Filtering in the `where`
      // clause would match none of them and turn every broadcast into
      // `no_recipients`. These identities are created without the field.
      const { server, stop } = await setup();
      cleanup = stop;
      const notesId = await makeIdentity(server, NOTES);
      await makeIdentity(server, SENDER);

      const env = await send(server, SENDER, { to: '*', subject: 'n', body: 'b' });
      expect(env.errors).toBeUndefined();
      const rows = env.data['claude/sendAgentMessage'] as SentMessage[];
      expect(rows.map((r) => r.recipient)).toEqual([notesId]);
    });

    it('skips an identity opted out of broadcasts while it stays active', async () => {
      // The fleet-default case: claude-code@host-a must remain `active: true`
      // because un-onboarded repos sign as it, but nothing reads its inbox.
      // Deactivating it instead would silently drop broadcasts for exactly the
      // repos most likely to need onboarding news.
      const { server, stop } = await setup();
      cleanup = stop;
      const notesId = await makeIdentity(server, NOTES);
      await makeIdentity(server, BASELINE, true, false);
      await makeIdentity(server, SENDER);

      const env = await send(server, SENDER, { to: '*', subject: 'n', body: 'b' });
      expect(env.errors).toBeUndefined();
      const rows = env.data['claude/sendAgentMessage'] as SentMessage[];
      expect(rows.map((r) => r.recipient)).toEqual([notesId]);
    });

    it('still delivers to an opted-out identity addressed EXPLICITLY', async () => {
      // Eligibility governs fan-out only. `broadcastEligible: false` means "do
      // not include me in '*'", not "do not talk to me" — an operator must
      // still be able to reach the fleet default directly.
      const { server, stop } = await setup();
      cleanup = stop;
      const quietId = await makeIdentity(server, BASELINE, true, false);
      await makeIdentity(server, SENDER);

      const env = await send(server, SENDER, { to: BASELINE, subject: 'n', body: 'b' });
      expect(env.errors).toBeUndefined();
      const rows = env.data['claude/sendAgentMessage'] as SentMessage[];
      expect(rows.map((r) => r.recipient)).toEqual([quietId]);
    });

    it('distinguishes "nobody active" from "everybody opted out"', async () => {
      // The remedies are opposite — an empty directory versus a flag set too
      // widely — so one message for both would send an operator to the wrong
      // field.
      const { server, stop } = await setup();
      cleanup = stop;
      await makeIdentity(server, NOTES, true, false);
      await makeIdentity(server, SENDER);

      const env = await send(server, SENDER, { to: '*', subject: 'n', body: 'b' });
      expect(env.errors?.[0]?.code).toBe('no_recipients');
      expect(env.errors?.[0]?.message).toContain('broadcastEligible: false');
    });
  });

  // The declared schema for `to` is list(string), so the
  // canonical list form must cover every affordance — ['*'] is the wildcard
  // expressed as a list (bare '*' and bare-string kid remain accepted sugar).
  it("accepts the wildcard as a list — to: ['*'] fans out like to: '*'", async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const notesId = await makeIdentity(server, NOTES);
    await makeIdentity(server, SENDER);

    const env = await send(server, SENDER, {
      to: ['*'],
      subject: 'list-form broadcast',
      body: 'announcement'
    });
    expect(env.errors).toBeUndefined();
    const rows = env.data['claude/sendAgentMessage'] as SentMessage[];
    expect(new Set(rows.map((r) => r.recipient))).toEqual(new Set([notesId]));
  });

  it('rejects the wildcard mixed with explicit kids', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);

    const env = await send(server, SENDER, {
      to: ['*', NOTES],
      subject: 'ambiguous broadcast',
      body: 'x'
    });
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('wildcard_mixed');
  });

  it('deduplicates repeated kids in the recipient list', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);

    const env = await send(server, SENDER, {
      to: [NOTES, NOTES],
      subject: 'once',
      body: 'no double delivery'
    });
    expect(env.errors).toBeUndefined();
    expect(env.data['claude/sendAgentMessage'] as SentMessage[]).toHaveLength(1);
  });

  it('rejects an unknown kid and writes nothing (validate-first atomicity)', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const notesId = await makeIdentity(server, NOTES);

    const env = await send(server, SENDER, {
      to: [NOTES, 'ghost-claude@host-a'],
      subject: 'partial',
      body: 'must not land'
    });
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('unknown_recipient');

    const inboxEnv = jsonBody<PackEnvelope>(
      await query(server, {
        'claude/AgentMessage': {
          params: { where: { recipient: { eq: notesId } } },
          fields: { id: true }
        }
      })
    );
    expect(inboxEnv.data['claude/AgentMessage'] as unknown[]).toHaveLength(0);
  });

  // Kid is the directory's natural key. On pg a partial
  // unique index (kernel migration 0004) makes duplicates impossible; this
  // resolver guard covers in-memory-store deployments and gives a branchable
  // error instead of silently picking one of the rows.
  it('rejects a send when the kid resolves to more than one directory row', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    await makeIdentity(server, NOTES); // duplicate kid — memory store allows it

    const env = await send(server, SENDER, {
      to: NOTES,
      subject: 'ambiguous',
      body: 'two mailboxes claim this address'
    });
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('ambiguous_recipient');
  });

  it('rejects a directed send to an inactive identity', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, RETIRED, false);

    const env = await send(server, SENDER, {
      to: RETIRED,
      subject: 'dead letter',
      body: 'nobody home'
    });
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('inactive_recipient');
  });

  it("rejects to:'*' when no other active identity exists", async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, SENDER);

    const env = await send(server, SENDER, { to: '*', subject: 'echo', body: 'void' });
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('no_recipients');
  });

  it('requires an authenticated identity', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);

    const res = await mutateAnon(server, {
      'claude/sendAgentMessage': {
        params: { to: NOTES, subject: 'anon', body: 'no sender' },
        fields: { id: true }
      }
    });
    // substrate refuses an anonymous WRITE at the transport rather than
    // letting it reach the mutation's own identity check, so the refusal is a
    // bare `401 {"code":"unauthorized"}` with no envelope — `policy_denied` was
    // the old, one-layer-later answer. The invariant under test is unchanged:
    // an unattributed send does not go through.
    expect(res.status).toBe(401);
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeUndefined();
    expect(env.data).toBeUndefined();
  });

  it('rejects transition/server fields smuggled into send params', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);

    const env = await send(server, SENDER, {
      to: NOTES,
      subject: 'smuggle',
      body: 'x',
      status: 'acked'
    });
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('unknown_field');
  });

  it('threads a fan-out reply via inReplyTo', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const peerId = await makeIdentity(server, SENDER);
    await makeIdentity(server, NOTES);

    const first = await send(server, SENDER, { to: NOTES, subject: 'q', body: 'question' });
    expect(first.errors).toBeUndefined();
    const firstId = (first.data['claude/sendAgentMessage'] as SentMessage[])[0]?.id as string;

    const replyRes = await mutateAs(server, NOTES, {
      'claude/sendAgentMessage': {
        params: { to: SENDER, subject: 're: q', body: 'answer', inReplyTo: firstId },
        fields: { id: true, recipient: true, inReplyTo: true }
      }
    });
    const replyEnv = jsonBody<PackEnvelope>(replyRes);
    expect(replyEnv.errors).toBeUndefined();
    const reply = (
      replyEnv.data['claude/sendAgentMessage'] as Array<{
        id: string;
        recipient: string;
        inReplyTo: string;
      }>
    )[0];
    expect(reply?.recipient).toBe(peerId);
    expect(reply?.inReplyTo).toBe(firstId);
  });

  it('emits the recipient crossRef edge: deleting the identity nulls recipient', async () => {
    const { server, composed, stop } = await setup();
    cleanup = stop;
    const notesId = await makeIdentity(server, NOTES);

    const env = await send(server, SENDER, { to: NOTES, subject: 's', body: 'b' });
    expect(env.errors).toBeUndefined();
    const msgId = (env.data['claude/sendAgentMessage'] as SentMessage[])[0]?.id as string;

    await mutateAsOperator(server, {
      'claude/deleteAgentIdentity': { params: { id: notesId }, fields: { id: true } }
    });
    await composed.runSweepNow();

    const readEnv = jsonBody<PackEnvelope>(
      await query(server, {
        'claude/getAgentMessage': { params: { id: msgId }, fields: { id: true, recipient: true } }
      })
    );
    expect(readEnv.errors).toBeUndefined();
    const row = readEnv.data['claude/getAgentMessage'] as { recipient: string | null } | null;
    expect(row, 'message should survive recipient delete').not.toBeNull();
    expect(row?.recipient, 'recipient should be nulled by onDelete set_null').toBeNull();
  });
});

describe('claude/AgentMessage — retired direct write paths', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('refuses createAgentMessage — the mutation is not registered, not merely denied', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await mutateAs(server, SENDER, {
      'claude/createAgentMessage': {
        params: { subject: 's', body: 'b' },
        fields: { id: true }
      }
    });
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('unknown_name');
    expect(env.errors?.[0]?.message).toContain('createAgentMessage');
  });

  it('does not advertise createAgentMessage in the per-type schema surface', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({
      method: 'GET',
      path: `/substrate/v1/schema/${NS}/AgentMessage`,
      headers: { authorization: bearer(SENDER) }
    });
    const schema = jsonBody<{ mutations: Record<string, unknown> }>(res);
    const advertised = Object.keys(schema.mutations ?? {});
    expect(advertised).not.toContain('createAgentMessage');
    for (const name of [
      'getAgentMessage',
      'updateAgentMessage',
      'deleteAgentMessage',
      'sendAgentMessage',
      'ackAgentMessage'
    ]) {
      expect(advertised).toContain(name);
    }
  });

  it('denies updateAgentMessage on each transition field', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    const env = await send(server, SENDER, { to: NOTES, subject: 's', body: 'b' });
    const msgId = (env.data['claude/sendAgentMessage'] as SentMessage[])[0]?.id as string;

    for (const patch of [
      { status: 'read' },
      { ackedBy: 'forged-claude@host-a' },
      { ackedAt: '2026-06-10T00:00:00.000Z' }
    ]) {
      const res = await mutateAs(server, NOTES, {
        'claude/updateAgentMessage': { params: { id: msgId, ...patch }, fields: { id: true } }
      });
      const updEnv = jsonBody<PackEnvelope>(res);
      expect(updEnv.errors, `update with ${Object.keys(patch)[0]} must be denied`).toBeDefined();
      expect(updEnv.errors?.[0]?.code).toBe('policy_denied');
    }
  });

  // The writer's self-reported instance is set once, at send. Rewriting
  // it later would make the field say whatever the last editor wanted.
  it('denies updateAgentMessage on instance', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    const env = await send(server, SENDER, {
      to: NOTES,
      subject: 's',
      body: 'b',
      instance: 'session:1a2b3c4d'
    });
    const msgId = (env.data['claude/sendAgentMessage'] as SentMessage[])[0]?.id as string;
    const res = await mutateAs(server, NOTES, {
      'claude/updateAgentMessage': {
        params: { id: msgId, instance: 'session:forged' },
        fields: { id: true }
      }
    });
    const updEnv = jsonBody<PackEnvelope>(res);
    expect(updEnv.errors?.[0]?.code).toBe('policy_denied');
    expect(updEnv.errors?.[0]?.message).toContain('instance');
  });

  // Without the allow-list, an agent could redirect a message to its own
  // identity row and then ack it, or edit a delivered body.
  it('denies updateAgentMessage on recipient, subject, body and inReplyTo', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    const env = await send(server, SENDER, { to: NOTES, subject: 's', body: 'b' });
    const msgId = (env.data['claude/sendAgentMessage'] as SentMessage[])[0]?.id as string;

    for (const patch of [
      { recipient: msgId },
      { subject: 'rewritten' },
      { body: 'rewritten' },
      { inReplyTo: msgId }
    ]) {
      const field = Object.keys(patch)[0] as string;
      const res = await mutateAs(server, SENDER, {
        'claude/updateAgentMessage': { params: { id: msgId, ...patch }, fields: { id: true } }
      });
      const updEnv = jsonBody<PackEnvelope>(res);
      expect(updEnv.errors?.[0]?.code, `update with ${field} must be denied`).toBe('policy_denied');
      expect(updEnv.errors?.[0]?.message).toContain(`'${field}' is fixed at send`);
    }
  });

  it('still allows archive/tags edits via updateAgentMessage', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    const env = await send(server, SENDER, { to: NOTES, subject: 's', body: 'b' });
    const msgId = (env.data['claude/sendAgentMessage'] as SentMessage[])[0]?.id as string;

    const res = await mutateAs(server, NOTES, {
      'claude/updateAgentMessage': {
        params: { id: msgId, archived: true, tags: ['re: #282'] },
        fields: { id: true, archived: true }
      }
    });
    const updEnv = jsonBody<PackEnvelope>(res);
    expect(updEnv.errors).toBeUndefined();
    expect((updEnv.data['claude/updateAgentMessage'] as { archived: boolean }).archived).toBe(true);
  });
});

describe('claude/markAgentMessageRead + ackAgentMessage — recipient-only transitions', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  async function sendOne(server: MemorySubstrateServer): Promise<string> {
    const env = await send(server, SENDER, { to: NOTES, subject: 's', body: 'b' });
    expect(env.errors).toBeUndefined();
    return (env.data['claude/sendAgentMessage'] as SentMessage[])[0]?.id as string;
  }

  async function transition(
    server: MemorySubstrateServer,
    asKid: string,
    mutation: 'markAgentMessageRead' | 'ackAgentMessage',
    id: string
  ): Promise<PackEnvelope> {
    const res = await mutateAs(server, asKid, {
      [`claude/${mutation}`]: {
        params: { id },
        fields: { id: true, status: true, ackedBy: true, ackedAt: true }
      }
    });
    return jsonBody<PackEnvelope>(res);
  }

  it('recipient marks unread -> read', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    const msgId = await sendOne(server);

    const env = await transition(server, NOTES, 'markAgentMessageRead', msgId);
    expect(env.errors).toBeUndefined();
    const row = env.data['claude/markAgentMessageRead'] as SentMessage;
    expect(row.status).toBe('read');
    // Not acked yet — the attribution fields are unset (absent or null).
    expect(row.ackedBy ?? null).toBeNull();
  });

  it('recipient acks: status acked + ackedBy/ackedAt stamped server-side', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    const msgId = await sendOne(server);

    const env = await transition(server, NOTES, 'ackAgentMessage', msgId);
    expect(env.errors).toBeUndefined();
    const row = env.data['claude/ackAgentMessage'] as SentMessage;
    expect(row.status).toBe('acked');
    expect(row.ackedBy).toBe(NOTES);
    expect(row.ackedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(row.ackedAt as string))).toBe(false);
  });

  it('the sender cannot ack its own outbound message', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    const msgId = await sendOne(server);

    const env = await transition(server, SENDER, 'ackAgentMessage', msgId);
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('not_recipient');
  });

  it('a third party cannot mark read', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    const msgId = await sendOne(server);

    const env = await transition(server, BASELINE, 'markAgentMessageRead', msgId);
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('not_recipient');
  });

  it('re-ack is a no-op preserving the original attribution', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    const msgId = await sendOne(server);

    const first = await transition(server, NOTES, 'ackAgentMessage', msgId);
    const firstAckedAt = (first.data['claude/ackAgentMessage'] as SentMessage).ackedAt;

    const second = await transition(server, NOTES, 'ackAgentMessage', msgId);
    expect(second.errors).toBeUndefined();
    const row = second.data['claude/ackAgentMessage'] as SentMessage;
    expect(row.status).toBe('acked');
    expect(row.ackedAt).toBe(firstAckedAt);
  });

  it('markRead on an acked message does not downgrade status', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);
    const msgId = await sendOne(server);

    await transition(server, NOTES, 'ackAgentMessage', msgId);
    const env = await transition(server, NOTES, 'markAgentMessageRead', msgId);
    expect(env.errors).toBeUndefined();
    expect((env.data['claude/markAgentMessageRead'] as SentMessage).status).toBe('acked');
  });

  it('returns null on an unknown message id (autoCRUD id-miss contract)', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    await makeIdentity(server, NOTES);

    const env = await transition(
      server,
      NOTES,
      'ackAgentMessage',
      '00000000-0000-0000-0000-000000000000'
    );
    expect(env.errors).toBeUndefined();
    expect(env.data['claude/ackAgentMessage']).toBeNull();
  });

  it('rejects a transition on a message whose recipient was nulled by set_null', async () => {
    const { server, composed, stop } = await setup();
    cleanup = stop;
    const notesId = await makeIdentity(server, NOTES);
    const msgId = await sendOne(server);

    await mutateAsOperator(server, {
      'claude/deleteAgentIdentity': { params: { id: notesId }, fields: { id: true } }
    });
    await composed.runSweepNow();

    const env = await transition(server, NOTES, 'ackAgentMessage', msgId);
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('no_recipient');
  });
});

// ---- only the parties involved, or an operator ----
describe('row-level authority: mail participants and identity self-edits', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) await cleanup();
    cleanup = null;
  });

  const BYSTANDER = 'bystander-claude@host-a';

  async function messageTo(server: MemorySubstrateServer): Promise<string> {
    await makeIdentity(server, NOTES);
    const env = await send(server, SENDER, { to: NOTES, subject: 's', body: 'b' });
    return (env.data['claude/sendAgentMessage'] as SentMessage[])[0]?.id as string;
  }

  const errorCode = (res: SubstrateResponse) => jsonBody<PackEnvelope>(res).errors?.[0]?.code;

  it('a bystander can neither archive nor delete mail between two other agents', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const msgId = await messageTo(server);
    expect(
      errorCode(
        await mutateAs(server, BYSTANDER, {
          'claude/updateAgentMessage': {
            params: { id: msgId, archived: true },
            fields: { id: true }
          }
        })
      )
    ).toBe('not_participant');
    expect(
      errorCode(
        await mutateAs(server, BYSTANDER, {
          'claude/deleteAgentMessage': { params: { id: msgId }, fields: { id: true } }
        })
      )
    ).toBe('not_participant');
  });

  it('the recipient and the sender may archive; an operator may delete', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const msgId = await messageTo(server);
    for (const who of [NOTES, SENDER]) {
      const res = await mutateAs(server, who, {
        'claude/updateAgentMessage': { params: { id: msgId, tags: [who] }, fields: { id: true } }
      });
      expect(jsonBody<PackEnvelope>(res).errors, `${who} may retag`).toBeUndefined();
    }
    const del = await mutateAsOperator(server, {
      'claude/deleteAgentMessage': { params: { id: msgId }, fields: { id: true } }
    });
    expect(jsonBody<PackEnvelope>(del).errors).toBeUndefined();
  });

  it('only the identity itself may edit its row; nobody else may deactivate it', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const notesId = await makeIdentity(server, NOTES);
    expect(
      errorCode(
        await mutateAs(server, BYSTANDER, {
          'claude/updateAgentIdentity': {
            params: { id: notesId, active: false },
            fields: { id: true }
          }
        })
      )
    ).toBe('not_self');
    const self = await mutateAs(server, NOTES, {
      'claude/updateAgentIdentity': {
        params: { id: notesId, roaming: true },
        fields: { id: true }
      }
    });
    expect(jsonBody<PackEnvelope>(self).errors).toBeUndefined();
  });

  it('kid changes and identity deletes are operator-only, even on your own row', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const notesId = await makeIdentity(server, NOTES);
    expect(
      errorCode(
        await mutateAs(server, NOTES, {
          'claude/updateAgentIdentity': {
            params: { id: notesId, kid: 'renamed@host-a' },
            fields: { id: true }
          }
        })
      )
    ).toBe('operator_only');
    expect(
      errorCode(
        await mutateAs(server, NOTES, {
          'claude/deleteAgentIdentity': { params: { id: notesId }, fields: { id: true } }
        })
      )
    ).toBe('operator_only');
    const renamed = await mutateAsOperator(server, {
      'claude/updateAgentIdentity': {
        params: { id: notesId, kid: 'renamed@host-a' },
        fields: { id: true, kid: true }
      }
    });
    expect(jsonBody<PackEnvelope>(renamed).errors).toBeUndefined();
  });
});
