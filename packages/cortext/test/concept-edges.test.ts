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
  const plugin = buildClaudeForTest({ namespace: NS, compactRetention: 3 });
  const composed = await compose({
    server,
    dataset: defaultDataset,
    datasets: { [NS]: claudeDataset, architecture: architectureDataset },
    coordinators: [plugin],
    // Identity-gated deletes: these suites exercise edge-sweep
    // semantics THROUGH delete mutations, so they run as an identified
    // caller (attribute-mode auth + Bearer below) — matching how the real
    // agent operates against the commodity stack.
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

const TEST_BEARER = `Bearer ${signHs256(
  { sub: 'edge-test', exp: Math.floor(Date.now() / 1000) + 3600, capabilities: ['read', 'mutate'] },
  'test-secret',
  { kid: 'test' }
)}`;

async function mutate(server: MemorySubstrateServer, payload: unknown): Promise<SubstrateResponse> {
  return server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json', authorization: TEST_BEARER },
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

describe('Concept + ConceptLink edge behavior', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('Concept ↔ ConceptLink: cascade-delete the link when fromConcept goes', async () => {
    const { server, composed, stop } = await setup();
    cleanup = stop;

    // Create two concepts.
    const aRes = await mutate(server, {
      'claude/createConcept': {
        params: {
          name: 'A',
          description: 'first',
          kind: 'protocol',
          body: 'a body',
          archived: false,
          project: 'substrate'
        },
        fields: { id: true }
      }
    });
    const aEnv = jsonBody<PackEnvelope>(aRes);
    expect(aEnv.errors, 'createConcept A should succeed').toBeUndefined();
    const a = aEnv.data['claude/createConcept'] as { id: string };

    const bRes = await mutate(server, {
      'claude/createConcept': {
        params: {
          name: 'B',
          description: 'second',
          kind: 'protocol',
          body: 'b body',
          archived: false,
          project: 'substrate'
        },
        fields: { id: true }
      }
    });
    const bEnv = jsonBody<PackEnvelope>(bRes);
    expect(bEnv.errors, 'createConcept B should succeed').toBeUndefined();
    const b = bEnv.data['claude/createConcept'] as { id: string };

    // Link A → B.
    const linkRes = await mutate(server, {
      'claude/createConceptLink': {
        params: {
          fromConcept: a.id,
          toConcept: b.id,
          kind: 'depends_on',
          archived: false,
          project: 'substrate'
        },
        fields: { id: true }
      }
    });
    const linkEnv = jsonBody<PackEnvelope>(linkRes);
    expect(linkEnv.errors, 'createConceptLink should succeed').toBeUndefined();
    const link = linkEnv.data['claude/createConceptLink'] as { id: string };
    expect(link.id).toBeDefined();

    // The autoCRUD create wrapper should have emitted live edges from the link
    // row to its endpoints. Sanity: each endpoint Concept has one inbound edge.
    const edgesToA = await composed.edges.findEdgesTo({ ns: NS, type: 'Concept', id: a.id });
    expect(edgesToA, 'one cascade edge ConceptLink→A').toHaveLength(1);
    expect(edgesToA[0]?.policy).toBe('cascade');

    // Delete A. Phase-0 tombstones the row; Phase-2 cascade fires on sweep.
    const delRes = await mutate(server, {
      'claude/deleteConcept': { params: { id: a.id }, fields: { id: true } }
    });
    expect(jsonBody<PackEnvelope>(delRes).errors).toBeUndefined();

    // Drive one sweep cycle so the cascade policy fires.
    await composed.runSweepNow();

    // The link should be tombstoned. autoCRUD `get<T>` returns null for
    // tombstoned/missing rows; this is the canonical id-lookup path on claude
    // types (where 'id' is not a body-field and isn't accepted in `where`).
    const linkReadEnv = jsonBody<PackEnvelope>(
      await query(server, {
        'claude/getConceptLink': { params: { id: link.id }, fields: { id: true } }
      })
    );
    expect(linkReadEnv.errors).toBeUndefined();
    const linkRow = linkReadEnv.data['claude/getConceptLink'];
    expect(linkRow, 'ConceptLink should cascade-delete on Concept removal').toBeNull();
  });

  it('Decision.establishesConcept: set_null when the target Concept is deleted', async () => {
    const { server, composed, stop } = await setup();
    cleanup = stop;

    // Create a concept + decision pointing at it.
    const cRes = await mutate(server, {
      'claude/createConcept': {
        params: {
          name: 'C',
          description: 'doomed',
          kind: 'pattern',
          body: '',
          archived: false,
          project: 'substrate'
        },
        fields: { id: true }
      }
    });
    const cEnv = jsonBody<PackEnvelope>(cRes);
    expect(cEnv.errors).toBeUndefined();
    const c = cEnv.data['claude/createConcept'] as { id: string };

    const dRes = await mutate(server, {
      'claude/createDecision': {
        params: {
          topic: 't',
          choice: 'x',
          rationale: 'r',
          status: 'active',
          revisitWhen: '',
          archived: false,
          project: 'substrate',
          establishesConcept: c.id
        },
        fields: { id: true, establishesConcept: true }
      }
    });
    const dEnv = jsonBody<PackEnvelope>(dRes);
    expect(dEnv.errors, 'createDecision with establishesConcept should succeed').toBeUndefined();
    const d = dEnv.data['claude/createDecision'] as {
      id: string;
      establishesConcept: string | null;
    };
    expect(d.establishesConcept).toBe(c.id);

    // Delete the Concept and sweep. Phase-2 set_null should null Decision.establishesConcept.
    await mutate(server, {
      'claude/deleteConcept': { params: { id: c.id }, fields: { id: true } }
    });
    await composed.runSweepNow();

    // Decision must still exist; field nullified.
    const readEnv = jsonBody<PackEnvelope>(
      await query(server, {
        'claude/getDecision': {
          params: { id: d.id },
          fields: { id: true, establishesConcept: true }
        }
      })
    );
    expect(readEnv.errors).toBeUndefined();
    const row = readEnv.data['claude/getDecision'] as {
      id: string;
      establishesConcept: string | null;
    } | null;
    expect(row, 'Decision should survive Concept delete').not.toBeNull();
    expect(row?.establishesConcept, 'establishesConcept should be nulled').toBeNull();
  });

  it('AgentRule.expressesConcept: set_null when the target Concept is deleted', async () => {
    const { server, composed, stop } = await setup();
    cleanup = stop;

    const cRes = await mutate(server, {
      'claude/createConcept': {
        params: {
          name: 'D',
          description: 'doomed-too',
          kind: 'protocol',
          body: '',
          archived: false,
          project: 'substrate'
        },
        fields: { id: true }
      }
    });
    const cEnv = jsonBody<PackEnvelope>(cRes);
    expect(cEnv.errors).toBeUndefined();
    const c = cEnv.data['claude/createConcept'] as { id: string };

    const rRes = await mutate(server, {
      'claude/createAgentRule': {
        params: {
          rule: 'do X',
          category: 'process',
          active: true,
          rationale: '',
          archived: false,
          project: 'substrate',
          expressesConcept: c.id
        },
        fields: { id: true, expressesConcept: true }
      }
    });
    const rEnv = jsonBody<PackEnvelope>(rRes);
    expect(rEnv.errors, 'createAgentRule with expressesConcept should succeed').toBeUndefined();
    const r = rEnv.data['claude/createAgentRule'] as {
      id: string;
      expressesConcept: string | null;
    };
    expect(r.expressesConcept).toBe(c.id);

    await mutate(server, {
      'claude/deleteConcept': { params: { id: c.id }, fields: { id: true } }
    });
    await composed.runSweepNow();

    const readEnv = jsonBody<PackEnvelope>(
      await query(server, {
        'claude/getAgentRule': {
          params: { id: r.id },
          fields: { id: true, expressesConcept: true }
        }
      })
    );
    expect(readEnv.errors).toBeUndefined();
    const row = readEnv.data['claude/getAgentRule'] as {
      id: string;
      expressesConcept: string | null;
    } | null;
    expect(row, 'AgentRule should survive Concept delete').not.toBeNull();
    expect(row?.expressesConcept, 'expressesConcept should be nulled').toBeNull();
  });

  it('ConceptLink read returns both endpoint ids; archive on Concept does NOT cascade-delete', async () => {
    const { server, composed, stop } = await setup();
    cleanup = stop;

    const eEnv = jsonBody<PackEnvelope>(
      await mutate(server, {
        'claude/createConcept': {
          params: {
            name: 'E',
            description: 'live',
            kind: 'role',
            body: '',
            archived: false,
            project: 'substrate'
          },
          fields: { id: true }
        }
      })
    );
    expect(eEnv.errors).toBeUndefined();
    const e = eEnv.data['claude/createConcept'] as { id: string };

    const fEnv = jsonBody<PackEnvelope>(
      await mutate(server, {
        'claude/createConcept': {
          params: {
            name: 'F',
            description: 'live',
            kind: 'role',
            body: '',
            archived: false,
            project: 'substrate'
          },
          fields: { id: true }
        }
      })
    );
    expect(fEnv.errors).toBeUndefined();
    const f = fEnv.data['claude/createConcept'] as { id: string };

    const linkEnv = jsonBody<PackEnvelope>(
      await mutate(server, {
        'claude/createConceptLink': {
          params: {
            fromConcept: e.id,
            toConcept: f.id,
            kind: 'see_also',
            archived: false,
            project: 'substrate'
          },
          fields: { id: true, fromConcept: true, toConcept: true, kind: true }
        }
      })
    );
    expect(linkEnv.errors).toBeUndefined();
    const link = linkEnv.data['claude/createConceptLink'] as {
      id: string;
      fromConcept: string;
      toConcept: string;
      kind: string;
    };
    expect(link.fromConcept).toBe(e.id);
    expect(link.toConcept).toBe(f.id);
    expect(link.kind).toBe('see_also');

    // Archive (NOT delete) E — link should survive. archived=true is a JSONB
    // field flip; it does NOT tombstone the row, so no edge policy fires.
    await mutate(server, {
      'claude/updateConcept': { params: { id: e.id, archived: true }, fields: { id: true } }
    });
    await composed.runSweepNow();

    const linkRow = jsonBody<PackEnvelope>(
      await query(server, {
        'claude/getConceptLink': { params: { id: link.id }, fields: { id: true } }
      })
    ).data['claude/getConceptLink'];
    expect(linkRow, 'archive does not cascade — link survives').not.toBeNull();
  });
});
