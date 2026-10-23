import type { SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import {
  type ComposeResult,
  compose,
  MemoryDataset,
  MemorySubstrateServer
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TODO_LIFECYCLE_VOCAB,
  TODO_PRIORITY_VOCAB,
  TODO_RESOLUTION_VOCAB
} from '../src/kernel/index.js';
import {
  AGENT_MESSAGE_STATUS_VOCAB,
  CLAUDE_TYPE_NAMES,
  DECISION_STATUS_ALIASES,
  DECISION_STATUS_VOCAB
} from '../src/namespace.js';
import { buildClaudeForTest } from './_helpers.js';

/** Independent recomputation of the onboard union format, to lock single-source. */
function expectedVocabUnion(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(' | ');
}

const NS = 'claude';
const PATH = '/substrate/v1/plugins/cortext/onboard';

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

interface OnboardBody {
  plugin: string;
  namespace: string;
  description: string;
  retention: number;
  types: Record<string, { purpose: string; fields: Record<string, string> }>;
  mutations: Record<string, Array<string>>;
  endpoints: {
    query: { method: string; path: string };
    mutate: { method: string; path: string };
    compact: { method: string; path: string };
    ws: { path: string; namespace: string };
  };
  contextLoading: {
    onSessionStart: {
      surfaceToUser: Array<string>;
      query: Record<string, { params: unknown; fields: Record<string, boolean> }>;
    };
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
  const plugin = buildClaudeForTest({ namespace: NS, compactRetention: 5 });
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
    stop: async (): Promise<void> => {
      await composed.stop();
    }
  };
}

describe('registerOnboardRoute', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('serves GET /substrate/v1/plugins/cortext/onboard with a 200 and JSON content-type', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({ method: 'GET', path: PATH });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toContain('application/json');
  });

  it('includes the expected plugin / namespace / retention / endpoint fields', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({ method: 'GET', path: PATH });
    const body = jsonBody<OnboardBody>(res);
    expect(body.plugin).toBe('cortext');
    expect(body.namespace).toBe(NS);
    expect(body.retention).toBe(5);
    expect(body.endpoints.query.path).toBe('/substrate/v1/query');
    expect(body.endpoints.mutate.path).toBe('/substrate/v1/mutate');
    expect(body.endpoints.compact.path).toBe('/substrate/v1/plugins/cortext/compact');
    expect(body.endpoints.ws.path).toBe('/substrate/v1/ws');
    expect(body.endpoints.ws.namespace).toBe(NS);
    expect(body.types.SessionLog).toBeDefined();
    expect(body.types.Decision).toBeDefined();
    expect(body.types.Todo).toBeDefined();
    expect(body.mutations.SessionLog).toContain('createSessionLog');
  });

  it('is idempotent — repeated GETs return byte-identical bodies', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const first = await server.inject({ method: 'GET', path: PATH });
    const second = await server.inject({ method: 'GET', path: PATH });
    expect(bodyToString(first)).toBe(bodyToString(second));
  });

  it('FK-shaped fields are documented as UUID crossRefs, not numeric ids', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({ method: 'GET', path: PATH });
    const body = jsonBody<OnboardBody>(res);
    const decision = body.types.Decision;
    if (decision === undefined) {
      throw new Error('Decision type should be present in onboard surface');
    }
    const fields = decision.fields;
    // Field-kind prefixes (`string — `, `number — `) intentionally dropped
    // — kind lives in the FieldDef registry / /substrate/v1/schema. The
    // onboard surface carries only the human description, which for FK fields
    // must call out the crossRef shape.
    expect(fields.sessionId).toMatch(/UUID.*crossRef/i);
    expect(fields.supersedes).toMatch(/UUID.*crossRef/i);
  });

  it('Todo status/priority vocab is derived from the kernel single source', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({ method: 'GET', path: PATH });
    const body = jsonBody<OnboardBody>(res);
    const todo = body.types.Todo;
    if (todo === undefined) {
      throw new Error('Todo type should be present in onboard surface');
    }
    // Onboard descriptions are derived verbatim from the exported vocab, so the
    // self-description can't drift from the field.enum + pg CHECK that enforce it.
    expect(todo.fields.status?.startsWith(expectedVocabUnion(TODO_LIFECYCLE_VOCAB))).toBe(true);
    expect(todo.fields.priority).toBe(expectedVocabUnion(TODO_PRIORITY_VOCAB));
    // The closing words an agent reaches for are taught, with what they mean.
    expect(todo.fields.status).toContain("'done' → 'closed'");
    expect(todo.fields.resolution?.startsWith(expectedVocabUnion(TODO_RESOLUTION_VOCAB))).toBe(
      true
    );
  });

  it('Decision.status is presented as an OPEN vocabulary, not a closed union', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({ method: 'GET', path: PATH });
    const body = jsonBody<OnboardBody>(res);
    const decision = body.types.Decision;
    if (decision === undefined) {
      throw new Error('Decision type should be present in onboard surface');
    }
    // Derived from DECISION_STATUS_VOCAB so the description cannot drift from
    // the constant, but not as a union: a union reads as a closed set, and
    // agents who believe the set is closed invent synonyms rather than
    // reporting that no declared word fits.
    expect(decision.fields.status).toBe(
      `open vocabulary, not enforced; states this vocabulary documents (not a reading of what is stored): ${DECISION_STATUS_VOCAB.join(', ')}; synonyms normalised by the server: ${Object.entries(
        DECISION_STATUS_ALIASES
      )
        .map(([a, c]) => `'${a}' → '${c}'`)
        .join(', ')}`
    );
    expect(decision.fields.status).not.toBe(expectedVocabUnion(DECISION_STATUS_VOCAB));
  });

  // "states in use: ..." would be a claim ABOUT THE STORE rendered from a
  // hand-maintained constant that nothing reconciles against it. This is the
  // surface that teaches an agent the taxonomy, so a false reading of the
  // store here is the likeliest source of the next undeclared synonym.
  //
  // The evidence is not reachable at this form site: `buildBody` is pure and
  // its result is serialised once at route registration, so there is no store
  // to read. The claim is narrowed to what the constant can actually support.
  it('Decision.status description does not claim to report what is STORED', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({ method: 'GET', path: PATH });
    const body = jsonBody<OnboardBody>(res);
    const status = body.types.Decision?.fields.status ?? '';

    expect(status).not.toContain('in use');
    expect(status).toContain('documents');
    // Still derived from the constant, so it cannot drift from it.
    for (const v of DECISION_STATUS_VOCAB) expect(status).toContain(v);
  });

  it('does not advertise a Decision status filter that no code implements', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({ method: 'GET', path: PATH });
    const body = jsonBody<OnboardBody>(res);
    const surfaced = body.contextLoading.onSessionStart.surfaceToUser;
    const decisionLine = surfaced.find((s: string) => s.includes('Decision'));
    expect(decisionLine).toBe('Non-archived Decisions');
    // The old wording named 'active' or 'deferred'. Nothing has ever filtered
    // on it — cold-start selects Decisions on `archived` alone — and a contract
    // asserting an unimplemented filter is how a reader concludes the
    // vocabulary is load-bearing when it is not.
    expect(decisionLine).not.toMatch(/status/);
  });

  it('the session-start recipes run, skip archived rows and return the newest first', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const mutate = (payload: unknown) =>
      server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(payload))
      });
    for (const [branch, archived] of [
      ['old', false],
      ['gone', true],
      ['new', false]
    ] as const) {
      // Distinct createdAt values, so "newest first" is decidable.
      await new Promise((r) => setTimeout(r, 5));
      await mutate({
        [`${NS}/createSessionLog`]: {
          params: {
            branch,
            startedAt: '2026-10-23T00:00:00Z',
            summary: branch,
            decisionsCount: 0,
            packages: [],
            archived
          },
          fields: { id: true }
        }
      });
    }
    const body = jsonBody<OnboardBody>(await server.inject({ method: 'GET', path: PATH }));
    const recipes = body.contextLoading.onSessionStart.query;
    const frame = Object.fromEntries(
      Object.entries(recipes).map(([type, q]) => [`${NS}/${type}`, q])
    );
    const res = jsonBody<{ data: Record<string, Array<{ branch?: string }>>; errors?: unknown }>(
      await server.inject({
        method: 'POST',
        path: '/substrate/v1/query',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(frame))
      })
    );
    expect(res.errors).toBeUndefined();
    expect(res.data[`${NS}/SessionLog`]?.map((r) => r.branch)).toEqual(['new', 'old']);
  });

  it('describes every registered type and its mutation family', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({ method: 'GET', path: PATH });
    const body = jsonBody<OnboardBody>(res);
    // Pinned to CLAUDE_TYPE_NAMES so a newly registered type can't be silently
    // missing from the onboard surface — the coverage analogue of the vocab
    // single-sourcing this file already locks.
    expect(Object.keys(body.types)).toEqual([...CLAUDE_TYPE_NAMES]);
    expect(Object.keys(body.mutations)).toEqual([...CLAUDE_TYPE_NAMES]);
    for (const typeName of CLAUDE_TYPE_NAMES) {
      if (typeName === 'AgentMessage') continue;
      expect(body.mutations[typeName]).toEqual([
        `create${typeName}`,
        `update${typeName}`,
        `delete${typeName}`
      ]);
    }
  });

  it('AgentMessage advertises the mailbox mutation family, not the denied direct create', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({ method: 'GET', path: PATH });
    const body = jsonBody<OnboardBody>(res);
    const mailbox = body.mutations.AgentMessage;
    expect(mailbox).toContain('sendAgentMessage');
    expect(mailbox).toContain('markAgentMessageRead');
    expect(mailbox).toContain('ackAgentMessage');
    // Direct create is policy-denied — advertising it would send onboarding
    // agents straight into the denial.
    expect(mailbox).not.toContain('createAgentMessage');
    const message = body.types.AgentMessage;
    if (message === undefined) {
      throw new Error('AgentMessage type should be present in onboard surface');
    }
    expect(message.fields.status).toContain(expectedVocabUnion(AGENT_MESSAGE_STATUS_VOCAB));
  });

  it('Todo.area is described as free text, not a vocabulary the schema does not enforce', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({ method: 'GET', path: PATH });
    const body = jsonBody<OnboardBody>(res);
    const todo = body.types.Todo;
    if (todo === undefined) {
      throw new Error('Todo type should be present in onboard surface');
    }
    expect(todo.fields.area).toContain('free-text');
    // Must not read as a union literal — that documents an enforcement that
    // doesn't exist (namespace.ts declares area as plain field.string()).
    expect(todo.fields.area).not.toMatch(/' \| '/);
  });
});
