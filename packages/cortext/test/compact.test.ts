import type { EngineHandle, PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import { makeCtx } from '@mnmal-ai/substrate/sdk';
import {
  type ComposeResult,
  compose,
  MemoryDataset,
  MemorySubstrateServer
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { type CompactResult, registerCompactRoute, runCompact } from '../src/compact.js';
import type { CortextAuthConfig } from '../src/index.js';
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

interface Harness {
  server: MemorySubstrateServer;
  engine: EngineHandle;
  stop: () => Promise<void>;
}

async function setup(retention = 3, auth?: CortextAuthConfig): Promise<Harness> {
  const server = new MemorySubstrateServer();
  const defaultDataset = new MemoryDataset({ namespace: 'default' });
  const claudeDataset = new MemoryDataset({ namespace: NS });
  const architectureDataset = new MemoryDataset({ namespace: 'architecture' });
  const plugin = buildClaudeForTest({
    namespace: NS,
    compactRetention: retention,
    ...(auth !== undefined ? { auth } : {})
  });
  const composed: ComposeResult = await compose({
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
    engine: composed.engine,
    stop: async (): Promise<void> => {
      await composed.stop();
    }
  };
}

type IdValue = string;

async function createSession(
  server: MemorySubstrateServer,
  branch: string,
  id?: string,
  project?: string
): Promise<{ id: IdValue }> {
  const params: Record<string, unknown> = {
    branch,
    startedAt: '2026-04-18T00:00:00Z',
    summary: `session ${branch}`,
    decisionsCount: 0,
    packages: '',
    archived: false
  };
  if (id !== undefined) params.id = id;
  if (project !== undefined) params.project = project;
  const res = await server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(
      JSON.stringify({
        [`${NS}/createSessionLog`]: {
          params,
          fields: { id: true }
        }
      })
    )
  });
  const env = jsonBody<PackEnvelope>(res);
  const created = env.data[`${NS}/createSessionLog`] as { id: IdValue };
  return { id: created.id };
}

/** Each Decision's archived flag, read back by id. */
async function archivedFlags(
  server: MemorySubstrateServer,
  ids: IdValue[]
): Promise<Map<string, boolean>> {
  const res = await server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(
      JSON.stringify({
        [`${NS}/Decision`]: {
          params: { where: { id: { in: ids.map(String) } } },
          fields: { id: true, archived: true }
        }
      })
    )
  });
  const rows = jsonBody<PackEnvelope>(res).data[`${NS}/Decision`] as Array<{
    id: string;
    archived: boolean;
  }>;
  return new Map(rows.map((r) => [String(r.id), r.archived]));
}

async function createDecision(
  server: MemorySubstrateServer,
  sessionId: string,
  opts: { supersedes?: string } = {}
): Promise<{ id: IdValue }> {
  const params: Record<string, unknown> = {
    topic: 'topic',
    choice: 'choice',
    rationale: 'why',
    sessionId,
    status: 'active',
    revisitWhen: '',
    archived: false
  };
  if (opts.supersedes !== undefined) params.supersedes = opts.supersedes;
  const res = await server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(
      JSON.stringify({
        [`${NS}/createDecision`]: { params, fields: { id: true } }
      })
    )
  });
  const env = jsonBody<PackEnvelope>(res);
  const created = env.data[`${NS}/createDecision`] as { id: IdValue };
  return { id: created.id };
}

async function listRows<T>(
  server: MemorySubstrateServer,
  typeName: string,
  fields: Record<string, true>
): Promise<Array<T>> {
  const res = await server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(
      JSON.stringify({
        [`${NS}/${typeName}`]: { params: {}, fields }
      })
    )
  });
  const env = jsonBody<PackEnvelope>(res);
  const rows = env.data[`${NS}/${typeName}`];
  return (rows ?? []) as Array<T>;
}

describe('runCompact', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.stop();
      harness = null;
    }
  });

  it('returns zeros on an empty store', async () => {
    harness = await setup();
    const result: CompactResult = await runCompact(harness.engine, NS, 7, false);
    expect(result).toEqual({
      dryRun: false,
      sessionsArchived: 0,
      decisionsArchived: 0,
      sessionsRetained: 0,
      messagesArchived: 0
    });
  });

  // Acked fan-out mail accumulates in the mailbox scan
  // forever without an archive policy. Compact sweeps acked, unarchived
  // AgentMessage rows older than the mail window (updatedAt-based; the ack
  // is the last transition, so updatedAt ≈ ackedAt). `mailMaxAgeMs` is
  // injectable because _metadata timestamps are server-stamped — tests
  // can't author old mail, so they push the cutoff into the future instead
  // (a zero window races the strict `lt` when ack and compact share a ms).
  describe('mailbox sweep', () => {
    const SENDER = {
      id: 'peer-claude@host-a',
      agentKeyId: 'peer-claude@host-a',
      grants: { '*': ['read', 'mutate'] }
    };
    const RECIPIENT_KID = 'notes-claude@host-a';
    const RECIPIENT = {
      id: RECIPIENT_KID,
      agentKeyId: RECIPIENT_KID,
      grants: { '*': ['read', 'mutate'] }
    };

    async function makeIdentity(server: MemorySubstrateServer, kid: string): Promise<void> {
      await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            [`${NS}/createAgentIdentity`]: {
              params: { kid, host: 'host-a' },
              fields: { id: true }
            }
          })
        )
      });
    }

    async function sendMail(engine: EngineHandle, subject: string): Promise<string> {
      const env = await engine.mutate({
        frame: {
          [`${NS}/sendAgentMessage`]: {
            params: { to: RECIPIENT_KID, subject, body: 'b' },
            fields: { id: true }
          }
        },
        ctx: { ...makeCtx(NS, 'mutate'), identity: SENDER }
      });
      expect(env.errors).toBeUndefined();
      const rows = env.data[`${NS}/sendAgentMessage`] as Array<{ id: string }>;
      return rows[0]?.id as string;
    }

    async function ackMail(engine: EngineHandle, id: string): Promise<void> {
      const env = await engine.mutate({
        frame: { [`${NS}/ackAgentMessage`]: { params: { id }, fields: { id: true } } },
        ctx: { ...makeCtx(NS, 'mutate'), identity: RECIPIENT }
      });
      expect(env.errors).toBeUndefined();
    }

    it('archives acked mail older than the window; unread mail untouched', async () => {
      harness = await setup();
      await makeIdentity(harness.server, RECIPIENT_KID);
      const ackedId = await sendMail(harness.engine, 'old acked');
      await ackMail(harness.engine, ackedId);
      const unreadId = await sendMail(harness.engine, 'still unread');

      const result = await runCompact(harness.engine, NS, 7, false, { mailMaxAgeMs: -60_000 });
      expect(result.messagesArchived).toBe(1);

      const rows = await listRows<{ id: IdValue; archived: boolean }>(
        harness.server,
        'AgentMessage',
        { id: true, archived: true }
      );
      expect(rows.find((r) => r.id === ackedId)?.archived).toBe(true);
      expect(rows.find((r) => r.id === unreadId)?.archived).toBe(false);
    });

    it('leaves fresh acked mail alone under the default 30d window', async () => {
      harness = await setup();
      await makeIdentity(harness.server, RECIPIENT_KID);
      const ackedId = await sendMail(harness.engine, 'freshly acked');
      await ackMail(harness.engine, ackedId);

      const result = await runCompact(harness.engine, NS, 7, false);
      expect(result.messagesArchived).toBe(0);
    });

    it('dryRun counts without writing', async () => {
      harness = await setup();
      await makeIdentity(harness.server, RECIPIENT_KID);
      const ackedId = await sendMail(harness.engine, 'dry');
      await ackMail(harness.engine, ackedId);

      const result = await runCompact(harness.engine, NS, 7, true, { mailMaxAgeMs: -60_000 });
      expect(result.messagesArchived).toBe(1);

      const rows = await listRows<{ id: IdValue; archived: boolean }>(
        harness.server,
        'AgentMessage',
        { id: true, archived: true }
      );
      expect(rows.find((r) => r.id === ackedId)?.archived).toBe(false);
    });
  });

  it('archives sessions past the retention window (5 sessions, retention=3)', async () => {
    harness = await setup(3);
    // Use UUIDv4-style strings; lexicographic order matches insertion order here
    const ids = [
      'aaaaaaaa-0001-4000-8000-000000000001',
      'aaaaaaaa-0002-4000-8000-000000000002',
      'aaaaaaaa-0003-4000-8000-000000000003',
      'aaaaaaaa-0004-4000-8000-000000000004',
      'aaaaaaaa-0005-4000-8000-000000000005'
    ];
    for (let i = 0; i < 5; i++) {
      await createSession(harness.server, `b${i + 1}`, ids[i]);
    }

    const result = await runCompact(harness.engine, NS, 3, false);
    expect(result.sessionsRetained).toBe(3);
    expect(result.sessionsArchived).toBe(2);

    const rows = await listRows<{ id: IdValue; archived: boolean }>(harness.server, 'SessionLog', {
      id: true,
      archived: true
    });
    const archivedRows = rows.filter((r) => r.archived);
    expect(archivedRows).toHaveLength(2);
  });

  // Retention must keep the NEWEST sessions by
  // _metadata.createdAt, not whatever sorts last lexically. UUIDv4 ids are
  // random — lexical order is unrelated to age, so an id-sorted window
  // archives an arbitrary set. These ids deliberately INVERT creation order
  // lexically: the oldest session sorts last (would be wrongly retained by
  // an id sort) and the newest sorts first (would be wrongly archived).
  it('retains by creation time, not lexical id order', async () => {
    harness = await setup(2);
    const idsOldestFirst = [
      'zzzzzzzz-0001-4000-8000-000000000001', // oldest — must be archived
      'mmmmmmmm-0002-4000-8000-000000000002', // middle — retained (retention=2)
      'aaaaaaaa-0003-4000-8000-000000000003' // newest — retained
    ];
    for (const id of idsOldestFirst) {
      await createSession(harness.server, `b-${id.slice(0, 1)}`, id);
      // Force distinct createdAt stamps (server clock has ms resolution).
      await new Promise((r) => setTimeout(r, 5));
    }

    const result = await runCompact(harness.engine, NS, 2, false);
    expect(result.sessionsRetained).toBe(2);
    expect(result.sessionsArchived).toBe(1);

    const rows = await listRows<{ id: IdValue; archived: boolean }>(harness.server, 'SessionLog', {
      id: true,
      archived: true
    });
    const archived = rows.filter((r) => r.archived).map((r) => r.id);
    expect(archived, 'the OLDEST session must be the archived one').toEqual([idsOldestFirst[0]]);
  });

  it('archives 3 sessions when 10 are present and retention=7', async () => {
    harness = await setup(7);
    for (let i = 1; i <= 10; i++) {
      const paddedId = `aaaaaaaa-${String(i).padStart(4, '0')}-4000-8000-000000000000`;
      await createSession(harness.server, `b${i}`, paddedId);
    }
    const result = await runCompact(harness.engine, NS, 7, false);
    expect(result.sessionsArchived).toBe(3);
    expect(result.sessionsRetained).toBe(7);
  });

  // The reads now filter archived server-side, so the
  // retention window means "newest N LIVE sessions" — an already-archived row
  // neither consumes a slot nor gets re-fetched just to be discarded.
  it('already-archived sessions do not consume retention slots', async () => {
    harness = await setup(2);
    const oldest = await createSession(
      harness.server,
      'oldest',
      'cccccccc-0001-4000-8000-000000000001'
    );
    await new Promise((r) => setTimeout(r, 5));
    await createSession(harness.server, 'middle', 'cccccccc-0002-4000-8000-000000000002');
    await new Promise((r) => setTimeout(r, 5));
    const newest = await createSession(
      harness.server,
      'newest',
      'cccccccc-0003-4000-8000-000000000003'
    );

    // Pre-archive the NEWEST session. Under the old read-everything shape it
    // would occupy a retention slot and push `oldest` out of the window.
    await harness.server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/updateSessionLog`]: {
            params: { id: newest.id, archived: true },
            fields: { id: true }
          }
        })
      )
    });

    const result = await runCompact(harness.engine, NS, 2, false);
    expect(result.sessionsRetained).toBe(2);
    expect(result.sessionsArchived).toBe(0);

    const rows = await listRows<{ id: IdValue; archived: boolean }>(harness.server, 'SessionLog', {
      id: true,
      archived: true
    });
    expect(
      rows.find((r) => r.id === oldest.id)?.archived,
      'the oldest LIVE session stays inside the window'
    ).toBe(false);
  });

  it('cascades the archive flag onto decisions whose session was archived', async () => {
    harness = await setup(2);
    const s1 = await createSession(
      harness.server,
      'oldest',
      'bbbbbbbb-0001-4000-8000-000000000001'
    );
    const s2 = await createSession(
      harness.server,
      'middle',
      'bbbbbbbb-0002-4000-8000-000000000002'
    );
    const s3 = await createSession(
      harness.server,
      'newest',
      'bbbbbbbb-0003-4000-8000-000000000003'
    );
    await createDecision(harness.server, s1.id); // attached to oldest — will be archived
    await createDecision(harness.server, s2.id); // retained
    await createDecision(harness.server, s3.id); // retained

    const result = await runCompact(harness.engine, NS, 2, false);
    expect(result.sessionsArchived).toBe(1);
    expect(result.decisionsArchived).toBe(1);

    const decisions = await listRows<{ sessionId: IdValue; archived: boolean }>(
      harness.server,
      'Decision',
      { id: true, sessionId: true, archived: true }
    );
    const archived = decisions.filter((d) => d.archived);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.sessionId).toBe(s1.id);
  });

  it('cascade-archives a Decision whose UUID-string sessionId points at an archived SessionLog', async () => {
    harness = await setup(1);
    const slUuid = 'cccccccc-0001-4000-8000-000000000001';
    const slNewer = 'cccccccc-0002-4000-8000-000000000002';
    await createSession(harness.server, 'older-session', slUuid);
    await createSession(harness.server, 'newer-session', slNewer);
    await createDecision(harness.server, slUuid); // sessionId is a UUID string

    const result = await runCompact(harness.engine, NS, 1, false);
    expect(result.sessionsArchived).toBe(1);
    expect(result.decisionsArchived).toBe(1);

    const decisions = await listRows<{ sessionId: string; archived: boolean }>(
      harness.server,
      'Decision',
      { id: true, sessionId: true, archived: true }
    );
    const archived = decisions.filter((d) => d.archived);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.sessionId).toBe(slUuid);
  });

  // `supersedes` sits on the NEWER decision and names the older one,
  // so the OLDER one retires. Counting archived rows alone would pass while
  // compaction archived the wrong one.
  it('archives the decision that supersedes NAMES, not the one carrying it', async () => {
    harness = await setup(5);
    const s1 = await createSession(harness.server, 'only', 'dddddddd-0001-4000-8000-000000000001');
    const older = await createDecision(harness.server, s1.id);
    const newer = await createDecision(harness.server, s1.id, { supersedes: String(older.id) });

    const result = await runCompact(harness.engine, NS, 5, false);
    expect(result.sessionsArchived).toBe(0);
    expect(result.decisionsArchived).toBe(1);
    const archived = await archivedFlags(harness.server, [older.id, newer.id]);
    expect(archived.get(String(older.id))).toBe(true);
    expect(archived.get(String(newer.id))).toBe(false);
  });

  it('keeps the newest sessions PER PROJECT, so a busy project cannot empty a quiet one', async () => {
    harness = await setup(2);
    // Oldest first: the quiet project's two sessions predate the busy one's four.
    await createSession(harness.server, 'q1', 'eeeeeeee-0001-4000-8000-000000000001', 'quiet');
    await createSession(harness.server, 'q2', 'eeeeeeee-0002-4000-8000-000000000002', 'quiet');
    for (let n = 3; n <= 6; n++) {
      await createSession(
        harness.server,
        `b${n}`,
        `eeeeeeee-000${n}-4000-8000-00000000000${n}`,
        'busy'
      );
    }
    const result = await runCompact(harness.engine, NS, 2, false);
    // busy keeps 2 of 4; quiet keeps both of its 2.
    expect(result.sessionsArchived).toBe(2);
    expect(result.sessionsRetained).toBe(4);
  });

  it('batches archive writes — one engine.mutate call per type with array frame', async () => {
    harness = await setup(2);
    const ids = [
      'fafafafa-0001-4000-8000-000000000001',
      'fafafafa-0002-4000-8000-000000000002',
      'fafafafa-0003-4000-8000-000000000003',
      'fafafafa-0004-4000-8000-000000000004',
      'fafafafa-0005-4000-8000-000000000005'
    ];
    for (const id of ids) await createSession(harness.server, `b-${id.slice(0, 8)}`, id);
    // Decisions on the 3 sessions that will be archived (oldest 3 lex-ids)
    for (const id of ids.slice(0, 3)) await createDecision(harness.server, id);

    const mutateCalls: Array<{
      keys: string[];
      shape: 'array' | 'single';
      arrayLength: number;
    }> = [];
    const real = harness.engine;
    const spy: EngineHandle = {
      query: real.query.bind(real),
      invalidateSchemaCaches: real.invalidateSchemaCaches.bind(real),
      addNamespace: real.addNamespace.bind(real),
      tombstoneNamespace: real.tombstoneNamespace.bind(real),
      removeNamespace: real.removeNamespace.bind(real),
      namespaceState: real.namespaceState.bind(real),
      onNamespaceTombstoned: real.onNamespaceTombstoned.bind(real),
      addDropParticipant: real.addDropParticipant.bind(real),
      dropParticipants: real.dropParticipants.bind(real),
      createRegistry: real.createRegistry.bind(real),
      datasetFor: real.datasetFor.bind(real),
      evaluateReadPolicy: real.evaluateReadPolicy.bind(real),
      mutate: async (input) => {
        const keys = Object.keys(input.frame);
        const first = keys[0];
        const entry = first ? input.frame[first] : undefined;
        mutateCalls.push({
          keys,
          shape: Array.isArray(entry) ? 'array' : 'single',
          arrayLength: Array.isArray(entry) ? entry.length : -1
        });
        return real.mutate(input);
      }
    };

    const result = await runCompact(spy, NS, 2, false);
    expect(result.sessionsArchived).toBe(3);
    expect(result.decisionsArchived).toBe(3);

    // Two mutate calls, both batched arrays — collapses 6 round-trips into 2.
    expect(mutateCalls).toHaveLength(2);
    for (const c of mutateCalls) {
      expect(c.shape).toBe('array');
      expect(c.arrayLength).toBe(3);
      expect(c.keys).toHaveLength(1);
    }
    // Decisions first, then sessions: a failure between the two is
    // recomputed by the next run rather than losing the cascade.
    expect(mutateCalls[0]?.keys[0]).toBe(`${NS}/updateDecision`);
    expect(mutateCalls[1]?.keys[0]).toBe(`${NS}/updateSessionLog`);
  });

  it('leaves archived flags untouched when dryRun is true', async () => {
    harness = await setup(1);
    await createSession(harness.server, 'a', 'eeeeeeee-0001-4000-8000-000000000001');
    await createSession(harness.server, 'b', 'eeeeeeee-0002-4000-8000-000000000002');

    const result = await runCompact(harness.engine, NS, 1, true);
    expect(result.dryRun).toBe(true);
    expect(result.sessionsArchived).toBe(1);

    const rows = await listRows<{ archived: boolean }>(harness.server, 'SessionLog', {
      id: true,
      archived: true
    });
    expect(rows.every((r) => !r.archived)).toBe(true);
  });

  it('archives under writes=identity — internal writes carry the system envelope', async () => {
    harness = await setup(1, { reads: 'open', writes: 'identity', deletes: 'identity' });

    // Anonymous HTTP creates are gated under this posture; seed the way other
    // internal callers do — engine.mutate with an explicit system identity.
    for (const [i, branch] of (['a', 'b'] as const).entries()) {
      const env = await harness.engine.mutate({
        frame: {
          [`${NS}/createSessionLog`]: {
            params: {
              id: `abababab-000${i + 1}-4000-8000-00000000000${i + 1}`,
              branch,
              startedAt: '2026-06-06T00:00:00Z',
              summary: `session ${branch}`,
              decisionsCount: 0,
              packages: '',
              archived: false
            },
            fields: { id: true }
          }
        },
        ctx: {
          ...makeCtx(NS, 'mutate'),
          identity: { kind: 'system', id: 'test-seed', grants: { '*': ['read', 'mutate'] } }
        }
      });
      expect(env.errors).toBeUndefined();
    }

    const result = await runCompact(harness.engine, NS, 1, false);
    expect(result.sessionsArchived).toBe(1);

    // The archive must have actually LANDED — not been policy-denied and
    // silently swallowed. Reads are open in this posture, query anonymously.
    const rows = await listRows<{ archived: boolean }>(harness.server, 'SessionLog', {
      id: true,
      archived: true
    });
    expect(rows.filter((r) => r.archived)).toHaveLength(1);
  });

  it('surfaces mutate envelope errors instead of swallowing them', async () => {
    harness = await setup(1);
    await createSession(harness.server, 'a', 'acacacac-0001-4000-8000-000000000001');
    await createSession(harness.server, 'b', 'acacacac-0002-4000-8000-000000000002');

    const real = harness.engine;
    const spy: EngineHandle = {
      query: real.query.bind(real),
      invalidateSchemaCaches: real.invalidateSchemaCaches.bind(real),
      addNamespace: real.addNamespace.bind(real),
      tombstoneNamespace: real.tombstoneNamespace.bind(real),
      removeNamespace: real.removeNamespace.bind(real),
      namespaceState: real.namespaceState.bind(real),
      onNamespaceTombstoned: real.onNamespaceTombstoned.bind(real),
      addDropParticipant: real.addDropParticipant.bind(real),
      dropParticipants: real.dropParticipants.bind(real),
      createRegistry: real.createRegistry.bind(real),
      datasetFor: real.datasetFor.bind(real),
      evaluateReadPolicy: real.evaluateReadPolicy.bind(real),
      mutate: async () =>
        ({
          data: {},
          errors: [{ message: 'policy denied', code: 'policy_denied', path: [] }]
        }) as unknown as PackEnvelope
    };

    await expect(runCompact(spy, NS, 1, false)).rejects.toThrow(/policy denied/);
  });

  // `grants` is required on Identity; an empty `grants: {}` would refuse
  // every call, because `grantOf` returns `{}`.
  //
  // The grant is scoped to the ONE namespace compaction writes. Every archive
  // goes through `mutateBatch` with that `ns`, so `'*'` would claim authority
  // this actor never uses. `admin` because archiving other agents' acked
  // mail is an operator act, and this is the maintenance actor.
  it('writes as a system actor granted read+mutate+admin on its own namespace only', async () => {
    harness = await setup(1);
    await createSession(harness.server, 'a', 'acacacac-0003-4000-8000-000000000003');
    await createSession(harness.server, 'b', 'acacacac-0004-4000-8000-000000000004');

    const real = harness.engine;
    const seen: unknown[] = [];
    const spy: EngineHandle = {
      query: real.query.bind(real),
      invalidateSchemaCaches: real.invalidateSchemaCaches.bind(real),
      addNamespace: real.addNamespace.bind(real),
      tombstoneNamespace: real.tombstoneNamespace.bind(real),
      removeNamespace: real.removeNamespace.bind(real),
      namespaceState: real.namespaceState.bind(real),
      onNamespaceTombstoned: real.onNamespaceTombstoned.bind(real),
      addDropParticipant: real.addDropParticipant.bind(real),
      dropParticipants: real.dropParticipants.bind(real),
      createRegistry: real.createRegistry.bind(real),
      datasetFor: real.datasetFor.bind(real),
      evaluateReadPolicy: real.evaluateReadPolicy.bind(real),
      mutate: async (args) => {
        seen.push(args.ctx?.identity);
        return real.mutate(args);
      }
    };

    const result = await runCompact(spy, NS, 1, false);
    expect(result.sessionsArchived).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    for (const identity of seen) {
      expect((identity as { grants?: unknown }).grants).toEqual({
        [NS]: ['read', 'mutate', 'admin']
      });
    }
  });
});

describe('registerCompactRoute', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.stop();
      harness = null;
    }
  });

  it('serves POST /substrate/v1/plugins/cortext/compact and returns a CompactResult', async () => {
    harness = await setup(1);
    await createSession(harness.server, 'a', 'ffffffff-0001-4000-8000-000000000001');
    await createSession(harness.server, 'b', 'ffffffff-0002-4000-8000-000000000002');

    const res = await harness.server.inject({
      method: 'POST',
      path: '/substrate/v1/plugins/cortext/compact',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ dryRun: true }))
    });
    expect(res.status).toBe(200);
    const result = jsonBody<CompactResult>(res);
    expect(result.dryRun).toBe(true);
    expect(result.sessionsArchived).toBe(1);
  });

  it.each([['{"dryRun":"true"}'], ['{"dry_run":true}'], ['[true]']])(
    'refuses a malformed body %s instead of running a live compaction',
    async (raw) => {
      harness = await setup(1);
      await createSession(harness.server, 'a', 'ffffffff-0001-4000-8000-000000000001');
      await createSession(harness.server, 'b', 'ffffffff-0002-4000-8000-000000000002');
      const res = await harness.server.inject({
        method: 'POST',
        path: '/substrate/v1/plugins/cortext/compact',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(raw)
      });
      expect(res.status).toBe(400);
      expect(jsonBody<{ code: string }>(res).code).toBe('bad_request');
    }
  );

  // The route runs as the system actor, so under gated writes it
  // checks its own caller: only an operator may compact.
  it('under gated writes, refuses a non-operator and admits an operator', async () => {
    harness = await setup(1, { reads: 'open', writes: 'identity', deletes: 'identity' });
    const anon = await harness.server.inject({
      method: 'POST',
      path: '/substrate/v1/plugins/cortext/compact',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ dryRun: true }))
    });
    expect(anon.status).toBe(403);
    expect(jsonBody<{ code: string }>(anon).code).toBe('operator_only');

    let handler: ((req: unknown) => Promise<SubstrateResponse>) | null = null;
    const router = {
      post: (_path: string, h: (req: unknown) => Promise<SubstrateResponse>) => {
        handler = h;
      }
    };
    registerCompactRoute(
      router as never,
      { engine: harness.engine, pluginName: 'cortext', metric: () => {} } as never,
      1,
      NS,
      { reads: 'open', writes: 'identity', deletes: 'identity' }
    );
    const body = Buffer.from(JSON.stringify({ dryRun: true }));
    const agent = await handler!({
      body,
      identity: { id: 'a@h', grants: { [NS]: ['read', 'mutate'] } }
    });
    expect(agent.status).toBe(403);
    const operator = await handler!({
      body,
      identity: { id: 'op@h', grants: { [NS]: ['read', 'mutate', 'admin'] } }
    });
    expect(operator.status).toBe(200);
  });

  it('rejects malformed JSON with a 400 and a bad_request code', async () => {
    harness = await setup();

    const res = await harness.server.inject({
      method: 'POST',
      path: '/substrate/v1/plugins/cortext/compact',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{not json')
    });
    expect(res.status).toBe(400);
    const body = jsonBody<{ code: string; message: string }>(res);
    expect(body.code).toBe('bad_request');
    expect(typeof body.message).toBe('string');
  });
});
