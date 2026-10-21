import type { PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TODO_LIFECYCLE_VOCAB,
  TODO_PRIORITY_VOCAB,
  TODO_RESOLUTION_VOCAB
} from '../src/kernel/index.js';
import {
  buildClaudeNamespace,
  CLAUDE_TYPE_NAMES,
  DECISION_STATUS_VOCAB,
  TODO_STATUS_ALIASES,
  TODO_STATUS_IMPLIES
} from '../src/namespace.js';
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
    types: Record<string, { fields: Record<string, unknown> }>;
    mutations: Record<string, { params: Record<string, unknown>; returns: unknown }>;
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

/**
 * Create a row and hand back its id, for use as a crossRef target.
 *
 * substrate enforces referential integrity on crossRef writes: a made-up
 * UUID is refused with `missing_referent` rather than stored. The round-trip
 * tests below are about a crossRef FIELD carrying a UUID end to end — through
 * create, projection and an `eq` filter — not about dangling refs, so they
 * point at a row that exists. A fixed UUID cannot name a row the store minted.
 */
async function createReferent(
  server: MemorySubstrateServer,
  key: string,
  params: Record<string, unknown>
): Promise<string> {
  const res = await server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ [key]: { params, fields: { id: true } } }))
  });
  const env = jsonBody<PackEnvelope>(res);
  expect(env.errors, `referent create ${key} should succeed`).toBeUndefined();
  return (env.data[key] as { id: string }).id;
}

describe('buildClaudeNamespace', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('declares its NL rulings as schema annotations', () => {
    const def = buildClaudeNamespace('cortext');
    expect(def.annotations?.nl).toMatchObject({
      liveStatus: { Todo: 'open' },
      timeField: { SessionLog: 'startedAt' },
      unscopedTypes: ['AgentIdentity', 'AgentMessage', 'Skill']
    });
  });

  it('NL rulings only name types and fields the namespace declares', () => {
    const def = buildClaudeNamespace('cortext');
    const rulings = def.annotations?.nl as {
      unscopedTypes: string[];
      liveStatus: Record<string, string>;
      timeField: Record<string, string>;
      typeAliases: Record<string, string>;
      typeNotes: Record<string, string>;
      valueAliases: Record<string, { type: string; field: string }[]>;
    };
    const types = def.types as Record<string, { fields: Record<string, unknown> }>;
    const typeNames = new Set(Object.keys(types));
    for (const t of CLAUDE_TYPE_NAMES) expect(typeNames.has(t)).toBe(true);

    const missingTypes: string[] = [];
    const checkType = (where: string, t: string) => {
      if (!typeNames.has(t)) missingTypes.push(`${where}: ${t}`);
    };
    for (const t of rulings.unscopedTypes) checkType('unscopedTypes', t);
    for (const t of Object.values(rulings.typeAliases)) checkType('typeAliases', t);
    for (const t of Object.keys(rulings.liveStatus)) checkType('liveStatus', t);
    for (const t of Object.keys(rulings.timeField)) checkType('timeField', t);
    for (const t of Object.keys(rulings.typeNotes)) checkType('typeNotes', t);
    expect(missingTypes).toEqual([]);

    const missingFields: string[] = [];
    const checkField = (where: string, t: string, f: string) => {
      if (types[t]?.fields[f] === undefined) missingFields.push(`${where}: ${t}.${f}`);
    };
    // liveStatus maps type -> a status VALUE; the field it filters is `status`.
    for (const t of Object.keys(rulings.liveStatus)) checkField('liveStatus', t, 'status');
    for (const [t, f] of Object.entries(rulings.timeField)) checkField('timeField', t, f);
    for (const [phrase, rows] of Object.entries(rulings.valueAliases)) {
      for (const r of rows) {
        checkType(`valueAliases[${phrase}]`, r.type);
        checkField(`valueAliases[${phrase}]`, r.type, r.field);
      }
    }
    expect(missingTypes).toEqual([]);
    expect(missingFields).toEqual([]);
  });

  it('registers the namespace under its configured name', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    expect(Object.keys(schema)).toContain(NS);
  });

  it('publishes every claude type in the federated schema', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const typeNames = Object.keys(schema[NS]?.types ?? {}).sort();
    expect(typeNames).toEqual([...CLAUDE_TYPE_NAMES].sort());
  });

  it('exposes autoCRUD mutations for each type — AgentMessage opts out of create', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const mutations = Object.keys(schema[NS]?.mutations ?? {});
    for (const type of CLAUDE_TYPE_NAMES) {
      for (const prefix of ['create', 'get', 'update', 'delete']) {
        // AgentMessage declares autoCrud:false: the send path is the custom
        // family, and an advertised create the route only denies teaches
        // callers a shape that cannot work.
        if (type === 'AgentMessage' && prefix === 'create') {
          expect(mutations).not.toContain('createAgentMessage');
          continue;
        }
        expect(mutations).toContain(`${prefix}${type}`);
      }
    }
  });

  it('round-trips createSessionLog and then reads it back via the SessionLog list', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const create = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/createSessionLog`]: {
            params: {
              branch: 'main',
              startedAt: '2026-04-18T00:00:00Z',
              summary: 'bootstrap session',
              decisionsCount: 0,
              packages: 'cortext',
              archived: false
            },
            fields: { id: true, branch: true }
          }
        })
      )
    });
    expect(create.status).toBe(200);
    const createdEnv = jsonBody<PackEnvelope>(create);
    expect(createdEnv.errors).toBeUndefined();

    const list = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/SessionLog`]: {
            params: {},
            fields: { id: true, branch: true, summary: true }
          }
        })
      )
    });
    expect(list.status).toBe(200);
    const listEnv = jsonBody<PackEnvelope>(list);
    const rows = listEnv.data[`${NS}/SessionLog`] as Array<{
      branch: string;
      summary: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.branch).toBe('main');
    expect(rows[0]?.summary).toBe('bootstrap session');
  });

  it('registers Memory with all expected fields', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const memoryFields = Object.keys(schema[NS]?.types?.Memory?.fields ?? {}).sort();
    expect(memoryFields).toEqual(
      [
        'archived',
        'body',
        'description',
        'name',
        'project',
        'shortId',
        'synopsis',
        'tags',
        'type'
      ].sort()
    );
  });

  it('Todo.implementsDecision points at Decision with set_null', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    expect(schema[NS]?.types.Todo?.fields.implementsDecision).toMatchObject({
      kind: 'crossRef',
      type: 'Decision',
      nullable: true,
      onDelete: 'set_null'
    });
  });

  it('Todo.status is a lifecycle vocabulary with closing aliases, beside resolution', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    // Status is LIFECYCLE only; closing words are aliases that also
    // set the outcome in `resolution`.
    expect(schema[NS]?.types.Todo?.fields.status).toMatchObject({
      kind: 'scalar',
      type: 'string',
      enum: [...TODO_LIFECYCLE_VOCAB],
      aliases: { ...TODO_STATUS_ALIASES },
      implies: { ...TODO_STATUS_IMPLIES }
    });
    expect(schema[NS]?.types.Todo?.fields.resolution).toMatchObject({
      enum: [...TODO_RESOLUTION_VOCAB],
      nullable: true
    });
    expect(schema[NS]?.types.Todo?.fields.priority).toMatchObject({
      kind: 'scalar',
      type: 'string',
      enum: TODO_PRIORITY_VOCAB
    });
  });

  it('still reads the legacy Todo statuses, through their aliases', () => {
    const readable = new Set<string>([
      ...TODO_LIFECYCLE_VOCAB,
      ...Object.keys(TODO_STATUS_ALIASES)
    ]);
    expect(['done', 'not_started'].filter((v) => !readable.has(v))).toEqual([]);
  });

  it('Decision.status is an indexed NON-STRICT vocabulary, never a closed enum', async () => {
    // Same remedy as AgentRule.category below. `enum` must be ABSENT, not
    // merely widened: a longer enum moves the wall to the next unanticipated
    // state and fails the same silent way. And widening-then-narrowing is not
    // symmetric — narrowing strands rows that stay readable but not
    // round-trippable, so this is a one-way door taken deliberately.
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const status = schema[NS]?.types.Decision?.fields.status;
    expect(status).toMatchObject({ kind: 'scalar', type: 'string' });
    // A NON-STRICT vocabulary: the values are declared
    // so aliases canonicalise, and `strict: false` keeps the wall away.
    // Admission of unknown states is pinned behaviourally in vocab-aliases.test.ts.
    expect(status, 'a strict vocab here re-freezes the taxonomy').toMatchObject({ strict: false });
    // Indexed, so it stays filterable if a consumer ever does want to branch
    // on it — the reason for field.string() over field.string({ indexed: false }).
    expect(status).not.toMatchObject({ indexed: false });
  });

  it('Decision.status carries a default, so an omitted key cannot write null', async () => {
    // `status` is non-nullable, but assertEnumValues skips fields ABSENT from
    // params, the kernel CHECK constraints carry an explicit `OR <field> IS
    // NULL` escape, and check-enums skips null on read. Only a default closes it.
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    expect(schema[NS]?.types.Decision?.fields.status).toMatchObject({ default: 'active' });
  });

  it('DECISION_STATUS_VOCAB documents `open`, the state the enum had no word for', () => {
    // Admitting `open` to the advisory vocabulary is the safe direction
    // (widening); normalising it away would discard a real state.
    expect(DECISION_STATUS_VOCAB).toContain('open');
    expect([...DECISION_STATUS_VOCAB]).toEqual(['open', 'active', 'superseded', 'deferred']);
  });

  it('AgentRule.category is an indexed NON-STRICT vocabulary, never a closed enum', async () => {
    // An enum here fails silently: agents substitute the nearest legal word
    // rather than reporting a rejection.
    //
    // `enum` must be ABSENT, not merely wider: a longer enum moves the wall to
    // the next genuinely-new category and fails the same silent way. The
    // vocabulary survives as documentation in AGENT_RULE_CATEGORY_VOCAB, which
    // the onboarding contract renders as "categories in use" rather than a
    // closed union.
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const category = schema[NS]?.types.AgentRule?.fields.category;
    expect(category).toMatchObject({ kind: 'scalar', type: 'string' });
    // A NON-STRICT vocabulary; agent-rule-category.test.ts pins that every
    // documented category is writable.
    expect(category, 'a strict vocab here re-freezes the taxonomy').toMatchObject({
      strict: false
    });
    // Indexed, so it stays filterable — the reason for field.string() over
    // field.string({ indexed: false }).
    expect(category).not.toMatchObject({ indexed: false });
  });

  it('flipped FK fields are first-class crossRef edges with the right policies', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    expect(schema[NS]?.types.Decision?.fields.sessionId).toMatchObject({
      kind: 'crossRef',
      type: 'SessionLog',
      nullable: true,
      onDelete: 'set_null'
    });
    expect(schema[NS]?.types.Decision?.fields.supersedes).toMatchObject({
      kind: 'crossRef',
      type: 'Decision',
      nullable: true,
      onDelete: 'set_null'
    });
    expect(schema[NS]?.types.CouncilSession?.fields.sessionLogId).toMatchObject({
      kind: 'crossRef',
      type: 'SessionLog',
      nullable: true,
      onDelete: 'set_null'
    });
    expect(schema[NS]?.types.CouncilAdvisor?.fields.councilSessionId).toMatchObject({
      kind: 'crossRef',
      type: 'CouncilSession',
      nullable: true,
      onDelete: 'cascade'
    });
    expect(schema.architecture?.types.ArchitectureConcern?.fields.supersedes).toMatchObject({
      kind: 'crossRef',
      type: 'ArchitectureConcern',
      nullable: true,
      onDelete: 'set_null'
    });
  });

  it('registers AnchorIntent with all expected fields', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const anchorIntentFields = Object.keys(schema[NS]?.types?.AnchorIntent?.fields ?? {}).sort();
    expect(anchorIntentFields).toEqual(
      ['archived', 'authoredBy', 'body', 'project', 'shortId', 'synopsis'].sort()
    );
  });

  it('Memory CRUD round-trips via autoCRUD', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const createRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'claude/createMemory': {
            params: {
              name: 'test_memory',
              description: 'one-line hook',
              type: 'feedback',
              body: 'body content',
              archived: false,
              project: 'substrate'
            },
            fields: { id: true, name: true, type: true }
          }
        })
      )
    });
    const created = jsonBody<{
      data: { 'claude/createMemory': { id: string; name: string; type: string } };
    }>(createRes);
    expect(created.data['claude/createMemory'].name).toBe('test_memory');
    expect(created.data['claude/createMemory'].type).toBe('feedback');
  });

  it('AnchorIntent CRUD round-trips via autoCRUD', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const createRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/createAnchorIntent`]: {
            params: {
              synopsis: 'Brainstorm anchor-C: topical authored anchor via AnchorIntent type.',
              authoredBy: { kind: 'agent' },
              project: 'substrate',
              archived: false
            },
            fields: { id: true, shortId: true, synopsis: true, authoredBy: true, project: true }
          }
        })
      )
    });
    const created = jsonBody<{
      data: Record<
        string,
        {
          id: string;
          shortId: number;
          synopsis: string;
          authoredBy: { kind: string };
          project: string | null;
        }
      >;
    }>(createRes);
    const row = created.data[`${NS}/createAnchorIntent`];
    expect(row?.id).toBeTruthy();
    expect(row?.synopsis).toContain('anchor-C');
    expect(row?.authoredBy?.kind).toBe('agent');
    expect(row?.project).toBe('substrate');

    const queryRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/AnchorIntent`]: {
            params: { where: { project: { eq: 'substrate' } } },
            fields: { id: true, synopsis: true, authoredBy: true }
          }
        })
      )
    });
    const queried = jsonBody<{
      data: Record<string, Array<{ id: string; synopsis: string; authoredBy: { kind: string } }>>;
    }>(queryRes);
    const rows = queried.data[`${NS}/AnchorIntent`];
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.authoredBy?.kind).toBe('agent');
  });

  it('rejects where-filters on indexed:false fields with unindexed_field', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/SessionLog`]: {
            params: { where: { summary: { eq: 'bootstrap session' } } },
            fields: { id: true }
          }
        })
      )
    });
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('unindexed_field');
  });

  it('retrieval-handle fields (synopsis/description tier) filter without _allowTableScan', async () => {
    // The systematic split: retrieval-tuned handle
    // fields are indexed/filterable; long-form prose (body/summary/notes)
    // stays guarded. These four cover the flipped tier across types.
    const { server, stop } = await setup();
    cleanup = stop;

    const frames = {
      [`${NS}/SessionLog`]: {
        params: { where: { synopsis: { contains: 'anything' } } },
        fields: { id: true }
      },
      [`${NS}/Memory`]: {
        params: { where: { description: { contains: 'anything' } } },
        fields: { id: true }
      },
      [`${NS}/AgentRule`]: {
        params: { where: { synopsis: { contains: 'anything' } } },
        fields: { id: true }
      },
      [`${NS}/Concept`]: {
        params: { where: { description: { contains: 'anything' } } },
        fields: { id: true }
      }
    };
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(frames))
    });
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeUndefined();
  });

  it('project field is indexed + filterable on the project-scoped types', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    // Create three SessionLog rows with different project scopes
    for (const project of ['substrate', 'notes-app', null]) {
      const res = await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            [`${NS}/createSessionLog`]: {
              params: {
                branch: 'main',
                startedAt: '2026-04-23T00:00:00Z',
                summary: `session for ${project ?? 'cross-cutting'}`,
                decisionsCount: 0,
                packages: '',
                archived: false,
                project
              },
              fields: { id: true }
            }
          })
        )
      });
      expect(jsonBody<PackEnvelope>(res).errors).toBeUndefined();
    }

    // Filter by project: should see exactly the 'substrate' one
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/SessionLog`]: {
            params: { where: { project: { eq: 'substrate' } }, limit: 10 },
            fields: { id: true, project: true }
          }
        })
      )
    });
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeUndefined();
    const rows = env.data[`${NS}/SessionLog`] as Array<{ project: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.project).toBe('substrate');
  });

  it('CouncilAdvisor.councilSessionId round-trips a UUID string', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const councilSessionId = await createReferent(server, `${NS}/createCouncilSession`, {
      question: 'q',
      slug: 'referent-council',
      context: '',
      options: '',
      agreement: '',
      disagreement: '',
      blindSpots: '',
      verdict: '',
      verdictAlignment: 'strong',
      sessionLogId: null,
      date: '2026-04-18T00:00:00Z'
    });

    const createRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/createCouncilAdvisor`]: {
            params: {
              councilSessionId: councilSessionId,
              role: 'optimist',
              response: 'r',
              recommendation: 'rec'
            },
            fields: { id: true, councilSessionId: true }
          }
        })
      )
    });
    const created = jsonBody<PackEnvelope>(createRes);
    expect(created.errors).toBeUndefined();
    const row = created.data[`${NS}/createCouncilAdvisor`] as {
      id: string;
      councilSessionId: string;
    };
    expect(row.councilSessionId).toBe(councilSessionId);

    const queryRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/CouncilAdvisor`]: {
            params: { where: { councilSessionId: { eq: councilSessionId } } },
            fields: { id: true, councilSessionId: true }
          }
        })
      )
    });
    const queried = jsonBody<PackEnvelope>(queryRes);
    expect(queried.errors).toBeUndefined();
    const rows = queried.data[`${NS}/CouncilAdvisor`] as Array<{
      id: string;
      councilSessionId: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.councilSessionId).toBe(councilSessionId);
  });

  it('Decision.sessionId round-trips a UUID string', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const sessionLogId = await createReferent(server, `${NS}/createSessionLog`, {
      branch: 'main',
      startedAt: '2026-04-18T00:00:00Z',
      summary: 'crossRef referent',
      decisionsCount: 0,
      packages: 'cortext',
      archived: false
    });

    const createRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/createDecision`]: {
            params: {
              topic: 'use-postgres',
              choice: 'yes',
              rationale: 'rationale',
              sessionId: sessionLogId,
              status: 'active',
              revisitWhen: '',
              archived: false
            },
            fields: { id: true, sessionId: true }
          }
        })
      )
    });
    const created = jsonBody<PackEnvelope>(createRes);
    expect(created.errors, 'Decision.sessionId write should succeed').toBeUndefined();
    const row = created.data[`${NS}/createDecision`] as { id: string; sessionId: string };
    expect(row.sessionId).toBe(sessionLogId);

    const queryRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/Decision`]: {
            params: { where: { sessionId: { eq: sessionLogId } } },
            fields: { id: true, sessionId: true }
          }
        })
      )
    });
    const queried = jsonBody<PackEnvelope>(queryRes);
    expect(queried.errors, 'Decision.sessionId filter should succeed').toBeUndefined();
    const rows = queried.data[`${NS}/Decision`] as Array<{ sessionId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe(sessionLogId);
  });

  it('Decision.supersedes round-trips a UUID string', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const supersededId = await createReferent(server, `${NS}/createDecision`, {
      topic: 'use-redis',
      choice: 'yes',
      rationale: 'the decision this one supersedes',
      sessionId: null,
      supersedes: null,
      status: 'active',
      revisitWhen: '',
      archived: false
    });

    const createRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/createDecision`]: {
            params: {
              topic: 'use-redis',
              choice: 'no',
              rationale: 'rationale',
              sessionId: null,
              supersedes: supersededId,
              status: 'active',
              revisitWhen: '',
              archived: false
            },
            fields: { id: true, supersedes: true }
          }
        })
      )
    });
    const created = jsonBody<PackEnvelope>(createRes);
    expect(created.errors, 'Decision.supersedes write should succeed').toBeUndefined();
    const row = created.data[`${NS}/createDecision`] as { id: string; supersedes: string };
    expect(row.supersedes).toBe(supersededId);

    const queryRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/Decision`]: {
            params: { where: { supersedes: { eq: supersededId } } },
            fields: { id: true, supersedes: true }
          }
        })
      )
    });
    const queried = jsonBody<PackEnvelope>(queryRes);
    expect(queried.errors, 'Decision.supersedes filter should succeed').toBeUndefined();
    const rows = queried.data[`${NS}/Decision`] as Array<{ supersedes: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.supersedes).toBe(supersededId);
  });

  it('CouncilSession.sessionLogId round-trips a UUID string', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const sessionLogId = await createReferent(server, `${NS}/createSessionLog`, {
      branch: 'main',
      startedAt: '2026-04-18T00:00:00Z',
      summary: 'crossRef referent',
      decisionsCount: 0,
      packages: 'cortext',
      archived: false
    });

    const createRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/createCouncilSession`]: {
            params: {
              question: 'should we?',
              slug: 'should-we',
              context: 'some context',
              options: '',
              agreement: '',
              disagreement: '',
              blindSpots: '',
              verdict: '',
              verdictAlignment: 'strong',
              sessionLogId: sessionLogId,
              date: '2026-04-24'
            },
            fields: { id: true, sessionLogId: true }
          }
        })
      )
    });
    const created = jsonBody<PackEnvelope>(createRes);
    expect(created.errors, 'CouncilSession.sessionLogId write should succeed').toBeUndefined();
    const row = created.data[`${NS}/createCouncilSession`] as { id: string; sessionLogId: string };
    expect(row.sessionLogId).toBe(sessionLogId);

    const queryRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/CouncilSession`]: {
            params: { where: { sessionLogId: { eq: sessionLogId } } },
            fields: { id: true, sessionLogId: true }
          }
        })
      )
    });
    const queried = jsonBody<PackEnvelope>(queryRes);
    expect(queried.errors, 'CouncilSession.sessionLogId filter should succeed').toBeUndefined();
    const rows = queried.data[`${NS}/CouncilSession`] as Array<{ sessionLogId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionLogId).toBe(sessionLogId);
  });

  it('architecture namespace FK field accepts string UUIDs — ArchitectureConcern.supersedes', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const supersededId = await createReferent(server, 'architecture/createArchitectureConcern', {
      title: 'referent concern',
      status: 's',
      archived: false,
      category: 'c',
      evidence: 'e',
      proposal: 'p',
      severity: 'medium',
      supersedes: null,
      revisitWhen: '',
      affectsTypes: '',
      discoveredIn: '',
      affectsPackages: ''
    });

    const createRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'architecture/createArchitectureConcern': {
            params: {
              title: 't',
              status: 's',
              archived: false,
              category: 'c',
              evidence: 'e',
              proposal: 'p',
              severity: 'medium',
              supersedes: supersededId,
              revisitWhen: '',
              affectsTypes: '',
              discoveredIn: '',
              affectsPackages: ''
            },
            fields: { id: true, supersedes: true }
          }
        })
      )
    });
    const created = jsonBody<PackEnvelope>(createRes);
    expect(created.errors, 'ArchitectureConcern.supersedes write should succeed').toBeUndefined();
    const row = created.data['architecture/createArchitectureConcern'] as {
      id: string;
      supersedes: string;
    };
    expect(row.supersedes).toBe(supersededId);

    const queryRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'architecture/ArchitectureConcern': {
            params: { where: { supersedes: { eq: supersededId } } },
            fields: { id: true, supersedes: true }
          }
        })
      )
    });
    const queried = jsonBody<PackEnvelope>(queryRes);
    expect(queried.errors, 'ArchitectureConcern.supersedes filter should succeed').toBeUndefined();
    const rows = queried.data['architecture/ArchitectureConcern'] as Array<{
      id: string;
      supersedes: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.supersedes).toBe(supersededId);
  });

  it('project field lands on Decision, Todo, AgentRule, CouncilSession schemas', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const types = schema[NS]?.types ?? {};
    for (const typeName of ['SessionLog', 'Decision', 'Todo', 'AgentRule', 'CouncilSession']) {
      const fields = types[typeName]?.fields ?? {};
      expect(fields.project, `${typeName} should declare a project field`).toBeDefined();
    }

    // Skills + child records deliberately NOT scoped
    for (const typeName of ['Skill', 'CouncilAdvisor']) {
      const fields = types[typeName]?.fields ?? {};
      expect(fields.project, `${typeName} should NOT declare a project field`).toBeUndefined();
    }

    // architecture namespace
    const arch = schema.architecture?.types ?? {};
    expect(arch.ArchitectureConcern?.fields.project).toBeDefined();
  });

  it('row-metadata: createdAt/updatedAt not declared as body fields; _metadata populated by server', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    // Verify schema: none of the claude types should declare createdAt or updatedAt as body fields.
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const claudeTypes = schema[NS]?.types ?? {};
    for (const typeName of Object.keys(claudeTypes)) {
      const fields = claudeTypes[typeName]?.fields ?? {};
      expect(
        fields.createdAt,
        `${typeName} should NOT declare createdAt as a body field (sourced from _metadata)`
      ).toBeUndefined();
      expect(
        fields.updatedAt,
        `${typeName} should NOT declare updatedAt as a body field (sourced from _metadata)`
      ).toBeUndefined();
    }
    const archTypes = schema.architecture?.types ?? {};
    for (const typeName of Object.keys(archTypes)) {
      const fields = archTypes[typeName]?.fields ?? {};
      expect(
        fields.createdAt,
        `architecture/${typeName} should NOT declare createdAt as a body field`
      ).toBeUndefined();
    }

    // Verify round-trip: _metadata is server-populated; client must not supply createdAt.
    const createRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/createSessionLog`]: {
            params: {
              branch: 'feat/row-metadata',
              startedAt: '2026-04-25T00:00:00Z',
              summary: 'row-metadata regression',
              decisionsCount: 0,
              packages: 'cortext',
              archived: false,
              project: 'substrate'
            },
            fields: { id: true, branch: true, _metadata: true }
          }
        })
      )
    });
    const created = jsonBody<PackEnvelope>(createRes);
    expect(
      created.errors,
      'createSessionLog should succeed without createdAt in params'
    ).toBeUndefined();
    const row = created.data[`${NS}/createSessionLog`] as {
      id: string;
      branch: string;
      _metadata?: { createdAt?: string; updatedAt?: string };
    };
    expect(row._metadata?.createdAt).toBeTruthy();
    expect(row._metadata?.updatedAt).toBeTruthy();
    // Confirm client-supplied createdAt is rejected.
    const rejectRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/createDecision`]: {
            params: {
              topic: 'test',
              choice: 'yes',
              rationale: 'r',
              status: 'active',
              revisitWhen: '',
              archived: false,
              createdAt: '2026-04-25T00:00:00Z'
            },
            fields: { id: true }
          }
        })
      )
    });
    const rejected = jsonBody<PackEnvelope>(rejectRes);
    expect(rejected.errors).toBeDefined();
    expect(rejected.errors?.[0]?.code).toBe('client_supplied_server_field');
  });
});

describe('identity-gated deletes', () => {
  let stopFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopFn !== null) {
      await stopFn();
      stopFn = null;
    }
  });

  async function setupAttributeAuth(): Promise<{ server: MemorySubstrateServer }> {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      datasets: {
        [NS]: new MemoryDataset({ namespace: NS }),
        architecture: new MemoryDataset({ namespace: 'architecture' })
      },
      coordinators: [buildClaudeForTest({ namespace: NS, compactRetention: 3 })],
      auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' },
      // substrate fails compose() closed when auth is on and this is absent
      // or <16 chars — it is the sole auth on the ungated SSE GET routes.
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    await server.start();
    stopFn = async (): Promise<void> => {
      await composed.stop();
    };
    return { server };
  }

  const bearer = (): string =>
    `Bearer ${signHs256(
      {
        sub: 'gate-test',
        exp: Math.floor(Date.now() / 1000) + 3600,
        capabilities: ['read', 'mutate']
      },
      'test-secret',
      { kid: 'test' }
    )}`;

  async function send(
    server: MemorySubstrateServer,
    payload: unknown,
    authed: boolean
  ): Promise<PackEnvelope> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authed) headers.authorization = bearer();
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers,
      body: Buffer.from(JSON.stringify(payload))
    });
    return jsonBody<PackEnvelope>(res);
  }

  /**
   * As `send`, but keeps the HTTP status. Needed since substrate refuses an
   * anonymous WRITE at the transport with a bare `401 {"code":"unauthorized"}` —
   * a response that carries no envelope at all, so `errors` and `data` are both
   * undefined and an envelope-only assertion cannot tell it from a success.
   */
  async function sendStatus(
    server: MemorySubstrateServer,
    payload: unknown,
    authed: boolean
  ): Promise<{ status: number; env: PackEnvelope }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authed) headers.authorization = bearer();
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers,
      body: Buffer.from(JSON.stringify(payload))
    });
    return { status: res.status, env: jsonBody<PackEnvelope>(res) };
  }

  /**
   * Under `mode: 'attribute'` an anonymous READ passes, but an anonymous WRITE
   * is refused at the transport with `401 {"code":"unauthorized"}`, so the
   * plugin's own identity gate is never consulted for an anonymous caller.
   * The create-passes / delete-denied distinction lives on the authenticated
   * caller, which the next test covers.
   */
  it('anonymous writes are refused at the transport, before the plugin gate', async () => {
    const { server } = await setupAttributeAuth();

    const created = await sendStatus(
      server,
      {
        [`${NS}/createMemory`]: {
          params: { name: 'gate-row', type: 'reference', description: 'x', body: 'x' },
          fields: { id: true }
        }
      },
      false
    );
    expect(created.status).toBe(401);
    // No envelope on a transport refusal — this is what makes `errors`-only
    // assertions read a 401 as a success.
    expect(created.env.errors).toBeUndefined();
    expect(created.env.data).toBeUndefined();

    const deleted = await sendStatus(
      server,
      { [`${NS}/deleteMemory`]: { params: { id: 'irrelevant' }, fields: { id: true } } },
      false
    );
    expect(deleted.status).toBe(401);
  });
  it('an authenticated identity may delete', async () => {
    const { server } = await setupAttributeAuth();

    const created = await send(
      server,
      {
        [`${NS}/createMemory`]: {
          params: { name: 'gate-row-2', type: 'reference', description: 'x', body: 'x' },
          fields: { id: true }
        }
      },
      true
    );
    const id = (created.data![`${NS}/createMemory`] as { id: string }).id;

    const deleted = await send(
      server,
      { [`${NS}/deleteMemory`]: { params: { id }, fields: { id: true } } },
      true
    );
    expect(deleted.errors).toBeUndefined();
  });

  /**
   * WAS: 'the gate covers the architecture namespace too (plugin-level policy)'.
   * Same relocation as above — the architecture namespace is refused anonymously
   * at the transport, so the plugin-level policy is not the layer under test any
   * more. Kept as a distinct case because it is a SECOND namespace: the
   * transport refusal is namespace-independent, and that is worth pinning.
   */
  it('the transport refusal covers the architecture namespace too', async () => {
    const { server } = await setupAttributeAuth();

    const created = await sendStatus(
      server,
      {
        'architecture/createArchitectureConcern': {
          params: {
            title: 'gate-check',
            status: 'open',
            category: 'test',
            evidence: 'x',
            proposal: 'x',
            severity: 'low',
            affectsTypes: 'none',
            discoveredIn: 'gate-test',
            affectsPackages: 'none'
          },
          fields: { id: true }
        }
      },
      false
    );
    expect(created.status).toBe(401);

    // The authenticated path still works, which is what shows the 401 is about
    // the missing identity and not about the architecture namespace being shut.
    const authed = await send(
      server,
      {
        'architecture/createArchitectureConcern': {
          params: {
            title: 'gate-check-authed',
            status: 'open',
            category: 'test',
            evidence: 'x',
            proposal: 'x',
            severity: 'low',
            affectsTypes: 'none',
            discoveredIn: 'gate-test',
            affectsPackages: 'none'
          },
          fields: { id: true }
        }
      },
      true
    );
    expect(authed.errors).toBeUndefined();
  });
});

describe('auth posture knob (open initially, retrofit-capable)', () => {
  let stopFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopFn !== null) {
      await stopFn();
      stopFn = null;
    }
  });

  async function setupWithPosture(auth: {
    reads: 'open' | 'identity';
    writes: 'open' | 'identity';
    deletes: 'open' | 'identity';
  }): Promise<{ server: MemorySubstrateServer }> {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      datasets: {
        [NS]: new MemoryDataset({ namespace: NS }),
        architecture: new MemoryDataset({ namespace: 'architecture' })
      },
      coordinators: [buildClaudeForTest({ namespace: NS, compactRetention: 3, auth })],
      auth: { keys: [{ kid: 'test', alg: 'HS256', publicKey: 'test-secret' }], mode: 'attribute' },
      // substrate fails compose() closed when auth is on and this is absent
      // or <16 chars — it is the sole auth on the ungated SSE GET routes.
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    await server.start();
    stopFn = async (): Promise<void> => {
      await composed.stop();
    };
    return { server };
  }

  const bearer = (): string =>
    `Bearer ${signHs256(
      {
        sub: 'posture-test',
        exp: Math.floor(Date.now() / 1000) + 3600,
        capabilities: ['read', 'mutate']
      },
      'test-secret',
      { kid: 'test' }
    )}`;

  async function inject(
    server: MemorySubstrateServer,
    path: '/substrate/v1/mutate' | '/substrate/v1/query',
    payload: unknown,
    authed: boolean
  ): Promise<PackEnvelope> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authed) headers.authorization = bearer();
    const res = await server.inject({
      method: 'POST',
      path,
      headers,
      body: Buffer.from(JSON.stringify(payload))
    });
    return jsonBody<PackEnvelope>(res);
  }

  /** As `inject`, but keeps the HTTP status — see `sendStatus` above for why. */
  async function injectStatus(
    server: MemorySubstrateServer,
    path: '/substrate/v1/mutate' | '/substrate/v1/query',
    payload: unknown,
    authed: boolean
  ): Promise<{ status: number; env: PackEnvelope }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authed) headers.authorization = bearer();
    const res = await server.inject({
      method: 'POST',
      path,
      headers,
      body: Buffer.from(JSON.stringify(payload))
    });
    return { status: res.status, env: jsonBody<PackEnvelope>(res) };
  }

  const createMemoryFrame = (name: string): Record<string, unknown> => ({
    [`${NS}/createMemory`]: {
      params: { name, type: 'reference', description: 'x', body: 'x' },
      fields: { id: true }
    }
  });

  /**
   * WAS: 'writes=identity: anonymous create is policy_denied with an actionable
   * reason'. The posture knob's `writes` dimension is now UNREACHABLE for an
   * anonymous caller whenever substrate auth is configured: the 401 lands first, so
   * `writes: 'identity'` and `writes: 'open'` are indistinguishable from
   * outside. The knob still decides for an authenticated caller.
   */
  it('writes=identity: anonymous create is refused at the transport, not by the knob', async () => {
    const { server } = await setupWithPosture({
      reads: 'open',
      writes: 'identity',
      deletes: 'identity'
    });

    const denied = await injectStatus(
      server,
      '/substrate/v1/mutate',
      createMemoryFrame('posture-row'),
      false
    );
    expect(denied.status).toBe(401);
    expect(denied.env.errors).toBeUndefined();
  });
  it('writes=identity: an authenticated identity may create; anonymous reads stay open', async () => {
    const { server } = await setupWithPosture({
      reads: 'open',
      writes: 'identity',
      deletes: 'identity'
    });

    const created = await inject(
      server,
      '/substrate/v1/mutate',
      createMemoryFrame('posture-row-2'),
      true
    );
    expect(created.errors).toBeUndefined();
    const id = (created.data![`${NS}/createMemory`] as { id: string }).id;

    const got = await inject(
      server,
      '/substrate/v1/mutate',
      { [`${NS}/getMemory`]: { params: { id }, fields: { id: true } } },
      false
    );
    expect(got.errors).toBeUndefined();

    const listed = await inject(
      server,
      '/substrate/v1/query',
      { [`${NS}/Memory`]: { params: {}, fields: { id: true } } },
      false
    );
    expect(listed.errors).toBeUndefined();
  });

  it('reads=identity: anonymous type queries are policy_denied; authenticated pass', async () => {
    const { server } = await setupWithPosture({
      reads: 'identity',
      writes: 'identity',
      deletes: 'identity'
    });

    const created = await inject(
      server,
      '/substrate/v1/mutate',
      createMemoryFrame('lockdown-row'),
      true
    );
    expect(created.errors).toBeUndefined();
    const id = (created.data![`${NS}/createMemory`] as { id: string }).id;

    // The QUERY route still reaches the plugin anonymously, so the read posture
    // is genuinely what refuses here — this is the assertion the knob is for.
    const deniedQuery = await inject(
      server,
      '/substrate/v1/query',
      { [`${NS}/Memory`]: { params: {}, fields: { id: true } } },
      false
    );
    expect(deniedQuery.errors?.[0]?.code).toBe('policy_denied');

    // `getMemory` is a read, but it rides the MUTATE route — so it is refused
    // at the transport as a write would be, and never reaches the read posture.
    const deniedGet = await injectStatus(
      server,
      '/substrate/v1/mutate',
      { [`${NS}/getMemory`]: { params: { id }, fields: { id: true } } },
      false
    );
    expect(deniedGet.status).toBe(401);

    const allowedQuery = await inject(
      server,
      '/substrate/v1/query',
      { [`${NS}/Memory`]: { params: {}, fields: { id: true } } },
      true
    );
    expect(allowedQuery.errors).toBeUndefined();
  });
  /**
   * Once substrate auth is configured, `deletes: 'open'` means "any
   * authenticated caller may delete", not "anybody may". This case documents
   * what `open` buys you.
   */
  it('fully open: an authenticated caller may delete without a delete grant', async () => {
    const { server } = await setupWithPosture({ reads: 'open', writes: 'open', deletes: 'open' });

    const anon = await injectStatus(
      server,
      '/substrate/v1/mutate',
      createMemoryFrame('open-row-anon'),
      false
    );
    expect(anon.status).toBe(401);

    const created = await inject(
      server,
      '/substrate/v1/mutate',
      createMemoryFrame('open-row'),
      true
    );
    expect(created.errors).toBeUndefined();
    const id = (created.data![`${NS}/createMemory`] as { id: string }).id;

    const deleted = await inject(
      server,
      '/substrate/v1/mutate',
      { [`${NS}/deleteMemory`]: { params: { id }, fields: { id: true } } },
      true
    );
    expect(deleted.errors).toBeUndefined();
  });
});
