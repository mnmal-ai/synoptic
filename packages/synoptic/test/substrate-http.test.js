import { describe, expect, it } from 'vitest';
import { probeWhoami, recall, substrateQuery } from '../src/substrate-http.js';

function mockFetch(handler) {
  return (url, init) => Promise.resolve(handler(url, init));
}
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

describe('substrateQuery', () => {
  it('posts the payload to /substrate/v1/query and returns data', async () => {
    let seenUrl, seenBody;
    const fetchImpl = mockFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body);
      return jsonResponse(200, { data: { 'claude/Memory': [{ id: 'm1' }] } });
    });
    const data = await substrateQuery(
      'https://h:3100',
      { 'claude/Memory': { params: {}, fields: { id: true } } },
      { fetchImpl }
    );
    expect(seenUrl).toBe('https://h:3100/substrate/v1/query');
    expect(seenBody['claude/Memory'].fields.id).toBe(true);
    expect(data['claude/Memory']).toEqual([{ id: 'm1' }]);
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(500, {}));
    await expect(substrateQuery('https://h:3100', {}, { fetchImpl })).rejects.toThrow();
  });

  it('hands the per-frame _pagination map to onPagination', async () => {
    const pagination = { 'cortext/Todo': { hasMore: true, nextCursor: 'c1' } };
    const fetchImpl = mockFetch(() =>
      jsonResponse(200, { data: { 'cortext/Todo': [{ id: 't1' }] }, _pagination: pagination })
    );
    let seen;
    const data = await substrateQuery(
      'https://h:3100',
      { 'cortext/Todo': { params: { limit: 1 }, fields: { id: true } } },
      { fetchImpl, onPagination: (p) => (seen = p) }
    );
    expect(seen).toEqual(pagination);
    expect(data['cortext/Todo']).toEqual([{ id: 't1' }]);
  });

  it('passes an empty map to onPagination when the server sends none', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { data: {} }));
    let seen;
    await substrateQuery('https://h:3100', {}, { fetchImpl, onPagination: (p) => (seen = p) });
    expect(seen).toEqual({});
  });
});

describe('recall', () => {
  it('returns rows on an answered frame', async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe('https://h:3100/substrate/v1/query');
      expect(JSON.parse(init.body)['recall/Hit'].params).toMatchObject({
        to: 'anchor',
        namespace: 'claude',
        type: 'Memory',
        k: 60
      });
      return jsonResponse(200, { data: { 'recall/Hit': [{ row: { id: 'm1' }, score: 0.9 }] } });
    });
    const rows = await recall('https://h:3100', {
      query: 'anchor',
      namespace: 'claude',
      type: 'Memory',
      k: 60,
      fetchImpl
    });
    expect(rows).toEqual([{ row: { id: 'm1' }, score: 0.9 }]);
  });

  it('distinguishes a REFUSED frame from a true empty', async () => {
    // The distinction `data[key] ?? []` destroys is presence, not emptiness.
    // A refusal must read as "semantic unavailable" (null) so the render
    // degrades to structural; an answered-but-empty recall is a real negative
    // and must NOT disable the hybrid path for the other types.
    const refused = mockFetch(() =>
      jsonResponse(200, {
        data: {},
        errors: [{ path: ['recall/Hit'], code: 'embedder_unavailable', message: 'no embedder' }]
      })
    );
    // Collect ALL reports. Both detectors fire on a refusal — the server's own
    // `errors` entry and this client's requested-vs-answered check — and
    // keeping only the last would assert against whichever ran second.
    const reported = [];
    expect(
      await recall('https://h:3100', {
        query: 'a',
        namespace: 'claude',
        type: 'Memory',
        fetchImpl: refused,
        onFrameFailure: (k, d) => reported.push(`${k} ${d}`)
      })
    ).toBeNull();
    expect(reported.join(' | ')).toMatch(/recall\/Hit embedder_unavailable/);

    const empty = mockFetch(() => jsonResponse(200, { data: { 'recall/Hit': [] } }));
    expect(
      await recall('https://h:3100', {
        query: 'a',
        namespace: 'claude',
        type: 'Memory',
        fetchImpl: empty
      })
    ).toEqual([]);
  });

  it('returns null on 503 (recall not configured)', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(503, { error: 'recall not configured' }));
    const rows = await recall('https://h:3100', {
      query: 'a',
      namespace: 'claude',
      type: 'Memory',
      fetchImpl
    });
    expect(rows).toBeNull();
  });

  it('returns null on network error', async () => {
    const fetchImpl = () => Promise.reject(new Error('ECONNREFUSED'));
    const rows = await recall('https://h:3100', {
      query: 'a',
      namespace: 'claude',
      type: 'Memory',
      fetchImpl
    });
    expect(rows).toBeNull();
  });
});

// ---- whoami lives at `/substrate/v1/whoami` and answers `authEnabled` + `identity` ----
//
// The old `/substrate/v1/admin/whoami` has NO alias. A client pinned to it does
// not degrade — it 404s, and `!res.ok` would render that one regex away from the
// 401 branch that means REVOKED CREDENTIAL.

describe('probeWhoami', () => {
  it('asks the current path and reads the identity out of the new shape', async () => {
    let seen;
    const fetchImpl = mockFetch((url) => {
      seen = url;
      return jsonResponse(200, {
        authEnabled: true,
        identity: { id: 'a@h', capabilities: ['read', 'mutate'], namespaces: ['cortext', 'recall'] }
      });
    });
    const w = await probeWhoami('https://h:3100', { fetchImpl });
    expect(seen).toBe('https://h:3100/substrate/v1/whoami');
    expect(w).toEqual({
      ok: true,
      authEnabled: true,
      authenticated: true,
      id: 'a@h',
      capabilities: ['read', 'mutate'],
      namespaces: ['cortext', 'recall'],
      // Absent on the wire, `null` here: substrate attaches `grants` only to a
      // dataset-backed verification, so a file-registry key legitimately has
      // none and its flat `capabilities` is the whole truth about it.
      grants: null
    });
  });

  it('carries the per-namespace grant through, and keeps the flat view beside it', async () => {
    // substrate >= 5.23.0. A UNIFORM grant keeps `capabilities`
    // non-null, so the flat readers downstream are unaffected — the point of
    // this case is that `grants` survives the normalisation rather than being
    // dropped, which would make the audit report a working server as skew.
    const w = await probeWhoami('https://h:3100', {
      fetchImpl: mockFetch(() =>
        jsonResponse(200, {
          authEnabled: true,
          identity: {
            id: 'a@h',
            capabilities: ['read', 'mutate'],
            namespaces: ['cortext', 'recall'],
            grants: { cortext: ['read', 'mutate'], recall: ['read', 'mutate'] }
          }
        })
      )
    });
    expect(w.capabilities).toEqual(['read', 'mutate']);
    expect(w.grants).toEqual({ cortext: ['read', 'mutate'], recall: ['read', 'mutate'] });
  });

  it('a NON-uniform grant nulls `capabilities` on the wire and that is not a failure', async () => {
    // The state the flat field cannot express. `null` is substrate's deliberate
    // refusal to render the union — which would say `mutate` because it is
    // held SOMEWHERE — so the answer has to be read out of `grants`.
    const w = await probeWhoami('https://h:3100', {
      fetchImpl: mockFetch(() =>
        jsonResponse(200, {
          authEnabled: true,
          identity: {
            id: 'a@h',
            capabilities: null,
            namespaces: ['cortext', 'plane'],
            grants: { cortext: ['read', 'mutate'], plane: ['read'] }
          }
        })
      )
    });
    expect(w.ok).toBe(true);
    expect(w.authenticated).toBe(true);
    expect(w.capabilities).toBe(null);
    expect(w.grants).toEqual({ cortext: ['read', 'mutate'], plane: ['read'] });
  });

  it('a malformed grant is rejected WHOLE, never half-read', async () => {
    // A half-understood grant is worse than none: the audit decides `read` per
    // namespace from this map, so one entry arriving as a non-array would read
    // as "no capabilities there" and manufacture a WARN. Falling back to the
    // flat reading is coarser and never wrong.
    for (const bad of [{ cortext: 'read' }, { cortext: ['read'], plane: [1] }, ['cortext'], 7]) {
      const w = await probeWhoami('https://h:3100', {
        fetchImpl: mockFetch(() =>
          jsonResponse(200, {
            authEnabled: true,
            identity: { id: 'a@h', capabilities: ['read'], namespaces: ['cortext'], grants: bad }
          })
        )
      });
      expect(w.grants).toBe(null);
      expect(w.capabilities).toEqual(['read']);
    }
  });

  it('an EMPTY grant is a real state, not a malformed one', async () => {
    // `intersectGrants` drops a namespace that resolves to no capability, so
    // `{}` is exactly what a key whose claim and row share nothing looks like.
    // Rejecting it would fall back to the flat view and report the emptiness as
    // a shape problem.
    const w = await probeWhoami('https://h:3100', {
      fetchImpl: mockFetch(() =>
        jsonResponse(200, {
          authEnabled: true,
          identity: { id: 'a@h', capabilities: null, namespaces: [], grants: {} }
        })
      )
    });
    expect(w.grants).toEqual({});
  });

  it('keeps auth-disabled and credential-never-arrived DISTINCT', async () => {
    // The entire reason `authEnabled` was added. One is a deployment posture
    // the caller cannot change; the other is env vars that never took effect.
    const off = await probeWhoami('https://h:3100', {
      fetchImpl: mockFetch(() => jsonResponse(200, { authEnabled: false, identity: null }))
    });
    expect(off).toEqual({ ok: true, authEnabled: false, authenticated: false });

    const anon = await probeWhoami('https://h:3100', {
      fetchImpl: mockFetch(() => jsonResponse(200, { authEnabled: true, identity: null }))
    });
    expect(anon).toEqual({ ok: true, authEnabled: true, authenticated: false });
  });

  it('a 401 stays a REJECTED credential — not a hole, and not anonymous', async () => {
    const w = await probeWhoami('https://h:3100', {
      fetchImpl: mockFetch(() => jsonResponse(401, { code: 'unauthorized' }))
    });
    expect(w).toEqual({ ok: false, failed: 'whoami 401' });
  });

  it('a 404 names the route — a version fact, never a credential one', async () => {
    const w = await probeWhoami('https://h:3100', {
      fetchImpl: mockFetch(() => jsonResponse(404, { error: 'Not Found' }))
    });
    expect(w.ok).toBe(false);
    expect(w.failed).toMatch(/\/substrate\/v1\/whoami/);
    // One character apart from the branch that means a revoked key.
    expect(w.failed).not.toMatch(/\b401\b/);
  });

  it('an identity in a shape this client does not understand is null, never empty', async () => {
    // Reading absent-as-empty would UNDERSTATE authority; reading a missing
    // `authEnabled` as false would manufacture a security finding out of skew.
    const w = await probeWhoami('https://h:3100', {
      fetchImpl: mockFetch(() => jsonResponse(200, { identity: { id: 'a@h' } }))
    });
    expect(w).toMatchObject({
      authEnabled: null,
      authenticated: true,
      capabilities: null,
      namespaces: null
    });
  });
});
