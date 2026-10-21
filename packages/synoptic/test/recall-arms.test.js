import assert from 'node:assert/strict';
import { test } from 'vitest';
import { describeRecallArms } from '../src/recall-arms.js';

// ---- The cold-start header must not assert WHICH ARMS RAN from a fact that
// only establishes that rows came back. These tests pin the one rule that
// makes the header honest: an arm is only ever reported as wired when the
// server said so, and every other state is `unknown` — never `off`.
//
// The three recall types the cold-start actually queries.
const TYPES = ['Memory', 'SessionLog', 'Decision'];

function stats(overrides = {}) {
  const declared = TYPES.map((type) => ({ namespace: 'cortext', type }));
  return {
    reachable: true,
    enabled: true,
    embeddedTypes: declared,
    lexicalEnabled: true,
    lexicalTypes: declared,
    ...overrides
  };
}

test('describeRecallArms: both arms wired for every recall type → hybrid is earned', () => {
  const arms = describeRecallArms({ stats: stats(), namespace: 'cortext', types: TYPES });
  assert.equal(arms.dense, 'wired');
  assert.equal(arms.lexical, 'wired');
  assert.match(arms.label, /hybrid/);
});

test('describeRecallArms: lexical explicitly off → dense only, and never claims hybrid', () => {
  const arms = describeRecallArms({
    stats: stats({ lexicalEnabled: false, lexicalTypes: [] }),
    namespace: 'cortext',
    types: TYPES
  });
  assert.equal(arms.dense, 'wired');
  assert.equal(arms.lexical, 'off');
  assert.doesNotMatch(arms.label, /hybrid/);
  assert.match(arms.label, /dense/);
});

test('describeRecallArms: dense explicitly off → lexical only, and never claims hybrid', () => {
  const arms = describeRecallArms({
    stats: stats({ enabled: false, embeddedTypes: [] }),
    namespace: 'cortext',
    types: TYPES
  });
  assert.equal(arms.dense, 'off');
  assert.equal(arms.lexical, 'wired');
  assert.doesNotMatch(arms.label, /hybrid/);
  assert.match(arms.label, /lexical/);
});

// The compat case, and the one most likely to reintroduce the defect: a server
// that predates the lexical fields reports neither. Absent is NOT false — reading a missing key as
// `off` would be the same conflation one layer down.
test('describeRecallArms: server that never reported lexical → unknown, not off', () => {
  const older = stats();
  delete older.lexicalEnabled;
  delete older.lexicalTypes;
  const arms = describeRecallArms({ stats: older, namespace: 'cortext', types: TYPES });
  assert.equal(arms.lexical, 'unknown');
  assert.doesNotMatch(arms.label, /hybrid/);
  assert.match(arms.label, /unverified/);
});

// An unreachable probe is a check that could not run, never a verified fault.
test('describeRecallArms: probe unreachable → both arms unknown, label says unverified', () => {
  const arms = describeRecallArms({
    stats: { reachable: false },
    namespace: 'cortext',
    types: TYPES
  });
  assert.equal(arms.dense, 'unknown');
  assert.equal(arms.lexical, 'unknown');
  assert.match(arms.label, /unverified/);
});

test('describeRecallArms: not probed at all (null) → unknown, label says unverified', () => {
  const arms = describeRecallArms({ stats: null, namespace: 'cortext', types: TYPES });
  assert.equal(arms.dense, 'unknown');
  assert.equal(arms.lexical, 'unknown');
  assert.match(arms.label, /unverified/);
});

// An arm wired but not declared for every type the cold-start queries is not
// the same as the arm covering the query. `partial` keeps that distinct.
test('describeRecallArms: arm wired but a queried type undeclared → partial, not wired', () => {
  const arms = describeRecallArms({
    stats: stats({ embeddedTypes: [{ namespace: 'cortext', type: 'Memory' }] }),
    namespace: 'cortext',
    types: TYPES
  });
  assert.equal(arms.dense, 'partial');
  assert.doesNotMatch(arms.label, /hybrid/);
});

// Declarations are namespace-qualified; another namespace's declaration must
// not be read as covering ours.
test('describeRecallArms: declarations in a different namespace do not count', () => {
  const arms = describeRecallArms({
    stats: stats({ embeddedTypes: TYPES.map((type) => ({ namespace: 'other', type })) }),
    namespace: 'cortext',
    types: TYPES
  });
  assert.equal(arms.dense, 'off');
});

// The evidence line must say what the probe can and cannot establish, so the
// header is not read as proof that both arms answered THIS query.
test('describeRecallArms: evidence names the route and disclaims per-query proof', () => {
  const arms = describeRecallArms({ stats: stats(), namespace: 'cortext', types: TYPES });
  assert.match(arms.evidence, /embed-stats/);
  assert.match(arms.evidence, /configuration/i);
});

// ---- `partial` must be disclosed in the header for every combination. A
// `... arm only` label answers WHICH arm, and a reader takes it to mean that
// arm covered the query, so treating wired and partial alike would hide it.
//
// The rule: an arm that covers some of the queried types and not all must say
// so wherever it is named.
test('describeRecallArms: dense partial with lexical off says so in the label, not only in the evidence', () => {
  const arms = describeRecallArms({
    stats: stats({
      embeddedTypes: [{ namespace: 'cortext', type: 'Memory' }],
      lexicalEnabled: false,
      lexicalTypes: []
    }),
    namespace: 'cortext',
    types: TYPES
  });
  assert.equal(arms.dense, 'partial');
  assert.equal(arms.lexical, 'off');
  assert.match(arms.label, /dense arm only/);
  assert.match(arms.label, /partial/);
  assert.doesNotMatch(arms.label, /hybrid/);
});

test('describeRecallArms: lexical partial with dense off says so in the label too', () => {
  const arms = describeRecallArms({
    stats: stats({
      enabled: false,
      embeddedTypes: [],
      lexicalTypes: [{ namespace: 'cortext', type: 'Memory' }]
    }),
    namespace: 'cortext',
    types: TYPES
  });
  assert.equal(arms.lexical, 'partial');
  assert.equal(arms.dense, 'off');
  assert.match(arms.label, /lexical arm only/);
  assert.match(arms.label, /partial/);
});

// The unqualified `... arm only` label stays unqualified when the arm really
// does cover every queried type — otherwise the qualifier stops meaning
// anything.
test('describeRecallArms: a fully-covering arm with the other off is NOT called partial', () => {
  const arms = describeRecallArms({
    stats: stats({ lexicalEnabled: false, lexicalTypes: [] }),
    namespace: 'cortext',
    types: TYPES
  });
  assert.equal(arms.dense, 'wired');
  assert.equal(arms.label, 'recall — RRF, dense arm only');
});

// ---- The evidence line must not frame per-query arm attribution as an
// instrument limitation, which implies a better instrument would settle it.
// None will: nothing on any surface reports which arm answered, and synoptic
// has declined a per-request `arms` envelope on the recall frame.
//
// A bound that will close is a hedge; a bound that will never close is a fact
// about the system. Stating a permanent bound as an instrument limitation is a
// false implicature, not an understatement: it sends the reader looking for a
// measurement that does not exist.
//
// Contrast the unreachable-probe branch below, which IS an instrument
// limitation and correctly says so — that probe may answer next session.
test('describeRecallArms: evidence names the permanent bound, not a weak probe', () => {
  const arms = describeRecallArms({ stats: stats(), namespace: 'cortext', types: TYPES });
  assert.match(arms.evidence, /nothing records which arm answered/i);
  assert.match(arms.evidence, /strongest claim available/i);
});

// The temporary bound must NOT be rewritten as a fact about the territory —
// that is the inverse error, telling a reader to stop looking at something
// that will be readable again next session.
test('describeRecallArms: an unreachable probe still reads as an instrument limit', () => {
  const arms = describeRecallArms({
    stats: { reachable: false },
    namespace: 'cortext',
    types: TYPES
  });
  assert.match(arms.evidence, /could not be read/i);
  assert.doesNotMatch(arms.evidence, /nothing records which arm answered/i);
});

// ---- The evidence sentence renders on both the unified path and the
// structural fallback, which exists precisely because recall did NOT answer,
// so a clause like "recall answered" would be false on the fallback.
//
// The sentence describes the PROBE. It must not assert anything about whether
// recall ran, because that is the caller's fact and not this module's.
test('describeRecallArms: no evidence string claims recall answered', () => {
  const cases = [
    describeRecallArms({ stats: null, namespace: 'cortext', types: TYPES }),
    describeRecallArms({ stats: { reachable: false }, namespace: 'cortext', types: TYPES }),
    describeRecallArms({ stats: stats(), namespace: 'cortext', types: TYPES })
  ];
  for (const arms of cases) {
    assert.doesNotMatch(arms.evidence, /recall answered/i);
  }
});
