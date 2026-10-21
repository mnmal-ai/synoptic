import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEFAULT_HALFLIFE_H,
  DEFAULT_IMPORTANCE_WEIGHTS,
  DEFAULT_RECENCY_FLOOR,
  DEFAULT_TOP_K,
  DEFAULT_UNKNOWN_WEIGHT,
  importanceByType,
  parseImportanceWeights,
  partitionByScore,
  recencyDecay,
  scoreMemory
} from '../../src/scoring/memory-scorer.js';

test('importanceByType: returns default weight for each known type', () => {
  assert.equal(importanceByType('user'), 1.0);
  assert.equal(importanceByType('feedback'), 1.0);
  assert.equal(importanceByType('project'), 0.7);
  assert.equal(importanceByType('reference'), 0.4);
});

test('importanceByType: unknown type returns default unknown weight', () => {
  assert.equal(importanceByType('something-new'), DEFAULT_UNKNOWN_WEIGHT);
});

test('importanceByType: null/undefined type returns default unknown weight', () => {
  assert.equal(importanceByType(null), DEFAULT_UNKNOWN_WEIGHT);
  assert.equal(importanceByType(undefined), DEFAULT_UNKNOWN_WEIGHT);
});

test('importanceByType: custom weights override defaults', () => {
  const custom = { user: 0.5, feedback: 0.9 };
  assert.equal(importanceByType('user', custom), 0.5);
  assert.equal(importanceByType('feedback', custom), 0.9);
  // Type not in custom map falls back to unknown weight, not default map.
  assert.equal(importanceByType('project', custom), DEFAULT_UNKNOWN_WEIGHT);
});

test('importanceByType: defaults frozen (regression guard)', () => {
  assert.throws(() => {
    DEFAULT_IMPORTANCE_WEIGHTS.user = 999;
  }, TypeError);
});

test('recencyDecay: age 0 returns 1.0', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  assert.equal(recencyDecay('2026-04-23T12:00:00Z', now), 1.0);
});

test('recencyDecay: age = halfLife returns (1 + floor) / 2', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  const halfLifeAgo = new Date(now - DEFAULT_HALFLIFE_H * 3_600_000).toISOString();
  const expected = DEFAULT_RECENCY_FLOOR + (1 - DEFAULT_RECENCY_FLOOR) * 0.5;
  const actual = recencyDecay(halfLifeAgo, now);
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ≈${expected}, got ${actual}`);
});

test('recencyDecay: very old rows asymptote to baseline, not zero', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  const tenYearsAgo = new Date(now - 10 * 365 * 24 * 3_600_000).toISOString();
  const actual = recencyDecay(tenYearsAgo, now);
  assert.ok(actual >= DEFAULT_RECENCY_FLOOR, `expected ≥${DEFAULT_RECENCY_FLOOR}, got ${actual}`);
  assert.ok(actual < DEFAULT_RECENCY_FLOOR + 0.01, `expected near-floor, got ${actual}`);
});

test('recencyDecay: future updatedAt clamps to 1.0 (clock skew tolerance)', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  const oneHourFuture = new Date(now + 3_600_000).toISOString();
  assert.equal(recencyDecay(oneHourFuture, now), 1.0);
});

test('recencyDecay: custom halfLifeH and baseline', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  const oneDayAgo = new Date(now - 24 * 3_600_000).toISOString();
  // halfLife = 24h means 1 day old is exactly halfLife → decay = (1 + 0.1)/2 = 0.55
  const actual = recencyDecay(oneDayAgo, now, { halfLifeH: 24, baseline: 0.1 });
  assert.ok(Math.abs(actual - 0.55) < 1e-9, `expected 0.55, got ${actual}`);
});

test('recencyDecay: invalid updatedAt returns baseline (defensive)', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  assert.equal(recencyDecay('not-an-iso-date', now), DEFAULT_RECENCY_FLOOR);
  assert.equal(recencyDecay(null, now), DEFAULT_RECENCY_FLOOR);
  assert.equal(recencyDecay(undefined, now), DEFAULT_RECENCY_FLOOR);
});

test('scoreMemory: combines importance × recencyDecay', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  // 720h = default halfLife. user weight = 1.0. Expected: 1.0 × 0.6 = 0.6
  const row = { type: 'user', updatedAt: new Date(now - 720 * 3_600_000).toISOString() };
  const actual = scoreMemory(row, now);
  assert.ok(Math.abs(actual - 0.6) < 1e-9, `expected 0.6, got ${actual}`);
});

test('scoreMemory: fresh project-type row scores importance × 1.0', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  const row = { type: 'project', updatedAt: new Date(now).toISOString() };
  assert.equal(scoreMemory(row, now), 0.7);
});

test('scoreMemory: respects custom weights + halfLife options', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  const row = { type: 'user', updatedAt: new Date(now - 24 * 3_600_000).toISOString() };
  const actual = scoreMemory(row, now, {
    importanceWeights: { user: 0.5 },
    halfLifeH: 24,
    baseline: 0.0
  });
  // 0.5 × (0.0 + 1.0 × exp(-ln2 × 1)) = 0.5 × 0.5 = 0.25
  assert.ok(Math.abs(actual - 0.25) < 1e-9, `expected 0.25, got ${actual}`);
});

test('scoreMemory: missing type → unknown-weight × recencyDecay', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  const row = { updatedAt: new Date(now).toISOString() };
  assert.equal(scoreMemory(row, now), 0.5);
});

test('partitionByScore: empty input → empty top and index', () => {
  const { top, index } = partitionByScore([], Date.now());
  assert.deepEqual(top, []);
  assert.deepEqual(index, []);
});

test('partitionByScore: rows.length <= topK → all in top, nothing in index', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  const rows = [
    { name: 'a', type: 'user', updatedAt: new Date(now).toISOString() },
    { name: 'b', type: 'feedback', updatedAt: new Date(now).toISOString() }
  ];
  const { top, index } = partitionByScore(rows, now, { topK: 5 });
  assert.equal(top.length, 2);
  assert.equal(index.length, 0);
});

test('partitionByScore: top-K selection orders by score descending', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  const rows = [
    {
      name: 'old-user',
      type: 'user',
      updatedAt: new Date(now - 365 * 24 * 3_600_000).toISOString()
    }, // age 1y, high weight
    { name: 'fresh-ref', type: 'reference', updatedAt: new Date(now).toISOString() }, // age 0, low weight
    { name: 'fresh-user', type: 'user', updatedAt: new Date(now).toISOString() } // age 0, high weight — top pick
  ];
  const { top, index } = partitionByScore(rows, now, { topK: 2 });
  assert.equal(top[0].name, 'fresh-user');
  assert.equal(top.length, 2);
  assert.equal(index.length, 1);
});

test('partitionByScore: ties broken by updatedAt desc then name asc', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  const iso = new Date(now).toISOString();
  const rows = [
    { name: 'zebra', type: 'user', updatedAt: iso },
    { name: 'apple', type: 'user', updatedAt: iso },
    { name: 'mango', type: 'user', updatedAt: iso }
  ];
  const { top } = partitionByScore(rows, now, { topK: 3 });
  assert.equal(top[0].name, 'apple');
  assert.equal(top[1].name, 'mango');
  assert.equal(top[2].name, 'zebra');
});

test('partitionByScore: rows retain original fields (no stripping)', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  const rows = [
    {
      name: 'x',
      type: 'user',
      updatedAt: new Date(now).toISOString(),
      body: 'hello',
      description: 'd'
    }
  ];
  const { top } = partitionByScore(rows, now);
  assert.equal(top[0].body, 'hello');
  assert.equal(top[0].description, 'd');
});

test('partitionByScore: default topK is DEFAULT_TOP_K', () => {
  const now = Date.parse('2026-04-23T12:00:00Z');
  const rows = Array.from({ length: DEFAULT_TOP_K + 5 }, (_, i) => ({
    name: `m${i.toString().padStart(3, '0')}`,
    type: 'user',
    updatedAt: new Date(now - i * 3_600_000).toISOString()
  }));
  const { top, index } = partitionByScore(rows, now);
  assert.equal(top.length, DEFAULT_TOP_K);
  assert.equal(index.length, 5);
});

test('scoreMemory accepts halfLifeByType map + forType', () => {
  const now = Date.parse('2026-04-24T00:00:00Z');
  const row = { type: 'user', updatedAt: '2026-04-17T00:00:00Z' }; // 7 days old
  const asMemory = scoreMemory(row, now, {
    halfLifeByType: { Memory: 720, SessionLog: 336, Decision: 2160 },
    forType: 'Memory'
  });
  const asSessionLog = scoreMemory(row, now, {
    halfLifeByType: { Memory: 720, SessionLog: 336, Decision: 2160 },
    forType: 'SessionLog'
  });
  // SessionLog decays faster at 7 days → lower score.
  assert.ok(asSessionLog < asMemory, `expected ${asSessionLog} < ${asMemory}`);
});

test('scoreMemory single-halfLifeH still works (back-compat)', () => {
  const now = Date.parse('2026-04-24T00:00:00Z');
  const row = { type: 'user', updatedAt: '2026-04-17T00:00:00Z' };
  const score = scoreMemory(row, now, { halfLifeH: DEFAULT_HALFLIFE_H });
  assert.ok(score > 0 && score <= 1);
});

test('scoreMemory: forType without byType map falls back to halfLifeH', () => {
  const now = Date.parse('2026-04-24T00:00:00Z');
  const row = { type: 'user', updatedAt: '2026-04-17T00:00:00Z' };
  const withHalfLife = scoreMemory(row, now, { forType: 'SessionLog', halfLifeH: 100 });
  const withoutHalfLife = scoreMemory(row, now, { forType: 'SessionLog' });
  assert.ok(withHalfLife !== withoutHalfLife);
});

test('partitionByScore threads halfLifeByType + forType', () => {
  const now = Date.parse('2026-04-24T00:00:00Z');
  const rows = [
    { type: 'user', updatedAt: '2026-04-23T00:00:00Z', name: 'fresh' },
    { type: 'user', updatedAt: '2025-10-24T00:00:00Z', name: 'old' }
  ];
  const { top } = partitionByScore(rows, now, {
    halfLifeByType: { SessionLog: 336 },
    forType: 'SessionLog',
    topK: 1
  });
  assert.equal(top[0].name, 'fresh');
});

// ---- parseImportanceWeights defensive branches ----

test('parseImportanceWeights: undefined → DEFAULT', () => {
  assert.equal(parseImportanceWeights(undefined), DEFAULT_IMPORTANCE_WEIGHTS);
});

test('parseImportanceWeights: null → DEFAULT', () => {
  assert.equal(parseImportanceWeights(null), DEFAULT_IMPORTANCE_WEIGHTS);
});

test('parseImportanceWeights: empty string → DEFAULT', () => {
  assert.equal(parseImportanceWeights(''), DEFAULT_IMPORTANCE_WEIGHTS);
});

test('parseImportanceWeights: malformed JSON → DEFAULT', () => {
  assert.equal(parseImportanceWeights('not json'), DEFAULT_IMPORTANCE_WEIGHTS);
  assert.equal(parseImportanceWeights('{"unterminated'), DEFAULT_IMPORTANCE_WEIGHTS);
});

test('parseImportanceWeights: array value → DEFAULT (arrays are objects but not maps)', () => {
  assert.equal(parseImportanceWeights('[1,2,3]'), DEFAULT_IMPORTANCE_WEIGHTS);
  assert.equal(parseImportanceWeights('[]'), DEFAULT_IMPORTANCE_WEIGHTS);
});

test('parseImportanceWeights: JSON null → DEFAULT', () => {
  assert.equal(parseImportanceWeights('null'), DEFAULT_IMPORTANCE_WEIGHTS);
});

test('parseImportanceWeights: JSON primitive → DEFAULT', () => {
  assert.equal(parseImportanceWeights('42'), DEFAULT_IMPORTANCE_WEIGHTS);
  assert.equal(parseImportanceWeights('"string"'), DEFAULT_IMPORTANCE_WEIGHTS);
  assert.equal(parseImportanceWeights('true'), DEFAULT_IMPORTANCE_WEIGHTS);
});

test('parseImportanceWeights: valid object → returns parsed object', () => {
  const result = parseImportanceWeights('{"user":1.0,"feedback":0.8,"custom":0.5}');
  assert.notEqual(result, DEFAULT_IMPORTANCE_WEIGHTS);
  assert.deepEqual(result, { user: 1.0, feedback: 0.8, custom: 0.5 });
});

test('parseImportanceWeights: empty object → returns empty object (caller decides lookup fallback)', () => {
  const result = parseImportanceWeights('{}');
  assert.deepEqual(result, {});
});
