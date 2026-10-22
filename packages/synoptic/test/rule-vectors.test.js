import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fetchRowVectors, toRefs } from '../src/rule-vectors.js';

// The fetch goes over FRAME dispatch, because the kernel routes
// 401 a signed agent token. So every fixture here wraps its payload in the
// frame envelope — and the envelope is not cosmetic: a REFUSED frame is an HTTP
// 200 whose key is absent from `data`.
const FETCH_KEY = 'recall/fetchEmbeddings';
const frame = (key, body) => () =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: { [key]: body } })
  });
const ok = (body) => frame(FETCH_KEY, body);

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

test('toRefs builds the wire shape and drops rows with no id', () => {
  assert.deepEqual(toRefs([{ id: 'a' }, { shortId: 3 }], 'cortext', 'AgentRule'), [
    { namespace: 'cortext', type: 'AgentRule', id: 'a' }
  ]);
});
