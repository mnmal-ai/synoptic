import { describe, expect, it } from 'vitest';
import { buildScoredByType } from '../src/recall-scoring.js';

// Router: both candidates and recall arrive on /substrate/v1/query, since recall
// is the `recall/Hit` frame (the kernel route 401s a signed agent token). A type
// absent from the recall map is answered as a REFUSED FRAME (200, key absent,
// reason in `errors`), which is what an unavailable embedder looks like on the wire.
function router({ candidates, recall }) {
  return (url, init) => {
    if (url.endsWith('/substrate/v1/query')) {
      const payload = JSON.parse(init.body);
      const key = Object.keys(payload)[0];
      if (key === 'recall/Hit') {
        const { type } = payload[key].params;
        const rows = recall[type];
        if (rows === undefined) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: {},
                errors: [{ path: [key], code: 'embedder_unavailable', message: 'no embedder' }]
              })
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { [key]: rows } })
        });
      }
      const type = key.split('/')[1];
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { [key]: candidates[type] ?? [] } })
      });
    }
    throw new Error(`unexpected ${url}`);
  };
}

const NOW = Date.UTC(2026, 5, 4);

describe('buildScoredByType', () => {
  it('joins structural candidates with recall scores by id, nesting fields under row.body', async () => {
    const fetchImpl = router({
      candidates: {
        Memory: [
          {
            id: 'm1',
            type: 'user',
            name: 'A',
            description: 'da',
            _metadata: { updatedAt: '2026-06-03T00:00:00Z' }
          },
          {
            id: 'm2',
            type: 'reference',
            name: 'B',
            description: 'db',
            _metadata: { updatedAt: '2026-05-01T00:00:00Z' }
          }
        ],
        SessionLog: [],
        Decision: []
      },
      recall: { Memory: [{ row: { id: 'm2' }, score: 0.95 }], SessionLog: [], Decision: [] }
    });
    const out = await buildScoredByType({
      substrateUrl: 'https://h',
      namespace: 'claude',
      projectSlug: 'demo',
      anchorText: 'x',
      nowMs: NOW,
      fetchImpl
    });
    expect(out.recallAvailable).toBe(true);
    const m1 = out.byType.Memory.find((r) => r.row.id === 'm1');
    const m2 = out.byType.Memory.find((r) => r.row.id === 'm2');
    expect(m1.semantic).toBeNull(); // not in recall results
    expect(m2.semantic).toBe(0.95); // joined by id
    expect(m1.row.body.name).toBe('A');
    expect(m1.row.body.updatedAt).toBe('2026-06-03T00:00:00Z');
    expect(m1.structural).toBeGreaterThan(0);
    expect(m1.structural).toBeGreaterThan(m2.structural); // user+recent > reference+old
  });

  it('folds in recall-only rows not present in candidates', async () => {
    const fetchImpl = router({
      candidates: { Memory: [], SessionLog: [], Decision: [] },
      recall: {
        Memory: [{ row: { id: 'mX', type: 'user', name: 'fromRecall' }, score: 0.8 }],
        SessionLog: [],
        Decision: []
      }
    });
    const out = await buildScoredByType({
      substrateUrl: 'https://h',
      namespace: 'claude',
      projectSlug: 'demo',
      anchorText: 'x',
      nowMs: NOW,
      fetchImpl
    });
    const mX = out.byType.Memory.find((r) => r.row.id === 'mX');
    expect(mX).toBeDefined();
    expect(mX.semantic).toBe(0.8);
    expect(mX.row.body.name).toBe('fromRecall');
  });

  it('marks recallAvailable false and all semantic null when recall is refused for every type', async () => {
    const fetchImpl = router({
      candidates: {
        Memory: [{ id: 'm1', type: 'user', _metadata: { updatedAt: '2026-06-03T00:00:00Z' } }],
        SessionLog: [],
        Decision: []
      },
      recall: {} // every type refused
    });
    const out = await buildScoredByType({
      substrateUrl: 'https://h',
      namespace: 'claude',
      projectSlug: 'demo',
      anchorText: 'x',
      nowMs: NOW,
      fetchImpl
    });
    expect(out.recallAvailable).toBe(false);
    expect(out.byType.Memory[0].semantic).toBeNull();
  });
});

// ---- The two arms must agree about project scope. The structural arm
// filters with `project: { in: [slug, null] }`; `recall/Hit` accepts no filter
// at all — the server names its whole parameter set when you try:
//
//   unknown parameter: where. This surface accepts: boost, expand, explain, k,
//   lexical, namespace, returnVector, threshold, to, type.
//
// Without a client-side filter every recall-only row would bypass scoping, and
// the render would assert a scope it did not have.
//
// The client-side filter: what a server that refuses the project filter falls back to.
describe('buildScoredByType project scope', () => {
  function scopeRouter(recallMemoryRows) {
    return router({
      candidates: { Memory: [], SessionLog: [], Decision: [] },
      recall: { Memory: recallMemoryRows, SessionLog: [], Decision: [] }
    });
  }

  const call = (fetchImpl, projectSlug = 'demo') =>
    buildScoredByType({
      substrateUrl: 'https://h',
      namespace: 'claude',
      projectSlug,
      anchorText: 'x',
      nowMs: NOW,
      fetchImpl
    });

  it('drops a recall-only row belonging to another project, and counts it', async () => {
    const out = await call(
      scopeRouter([{ row: { id: 'x1', name: 'other', project: 'app' }, score: 0.9 }])
    );
    expect(out.byType.Memory.find((r) => r.row.id === 'x1')).toBeUndefined();
    expect(out.scopeDrops.total).toBe(1);
    expect(out.scopeDrops.byProject).toEqual({ app: 1 });
  });

  it('keeps a cross-cutting recall-only row — project null is fleet-wide by design', async () => {
    const out = await call(
      scopeRouter([{ row: { id: 'x2', name: 'shared', project: null }, score: 0.9 }])
    );
    expect(out.byType.Memory.find((r) => r.row.id === 'x2')).toBeDefined();
    expect(out.scopeDrops.total).toBe(0);
  });

  it('keeps a recall-only row belonging to this project', async () => {
    const out = await call(
      scopeRouter([{ row: { id: 'x3', name: 'mine', project: 'demo' }, score: 0.9 }])
    );
    expect(out.byType.Memory.find((r) => r.row.id === 'x3')).toBeDefined();
    expect(out.scopeDrops.total).toBe(0);
  });

  // Absent is not evidence of being out of scope, and dropping a row on a
  // missing field would be the same conflation as reading a missing
  // `lexicalEnabled` as `off`. A row we cannot prove is foreign is
  // kept and counted separately, so the render can say so rather than imply it.
  it('keeps a recall-only row whose project field is ABSENT, and counts it as unknown', async () => {
    const out = await call(scopeRouter([{ row: { id: 'x4', name: 'no field' }, score: 0.9 }]));
    expect(out.byType.Memory.find((r) => r.row.id === 'x4')).toBeDefined();
    expect(out.scopeDrops.total).toBe(0);
    expect(out.scopeDrops.unknown).toBe(1);
  });

  // SYNOPTIC_PROJECT_SCOPE=all means every project is in scope, so there is
  // nothing foreign to drop and the structural arm does not filter either.
  it('drops nothing when the scope is all projects', async () => {
    const out = await call(
      scopeRouter([{ row: { id: 'x5', name: 'other', project: 'app' }, score: 0.9 }]),
      null
    );
    expect(out.byType.Memory.find((r) => r.row.id === 'x5')).toBeDefined();
    expect(out.scopeDrops.total).toBe(0);
  });

  // The candidate projection has to ASK for `project`, or every structurally
  // fetched row arrives without it and the render cannot report the split.
  it('projects `project` on candidates so the split is computable', async () => {
    let asked = null;
    const fetchImpl = (_url, init) => {
      const payload = JSON.parse(init.body);
      const key = Object.keys(payload)[0];
      if (key !== 'recall/Hit' && asked === null) asked = payload[key].fields;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { [key]: [] } })
      });
    };
    await call(fetchImpl);
    expect(asked?.project).toBe(true);
  });
});

// ---- `recall/Hit` returns a row as the EMBEDDING captured it, not as the store
// holds it now, so a row whose `project` was set after it was embedded comes
// back without the field and could be a foreign row escaping the filter.
//
// Absent is not evidence of foreignness, so such rows are not dropped; one
// id-filtered query resolves their project instead, going to where the
// evidence lives rather than guessing at the say-site.
describe('buildScoredByType resolves unknown-project recall rows', () => {
  function resolvingRouter({ recall, resolve }) {
    const seen = [];
    const impl = (_url, init) => {
      const payload = JSON.parse(init.body);
      const key = Object.keys(payload)[0];
      if (key === 'recall/Hit') {
        const { type } = payload[key].params;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { [key]: recall[type] ?? [] } })
        });
      }
      const where = payload[key].params.where;
      if (where?.id?.in) {
        seen.push({ key, ids: where.id.in });
        const type = key.split('/')[1];
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { [key]: resolve[type] ?? [] } })
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { [key]: [] } })
      });
    };
    impl.seen = seen;
    return impl;
  }

  const call = (fetchImpl) =>
    buildScoredByType({
      substrateUrl: 'https://h',
      namespace: 'claude',
      projectSlug: 'demo',
      anchorText: 'x',
      nowMs: NOW,
      fetchImpl
    });

  it('drops a row the store says belongs elsewhere, even though recall omitted the field', async () => {
    const fetchImpl = resolvingRouter({
      recall: { Memory: [{ row: { id: 'stale', type: 'user', name: 'n' }, score: 0.9 }] },
      resolve: { Memory: [{ id: 'stale', project: 'substrate' }] }
    });
    const out = await call(fetchImpl);
    expect(out.byType.Memory.find((r) => r.row.id === 'stale')).toBeUndefined();
    expect(out.scopeDrops.byProject).toEqual({ substrate: 1 });
    expect(out.scopeDrops.unknown).toBe(0);
  });

  it('keeps a row the store says is cross-cutting', async () => {
    const fetchImpl = resolvingRouter({
      recall: { Memory: [{ row: { id: 'stale', type: 'user', name: 'n' }, score: 0.9 }] },
      resolve: { Memory: [{ id: 'stale', project: null }] }
    });
    const out = await call(fetchImpl);
    expect(out.byType.Memory.find((r) => r.row.id === 'stale')).toBeDefined();
    expect(out.scopeDrops.total).toBe(0);
    expect(out.scopeDrops.unknown).toBe(0);
  });

  // A row the resolution query does not answer for stays unknown and stays IN.
  // Two reads disagreeing is not evidence of foreignness either.
  it('leaves a row unresolved-and-kept when the store returns nothing for it', async () => {
    const fetchImpl = resolvingRouter({
      recall: { Memory: [{ row: { id: 'ghost', type: 'user', name: 'n' }, score: 0.9 }] },
      resolve: { Memory: [] }
    });
    const out = await call(fetchImpl);
    expect(out.byType.Memory.find((r) => r.row.id === 'ghost')).toBeDefined();
    expect(out.scopeDrops.unknown).toBe(1);
  });

  it('sends no resolution query when every recall row already carries a project', async () => {
    const fetchImpl = resolvingRouter({
      recall: {
        Memory: [{ row: { id: 'ok', type: 'user', name: 'n', project: null }, score: 0.9 }]
      },
      resolve: {}
    });
    await call(fetchImpl);
    expect(fetchImpl.seen).toEqual([]);
  });
});

// The server filters recall by project when asked (substrate >= 7.11): k fills with
// in-scope rows instead of being spent on rows the client then drops.
describe('buildScoredByType asks recall/Hit for its scope', () => {
  function capturing({ refuseWhere = false, recall = {} } = {}) {
    const recallParams = [];
    const fetchImpl = (_url, init) => {
      const payload = JSON.parse(init.body);
      const key = Object.keys(payload)[0];
      const ok = (data, errors) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data, ...(errors ? { errors } : {}) })
        });
      if (key === 'recall/Hit') {
        const params = payload[key].params;
        recallParams.push(params);
        if (refuseWhere && params.where !== undefined) {
          return ok({}, [
            {
              path: [key],
              code: 'bad_request',
              message:
                'unknown parameter: where. This surface accepts: boost, expand, explain, k, lexical, namespace, returnVector, threshold, to, type'
            }
          ]);
        }
        return ok({ [key]: recall[params.type] ?? [] });
      }
      return ok({ [key]: [] });
    };
    return { fetchImpl, recallParams };
  }
  const opts = (fetchImpl, projectSlug) => ({
    substrateUrl: 'https://h',
    namespace: 'cortext',
    projectSlug,
    anchorText: 'x',
    nowMs: NOW,
    fetchImpl
  });

  it('sends where { project: { in: [slug, null] } } on every recall frame', async () => {
    const { fetchImpl, recallParams } = capturing();
    await buildScoredByType(opts(fetchImpl, 'synoptic'));
    expect(recallParams).toHaveLength(3);
    for (const p of recallParams) expect(p.where).toEqual({ project: { in: ['synoptic', null] } });
  });

  it('sends no where when the scope is all projects', async () => {
    const { fetchImpl, recallParams } = capturing();
    await buildScoredByType(opts(fetchImpl, null));
    for (const p of recallParams) expect(p).not.toHaveProperty('where');
  });

  it('a server that refuses where is asked again without it, and the client filter still applies', async () => {
    const { fetchImpl, recallParams } = capturing({
      refuseWhere: true,
      recall: {
        Memory: [
          { row: { id: 'mine', project: 'synoptic' }, score: 0.9 },
          { row: { id: 'theirs', project: 'substrate' }, score: 0.8 }
        ]
      }
    });
    const failures = [];
    const out = await buildScoredByType({
      ...opts(fetchImpl, 'synoptic'),
      projectionAudit: {
        record: () => {},
        recordFailure: (k, d) => failures.push([k, d]),
        recordEverywhere: () => {}
      }
    });
    expect(out.recallAvailable).toBe(true);
    expect(recallParams.filter((p) => p.where === undefined)).toHaveLength(3);
    // The refused scoped ask is expected on an older server, not a fault to report.
    expect(failures.filter(([k]) => k === 'recall/Hit')).toEqual([]);
    expect(out.byType.Memory.map((e) => e.row.id)).toEqual(['mine']);
    expect(out.scopeDrops.total).toBe(1);
  });

  it('a transport failure on the scoped ask is not retried', async () => {
    let recallCalls = 0;
    const { fetchImpl: base } = capturing();
    const fetchImpl = (url, init) => {
      if (Object.keys(JSON.parse(init.body))[0] === 'recall/Hit') {
        recallCalls++;
        return Promise.reject(new Error('network down'));
      }
      return base(url, init);
    };
    const out = await buildScoredByType(opts(fetchImpl, 'synoptic'));
    // One ask per type: a dead server costs one timeout, not two.
    expect(recallCalls).toBe(3);
    expect(out.recallAvailable).toBe(false);
  });
});
