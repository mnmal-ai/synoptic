// The cold-start's independent roots must be IN FLIGHT TOGETHER.
//
// Run as a staircase (`loadInbox` → `loadConcepts` → `resolveAnchorHttp` → open
// work → schema), each `await` adds pure latency, and the recall fan-out, the
// longest pole, starts last.
//
// ## Why this test gates rather than counts
//
// The obvious test — record request order and assert it — cannot fail. Any
// order is *a* valid order, and a serial run produces a perfectly plausible
// one. The obvious alternative, asserting wall-clock, is a flake generator.
//
// So the harness WITHHOLDS every response until N distinct roots have been
// requested. Under the concurrent implementation all N are issued before any
// resolves and the gate opens. Under a serial one, root 2 is never requested
// because root 1's response never arrives — the run deadlocks, and the gate's
// own timeout turns that into a named assertion rather than a hung suite.
//
// That is the property worth pinning: not "these were fast" but "these did not
// wait for each other". A future `await` reintroducing the staircase fails here
// immediately, which is exactly how the staircase got there in the first place
// — one `await` at a time, each individually reasonable.

import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { runColdStart } from '../src/cold-start.js';

const jsonOk = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });

/** The five independent roots, identified by what each one asks for first. */
const ROOTS = {
  inbox: 'claude/AgentIdentity',
  concepts: 'claude/Concept',
  anchor: 'claude/AnchorIntent',
  openWork: 'claude/Todo',
  schema: '/substrate/v1/schema'
};

/**
 * A fetch that answers nothing until every root has asked.
 *
 * @param {number} timeoutMs how long to wait before declaring the gate stuck
 */
function gatedFetch(timeoutMs = 2000) {
  const wanted = new Set(Object.values(ROOTS));
  const seen = new Set();
  let open = false;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const stuck = new Promise((_, rej) =>
    setTimeout(
      () =>
        rej(
          new Error(
            `roots did not run concurrently — still waiting for: ${[...wanted]
              .filter((w) => !seen.has(w))
              .join(', ')} (saw: ${[...seen].join(', ') || 'nothing'})`
          )
        ),
      timeoutMs
    ).unref?.()
  );

  const note = (id) => {
    if (wanted.has(id)) seen.add(id);
    if (!open && wanted.size === seen.size) {
      open = true;
      release();
    }
  };

  const fetchImpl = async (url, init) => {
    if (String(url).includes('/substrate/v1/schema')) {
      note(ROOTS.schema);
      await Promise.race([gate, stuck]);
      return jsonOk({ types: {} });
    }
    if (String(url).endsWith('/substrate/v1/embed-stats')) return jsonOk({ enabled: false });

    // The vector frames go over /substrate/v1/MUTATE, not /substrate/v1/query — `fetchRowVectors`
    // and `boostSalience` both call `substrateMutate`. A stub that routes only
    // /substrate/v1/query drops them into its catch-all, which returns a body with the
    // key ABSENT, which the hook then correctly reports as a rejected frame. The
    // banner that produces reads as a defect in the code under test; it is a
    // defect in the stub. Key present and empty is the honest empty answer.
    if (String(url).endsWith('/substrate/v1/mutate')) {
      const payload = JSON.parse(init.body);
      const data = {};
      for (const key of Object.keys(payload)) data[key] = { model: 'stub', vectors: [] };
      return jsonOk({ data });
    }
    if (!String(url).endsWith('/substrate/v1/query')) return jsonOk({ data: {} });

    const payload = JSON.parse(init.body);
    for (const key of Object.keys(payload)) note(key);

    // recall/Hit is a DEPENDENT, not a root — it cannot be issued before the
    // gate opens, so it must not wait behind it or the run deadlocks on its own
    // dependency edges. Answered with the key PRESENT and empty: an absent key
    // is a refusal, and this test is not about refusals.
    if ('recall/Hit' in payload) return jsonOk({ data: { 'recall/Hit': [] } });

    await Promise.race([gate, stuck]);
    const data = {};
    for (const key of Object.keys(payload)) {
      data[key] =
        key === 'claude/AgentIdentity'
          ? [{ id: 'id-1', kid: 'a@h', active: true }]
          : key === 'claude/AnchorIntent'
            ? [{ id: 'a1', synopsis: 'build it', _metadata: { createdAt: '2026-06-01T00:00:00Z' } }]
            : key === 'claude/Todo'
              ? [{ shortId: 12, title: 'ship it', status: 'open', priority: 'high', area: 'x' }]
              : [];
    }
    return jsonOk({ data });
  };

  return { fetchImpl, seen };
}

const base = {
  substrateUrl: 'https://h:3100',
  namespace: 'claude',
  projectSlug: 'demo',
  agentKid: 'a@h',
  nowMs: Date.UTC(2026, 5, 4)
};

test('the five independent roots are all in flight before any response arrives', async () => {
  const { fetchImpl, seen } = gatedFetch();
  const out = await runColdStart({ ...base, fetchImpl });

  // The gate only opened because all five had asked. Restate it as an
  // assertion so a future change to the gate cannot make this vacuous.
  for (const [name, key] of Object.entries(ROOTS)) {
    assert.ok(seen.has(key), `root '${name}' (${key}) never issued its request`);
  }
  // And the render still happened — a deadlock-free run that produced nothing
  // would satisfy the above while proving the hook broken.
  expect(out).toContain('## Open Work');
  expect(out).toContain('#12 ship it');
  // No rejected-frame banner: every frame the hook asked for came back.
  expect(out).not.toContain('Cold-start is INCOMPLETE');
});

test('a genuinely dependent call still waits for its root', async () => {
  // The discriminating case. Concurrency is only correct where there is no
  // dependency, and one real edge survives inside the inbox: `recipient` is a
  // crossRef taking the AgentIdentity row's UUID, so the mail query CANNOT be
  // built until the identity resolves. If a refactor "parallelised" that too,
  // the mail query would carry an undefined recipient and quietly read the
  // whole fleet's mail — the failure the conventions fragment warns about.
  const order = [];
  const fetchImpl = async (url, init) => {
    if (!String(url).endsWith('/substrate/v1/query')) return jsonOk({ data: {}, types: {} });
    const payload = JSON.parse(init.body);
    const keys = Object.keys(payload);
    for (const k of keys) order.push(k);
    const data = {};
    for (const k of keys) {
      data[k] =
        k === 'claude/AgentIdentity' ? [{ id: 'identity-uuid', kid: 'a@h', active: true }] : [];
    }
    if ('claude/AgentMessage' in payload) {
      // The whole point: the recipient filter must carry the resolved UUID.
      assert.equal(
        payload['claude/AgentMessage'].params?.where?.recipient?.eq,
        'identity-uuid',
        'the mail query was built before the identity resolved'
      );
    }
    return jsonOk({ data });
  };

  await runColdStart({ ...base, fetchImpl });

  const identity = order.indexOf('claude/AgentIdentity');
  const message = order.indexOf('claude/AgentMessage');
  assert.ok(identity !== -1, 'identity was never queried');
  assert.ok(
    message === -1 || identity < message,
    'the mail query must follow the identity it depends on'
  );
});
