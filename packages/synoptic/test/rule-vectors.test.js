import assert from 'node:assert/strict';
import { test } from 'vitest';
import { boostSalience, fetchRowVectors, toRefs, toShortIdVectors } from '../src/rule-vectors.js';

// Both operations go over FRAME dispatch, because the kernel routes
// 401 a signed agent token. So every fixture here wraps its payload in the
// frame envelope — and the envelope is not cosmetic: a REFUSED frame is an HTTP
// 200 whose key is absent from `data`.
const FETCH_KEY = 'recall/fetchEmbeddings';
const BOOST_KEY = 'recall/boost';
const frame = (key, body) => () =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: { [key]: body } })
  });
const ok = (body) => frame(FETCH_KEY, body);
const okBoost = (body) => frame(BOOST_KEY, body);

test('fetchRowVectors maps id -> vector', async () => {
  const fetchImpl = ok({
    model: 'bge-m3:1024',
    vectors: [
      { namespace: 'cortext', type: 'AgentRule', id: 'a', vector: [1, 0] },
      { namespace: 'cortext', type: 'AgentRule', id: 'b', vector: [0, 1] }
    ]
  });
  const m = await fetchRowVectors(
    'https://h',
    [{ namespace: 'cortext', type: 'AgentRule', id: 'a' }],
    {
      fetchImpl
    }
  );
  assert.deepEqual(m.get('a'), [1, 0]);
  assert.equal(m.size, 2);
});

test('fetchRowVectors sends the shape the server asked for', async () => {
  // The contract was read off the server's own 400, not off documentation:
  // `"refs" must be a non-empty array of { namespace, type, id }`.
  let sent = null;
  const fetchImpl = (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ vectors: [] }) });
  };
  await fetchRowVectors('https://h', [{ namespace: 'cortext', type: 'AgentRule', id: 'x' }], {
    fetchImpl
  });
  assert.match(sent.url, /\/substrate\/v1\/mutate$/);
  assert.deepEqual(sent.body, {
    [FETCH_KEY]: {
      params: { refs: [{ namespace: 'cortext', type: 'AgentRule', id: 'x' }] },
      fields: { model: true, vectors: true }
    }
  });
  // NO `boost` field. A fetch reinforces only when asked, and
  // this module fetches every active rule in order to RANK them — reinforcing
  // all of them would drown the explicit boost of the few that got promoted.
  assert.equal('boost' in sent.body[FETCH_KEY].params, false);
});

test('fetchRowVectors returns an EMPTY map on failure, never throws', async () => {
  // The salient tier degrades to structural-only, which is exactly what it does
  // today — a cold-start must lose context, never be lost.
  for (const fetchImpl of [
    () => Promise.reject(new Error('ECONNREFUSED')),
    () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    ok({ vectors: 'not-an-array' }),
    // A REFUSED frame: 200, key absent from `data`, reason in `errors`. Reading
    // this as "no vectors stored" is the mistake the frame envelope exists to
    // make impossible to write by accident.
    () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {},
            errors: [{ path: [FETCH_KEY], code: 'policy_denied', message: 'denied' }]
          })
      })
  ]) {
    const m = await fetchRowVectors('https://h', [{ namespace: 'n', type: 't', id: 'i' }], {
      fetchImpl
    });
    assert.equal(m.size, 0);
  }
});

test('fetchRowVectors makes no call for an empty ref list', async () => {
  let called = false;
  await fetchRowVectors('https://h', [], {
    fetchImpl: () => {
      called = true;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
  });
  assert.equal(called, false);
});

test('a row with no stored vector is simply absent', async () => {
  // The server returns `{"vectors":[]}` for a ref it has no embedding
  // for. rankRules skips such rules, so a partially embedded set degrades
  // per-rule rather than collapsing to structural.
  const m = await fetchRowVectors('https://h', [{ namespace: 'n', type: 't', id: 'i' }], {
    fetchImpl: ok({ vectors: [] })
  });
  assert.equal(m.size, 0);
});

test('toShortIdVectors rekeys uuid -> shortId, which is what rankRules wants', () => {
  const rules = [
    { id: 'a', shortId: 7 },
    { id: 'b', shortId: 21 },
    { id: 'c', shortId: 44 }
  ];
  const byId = new Map([
    ['a', [1, 0]],
    ['c', [0, 1]]
  ]);
  const m = toShortIdVectors(rules, byId);
  assert.deepEqual(
    [...m.keys()].sort((x, y) => x - y),
    [7, 44]
  );
  assert.ok(!m.has(21), 'a rule with no vector is omitted, not zero-filled');
});

test('toShortIdVectors skips rows missing either identifier', () => {
  const m = toShortIdVectors([{ shortId: 7 }, { id: 'b' }, {}], new Map([['b', [1]]]));
  assert.equal(m.size, 0);
});

test('toRefs builds the wire shape and drops rows with no id', () => {
  assert.deepEqual(toRefs([{ id: 'a' }, { shortId: 3 }], 'cortext', 'AgentRule'), [
    { namespace: 'cortext', type: 'AgentRule', id: 'a' }
  ]);
});

test('boostSalience reports APPLIED', async () => {
  // substrate >= 5.7.0 reports `applied` and `missing`, not just `{ok, requested}`.
  const fetchImpl = okBoost({ ok: true, requested: 3, applied: 3, missing: [] });
  const r = await boostSalience(
    'https://h',
    ['a', 'b', 'c'].map((id) => ({ namespace: 'cortext', type: 'AgentRule', id })),
    { fetchImpl }
  );
  assert.equal(r.applied, 3);
  assert.deepEqual(r.missing, []);
});

test('a promoted rule with NO embedding row shows as requested !== applied', async () => {
  // Real and diagnosable, not noise: a rule that exists but was never embedded.
  // `missing` names which, so this is a list rather than a count.
  const fetchImpl = okBoost({
    ok: true,
    requested: 2,
    applied: 1,
    missing: [{ namespace: 'cortext', type: 'AgentRule', id: 'never-embedded' }]
  });
  const r = await boostSalience(
    'https://h',
    [
      { namespace: 'cortext', type: 'AgentRule', id: 'a' },
      { namespace: 'cortext', type: 'AgentRule', id: 'never-embedded' }
    ],
    { fetchImpl }
  );
  assert.notEqual(r.requested, r.applied);
  assert.equal(r.missing[0].id, 'never-embedded');
});

test('a deployment without `applied` yields applied: null, NOT a manufactured confirmation', async () => {
  // Reporting `applied: requested` on an old deployment would invent a
  // confirmation the server never gave. null lets a caller tell "not supported" from
  // "supported, and zero applied".
  const fetchImpl = okBoost({ ok: true, requested: 1 });
  const r = await boostSalience('https://h', [{ namespace: 'n', type: 't', id: 'i' }], {
    fetchImpl
  });
  assert.equal(r.requested, 1);
  assert.equal(r.applied, null);
});

test('a refused boost is swallowed — an unsigned write SHOULD be denied', async () => {
  // On a deployment gating writes by identity, an anonymous cold-start being
  // refused is correct behaviour, not a fault to surface. Over frames the
  // refusal arrives as a 200 with the key absent, not as a 403 status, so the
  // client must read PRESENCE — `data[key] ?? {}` would report a phantom
  // `requested` here and the audit would call it `unknown` for the wrong reason.
  const refused = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: {},
          errors: [{ path: [BOOST_KEY], code: 'policy_denied', message: 'writes require identity' }]
        })
    });
  // Collect ALL reports: the server's own `errors` entry AND this client's
  // requested-vs-answered check both fire, and keeping only the last would
  // assert against whichever ran second.
  const reported = [];
  assert.equal(
    await boostSalience('https://h', [{ namespace: 'n', type: 't', id: 'i' }], {
      fetchImpl: refused,
      onFrameFailure: (k, d) => reported.push(`${k} ${d}`)
    }),
    null
  );
  // Swallowed for the RENDER, surfaced to the AUDIT, so the degradation is never silent.
  assert.match(reported.join(' | '), /recall\/boost policy_denied/);
});

test('a transport 403 is still swallowed', async () => {
  const fetchImpl = () =>
    Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
  assert.equal(
    await boostSalience('https://h', [{ namespace: 'n', type: 't', id: 'i' }], { fetchImpl }),
    null
  );
});

test('boostSalience posts targets and reports the REQUESTED count', async () => {
  let sent = null;
  const fetchImpl = (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { [BOOST_KEY]: { ok: true, requested: 2 } } })
    });
  };
  const r = await boostSalience(
    'https://h',
    [
      { namespace: 'cortext', type: 'AgentRule', id: 'a' },
      { namespace: 'cortext', type: 'AgentRule', id: 'b' }
    ],
    { fetchImpl }
  );
  assert.match(sent.url, /\/substrate\/v1\/mutate$/);
  assert.equal(sent.body[BOOST_KEY].params.targets.length, 2);
  assert.deepEqual(sent.body[BOOST_KEY].fields, {
    ok: true,
    requested: true,
    applied: true,
    missing: true
  });
  // `requested` reflects INTENT and is kept only so a caller can spot a
  // difference from `applied`, which reflects EFFECT.
  assert.equal(r.requested, 2);
});

test('boostSalience returns null on failure rather than throwing', async () => {
  for (const fetchImpl of [
    () => Promise.reject(new Error('down')),
    () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
  ]) {
    assert.equal(
      await boostSalience('https://h', [{ namespace: 'n', type: 't', id: 'i' }], { fetchImpl }),
      null
    );
  }
});

test('boostSalience makes no call for an empty target list', async () => {
  let called = false;
  await boostSalience('https://h', [], {
    fetchImpl: () => {
      called = true;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
  });
  assert.equal(called, false);
});
