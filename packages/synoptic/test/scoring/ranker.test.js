import assert from 'node:assert/strict';
import { test } from 'vitest';
import { combineRRF } from '../../src/scoring/ranker.js';

test('combineRRF: both ranks present → sum of reciprocals', () => {
  const c = combineRRF({ structuralRank: 1, semanticRank: 1, k: 60 });
  assert.ok(Math.abs(c - (1 / 61 + 1 / 61)) < 1e-9);
});

test('combineRRF: null semanticRank → structural-only term', () => {
  const c = combineRRF({ structuralRank: 3, semanticRank: null, k: 60 });
  assert.ok(Math.abs(c - 1 / 63) < 1e-9);
});

test('combineRRF: undefined semanticRank treated same as null', () => {
  const c = combineRRF({ structuralRank: 3, semanticRank: undefined, k: 60 });
  assert.ok(Math.abs(c - 1 / 63) < 1e-9);
});

test('combineRRF: larger k compresses differences between ranks', () => {
  const smallK = combineRRF({ structuralRank: 1, semanticRank: 10, k: 5 });
  const largeK = combineRRF({ structuralRank: 1, semanticRank: 10, k: 500 });
  const smallKGap = 1 / 6 - 1 / 15; // ≈ 0.1
  const largeKGap = 1 / 501 - 1 / 510; // ≈ 3.5e-5
  assert.ok(smallK - smallKGap > largeK - largeKGap - 1e-3);
});

test('combineRRF: both-rank output greater than null-semantic output', () => {
  const both = combineRRF({ structuralRank: 5, semanticRank: 10, k: 60 });
  const only = combineRRF({ structuralRank: 5, semanticRank: null, k: 60 });
  assert.ok(both > only);
});

import { assignRanks } from '../../src/scoring/ranker.js';

// Helper: build a ScoredRow-shaped object for tests. `type` carried on the outer.
function scoredRow({ id, type, structural, semantic, updatedAt }) {
  return {
    type,
    row: { id, body: { updatedAt } },
    structural,
    semantic
  };
}

test('assignRanks: structural rank is 1-based global sort desc', () => {
  const rows = [
    scoredRow({
      id: 'a',
      type: 'Memory',
      structural: 0.3,
      semantic: null,
      updatedAt: '2026-04-01'
    }),
    scoredRow({
      id: 'b',
      type: 'Decision',
      structural: 0.9,
      semantic: null,
      updatedAt: '2026-04-01'
    }),
    scoredRow({
      id: 'c',
      type: 'SessionLog',
      structural: 0.6,
      semantic: null,
      updatedAt: '2026-04-01'
    })
  ];
  const ranked = assignRanks(rows);
  const byId = Object.fromEntries(ranked.map((r) => [r.row.id, r]));
  assert.equal(byId.b.structuralRank, 1); // highest
  assert.equal(byId.c.structuralRank, 2);
  assert.equal(byId.a.structuralRank, 3); // lowest
});

test('assignRanks: semantic rank skips null-semantic rows', () => {
  const rows = [
    scoredRow({ id: 'a', type: 'Memory', structural: 0.1, semantic: 0.9, updatedAt: '2026-04-01' }),
    scoredRow({
      id: 'b',
      type: 'Memory',
      structural: 0.1,
      semantic: null,
      updatedAt: '2026-04-01'
    }),
    scoredRow({ id: 'c', type: 'Memory', structural: 0.1, semantic: 0.5, updatedAt: '2026-04-01' })
  ];
  const ranked = assignRanks(rows);
  const byId = Object.fromEntries(ranked.map((r) => [r.row.id, r]));
  assert.equal(byId.a.semanticRank, 1); // highest cosine
  assert.equal(byId.b.semanticRank, null);
  assert.equal(byId.c.semanticRank, 2);
});

test('assignRanks: ties broken by type order then updatedAt desc', () => {
  // Three rows all with structural=0.5. Expected order: Memory before SessionLog
  // before Decision; within same type, later updatedAt first.
  const rows = [
    scoredRow({
      id: 'dec-late',
      type: 'Decision',
      structural: 0.5,
      semantic: null,
      updatedAt: '2026-04-03'
    }),
    scoredRow({
      id: 'mem-early',
      type: 'Memory',
      structural: 0.5,
      semantic: null,
      updatedAt: '2026-04-01'
    }),
    scoredRow({
      id: 'mem-late',
      type: 'Memory',
      structural: 0.5,
      semantic: null,
      updatedAt: '2026-04-02'
    }),
    scoredRow({
      id: 'sl-mid',
      type: 'SessionLog',
      structural: 0.5,
      semantic: null,
      updatedAt: '2026-04-02'
    })
  ];
  const ranked = assignRanks(rows);
  const byId = Object.fromEntries(ranked.map((r) => [r.row.id, r]));
  assert.equal(byId['mem-late'].structuralRank, 1);
  assert.equal(byId['mem-early'].structuralRank, 2);
  assert.equal(byId['sl-mid'].structuralRank, 3);
  assert.equal(byId['dec-late'].structuralRank, 4);
});

test('assignRanks: empty input returns empty array', () => {
  assert.deepEqual(assignRanks([]), []);
});

test('assignRanks: all semantic-null rows → all semanticRank null', () => {
  const rows = [
    scoredRow({
      id: 'a',
      type: 'Memory',
      structural: 0.5,
      semantic: null,
      updatedAt: '2026-04-01'
    }),
    scoredRow({ id: 'b', type: 'Memory', structural: 0.3, semantic: null, updatedAt: '2026-04-01' })
  ];
  const ranked = assignRanks(rows);
  for (const r of ranked) assert.equal(r.semanticRank, null);
});

test('assignRanks: preserves other ScoredRow fields untouched', () => {
  const rows = [
    scoredRow({ id: 'a', type: 'Memory', structural: 0.5, semantic: 0.3, updatedAt: '2026-04-01' })
  ];
  const [out] = assignRanks(rows);
  assert.equal(out.type, 'Memory');
  assert.equal(out.row.id, 'a');
  assert.equal(out.structural, 0.5);
  assert.equal(out.semantic, 0.3);
});

import { selectWithMinFloors } from '../../src/scoring/ranker.js';

// Helper: build a RankedRow for selection tests.
function rankedRow({ id, type, combined }) {
  return {
    type,
    row: { id, body: {} },
    structural: 0,
    semantic: 0,
    structuralRank: 0,
    semanticRank: 0,
    combined
  };
}

test('selectWithMinFloors: happy path — all types present, floors + global fill', () => {
  const rows = [
    rankedRow({ id: 'm1', type: 'Memory', combined: 0.9 }),
    rankedRow({ id: 'd1', type: 'Decision', combined: 0.8 }),
    rankedRow({ id: 'm2', type: 'Memory', combined: 0.7 }),
    rankedRow({ id: 's1', type: 'SessionLog', combined: 0.6 }),
    rankedRow({ id: 'd2', type: 'Decision', combined: 0.5 }),
    rankedRow({ id: 'm3', type: 'Memory', combined: 0.4 })
  ];
  const { top, index } = selectWithMinFloors(rows, {
    totalK: 4,
    minFloors: { Memory: 2, SessionLog: 1, Decision: 1 }
  });
  const ids = top.map((r) => r.row.id);
  assert.equal(top.length, 4);
  assert.ok(ids.includes('m1') && ids.includes('m2')); // Memory floor (2)
  assert.ok(ids.includes('s1')); // SessionLog floor (1)
  assert.ok(ids.includes('d1')); // Decision floor (1) - highest Decision
  assert.equal(index.length, 2);
  // Final top order is combined-desc.
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].combined >= top[i].combined);
});

test('selectWithMinFloors: type with zero rows — floor contributes nothing', () => {
  const rows = [
    rankedRow({ id: 'd1', type: 'Decision', combined: 0.9 }),
    rankedRow({ id: 'd2', type: 'Decision', combined: 0.8 }),
    rankedRow({ id: 'd3', type: 'Decision', combined: 0.7 }),
    rankedRow({ id: 'm1', type: 'Memory', combined: 0.6 })
  ];
  const { top, index } = selectWithMinFloors(rows, {
    totalK: 3,
    minFloors: { Memory: 1, SessionLog: 1, Decision: 1 }
  });
  const ids = top.map((r) => r.row.id);
  assert.equal(top.length, 3);
  assert.ok(ids.includes('m1')); // Memory floor
  assert.ok(ids.includes('d1')); // Decision floor
  // Third slot filled from global; d2 is next highest global not already picked.
  assert.ok(ids.includes('d2'));
  assert.equal(index.length, 1);
  assert.equal(index[0].row.id, 'd3');
});

test('selectWithMinFloors: type domination pre-floors — floors pull from type lists', () => {
  // All top-10 are Decisions; Memory and SessionLog rows exist but trail.
  const rows = [];
  for (let i = 0; i < 10; i++)
    rows.push(rankedRow({ id: `d${i}`, type: 'Decision', combined: 1.0 - i * 0.05 }));
  rows.push(rankedRow({ id: 'm1', type: 'Memory', combined: 0.3 }));
  rows.push(rankedRow({ id: 'm2', type: 'Memory', combined: 0.25 }));
  rows.push(rankedRow({ id: 's1', type: 'SessionLog', combined: 0.2 }));
  const { top } = selectWithMinFloors(rows, {
    totalK: 8,
    minFloors: { Memory: 2, SessionLog: 1, Decision: 2 }
  });
  const ids = top.map((r) => r.row.id);
  assert.equal(top.length, 8);
  assert.ok(ids.includes('m1') && ids.includes('m2')); // Memory floor
  assert.ok(ids.includes('s1')); // SessionLog floor
  // Decision floor picks d0, d1 (best two); global fill adds d2..d4 in order.
  assert.ok(ids.includes('d0') && ids.includes('d1'));
  const decCount = ids.filter((id) => id.startsWith('d')).length;
  assert.equal(decCount, 5); // 2 floor + 3 fill
});

test('selectWithMinFloors: over-subscribed floors scaled proportionally', () => {
  const rows = [
    rankedRow({ id: 'm1', type: 'Memory', combined: 0.9 }),
    rankedRow({ id: 'm2', type: 'Memory', combined: 0.8 }),
    rankedRow({ id: 'm3', type: 'Memory', combined: 0.7 }),
    rankedRow({ id: 's1', type: 'SessionLog', combined: 0.6 }),
    rankedRow({ id: 's2', type: 'SessionLog', combined: 0.5 }),
    rankedRow({ id: 'd1', type: 'Decision', combined: 0.4 }),
    rankedRow({ id: 'd2', type: 'Decision', combined: 0.3 }),
    rankedRow({ id: 'd3', type: 'Decision', combined: 0.2 })
  ];
  // Floors sum to 8 but totalK=5: scaled with floor() → scaled floor sum ≤ 5.
  // Phase 2 tops up to exactly totalK.
  const warnings = [];
  const { top } = selectWithMinFloors(rows, {
    totalK: 5,
    minFloors: { Memory: 3, SessionLog: 2, Decision: 3 },
    onWarn: (msg) => warnings.push(msg)
  });
  assert.equal(top.length, 5);
  assert.ok(warnings.length >= 1);
  assert.match(warnings[0], /over-subscribed/i);
});

test('selectWithMinFloors: under-subscribed floors — Phase 2 fills majority', () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    rankedRow({
      id: `r${i}`,
      type: i < 3 ? 'Memory' : i < 5 ? 'SessionLog' : 'Decision',
      combined: 1 - i * 0.05
    })
  );
  const { top } = selectWithMinFloors(rows, {
    totalK: 7,
    minFloors: { Memory: 1, SessionLog: 1, Decision: 1 }
  });
  assert.equal(top.length, 7);
  // Floors are 3 of 7; global fill adds next 4 best not-yet-picked.
});

test('selectWithMinFloors: totalK larger than input — returns all, index empty', () => {
  const rows = [
    rankedRow({ id: 'a', type: 'Memory', combined: 0.9 }),
    rankedRow({ id: 'b', type: 'Decision', combined: 0.5 })
  ];
  const { top, index } = selectWithMinFloors(rows, {
    totalK: 10,
    minFloors: { Memory: 1, SessionLog: 1, Decision: 1 }
  });
  assert.equal(top.length, 2);
  assert.equal(index.length, 0);
});

test('selectWithMinFloors: empty input → empty top + empty index', () => {
  const { top, index } = selectWithMinFloors([], {
    totalK: 10,
    minFloors: { Memory: 2, SessionLog: 1, Decision: 2 }
  });
  assert.deepEqual(top, []);
  assert.deepEqual(index, []);
});

test('selectWithMinFloors: floor-pick that ranks #1 globally appears at position 1', () => {
  const rows = [
    rankedRow({ id: 'm1', type: 'Memory', combined: 0.9 }), // globally #1
    rankedRow({ id: 'd1', type: 'Decision', combined: 0.8 }),
    rankedRow({ id: 'd2', type: 'Decision', combined: 0.7 })
  ];
  const { top } = selectWithMinFloors(rows, {
    totalK: 2,
    minFloors: { Memory: 1, SessionLog: 0, Decision: 1 }
  });
  assert.equal(top[0].row.id, 'm1');
  assert.equal(top[1].row.id, 'd1');
});

test('selectWithMinFloors: index preserves combined-desc order', () => {
  const rows = [
    rankedRow({ id: 'a', type: 'Memory', combined: 0.9 }),
    rankedRow({ id: 'b', type: 'Decision', combined: 0.8 }),
    rankedRow({ id: 'c', type: 'Memory', combined: 0.7 }),
    rankedRow({ id: 'd', type: 'Decision', combined: 0.6 })
  ];
  const { index } = selectWithMinFloors(rows, {
    totalK: 2,
    minFloors: { Memory: 1, SessionLog: 0, Decision: 1 }
  });
  for (let i = 1; i < index.length; i++) assert.ok(index[i - 1].combined >= index[i].combined);
});

import { rankWithRRF } from '../../src/scoring/ranker.js';

test('rankWithRRF: full pipeline — mixed types, all with vectors', () => {
  const scoredByType = {
    Memory: [
      {
        type: 'Memory',
        row: { id: 'm1', body: { updatedAt: '2026-04-20' } },
        structural: 0.8,
        semantic: 0.7
      },
      {
        type: 'Memory',
        row: { id: 'm2', body: { updatedAt: '2026-04-15' } },
        structural: 0.4,
        semantic: 0.3
      }
    ],
    SessionLog: [
      {
        type: 'SessionLog',
        row: { id: 's1', body: { updatedAt: '2026-04-24' } },
        structural: 0.9,
        semantic: 0.6
      }
    ],
    Decision: [
      {
        type: 'Decision',
        row: { id: 'd1', body: { updatedAt: '2026-04-10' } },
        structural: 0.7,
        semantic: 0.8
      }
    ]
  };
  const { top, index } = rankWithRRF(scoredByType, {
    k: 60,
    totalK: 10,
    minFloors: { Memory: 2, SessionLog: 1, Decision: 1 }
  });
  assert.equal(top.length, 4); // only 4 input rows total
  assert.equal(index.length, 0);
  // Each top row carries all RankedRow fields:
  for (const r of top) {
    assert.ok(typeof r.structuralRank === 'number' && r.structuralRank >= 1);
    assert.ok(
      r.semanticRank === null || (typeof r.semanticRank === 'number' && r.semanticRank >= 1)
    );
    assert.ok(typeof r.combined === 'number' && r.combined > 0);
    assert.ok(typeof r.combinedRank === 'number' && r.combinedRank >= 1);
    assert.ok(typeof r.type === 'string');
  }
  // combinedRank values are 1, 2, 3, 4 in order of combined desc.
  const allRanks = [...top, ...index].map((r) => r.combinedRank).sort((a, b) => a - b);
  assert.deepEqual(allRanks, [1, 2, 3, 4]);
});

test('rankWithRRF: combinedRank assigned globally — index rows know their rank too', () => {
  // Build 5 rows; totalK=2; min-floor of Memory=2 means Memory rows always
  // make top regardless of combined rank. The Decision rows get displaced
  // into index but should retain a combinedRank that reflects their true
  // global position by RRF combined.
  const scoredByType = {
    Memory: [
      {
        type: 'Memory',
        row: { id: 'm1', body: { updatedAt: '2026-04-01' } },
        structural: 0.05,
        semantic: 0.05
      }, // weakest
      {
        type: 'Memory',
        row: { id: 'm2', body: { updatedAt: '2026-04-01' } },
        structural: 0.04,
        semantic: 0.04
      }
    ],
    Decision: [
      {
        type: 'Decision',
        row: { id: 'd1', body: { updatedAt: '2026-04-20' } },
        structural: 0.99,
        semantic: 0.99
      }, // strongest
      {
        type: 'Decision',
        row: { id: 'd2', body: { updatedAt: '2026-04-19' } },
        structural: 0.95,
        semantic: 0.95
      },
      {
        type: 'Decision',
        row: { id: 'd3', body: { updatedAt: '2026-04-18' } },
        structural: 0.9,
        semantic: 0.9
      }
    ],
    SessionLog: []
  };
  const { top, index } = rankWithRRF(scoredByType, {
    k: 60,
    totalK: 2,
    minFloors: { Memory: 2, SessionLog: 0, Decision: 0 }
  });
  assert.equal(top.length, 2);
  assert.equal(index.length, 3);
  // Decision rows are in index even though they have the strongest scores.
  const indexIds = index.map((r) => r.row.id).sort();
  assert.deepEqual(indexIds, ['d1', 'd2', 'd3']);
  // d1 (strongest combined) should have combinedRank=1 — visibly indicating
  // the floor displaced what would otherwise be the top row.
  const d1 = index.find((r) => r.row.id === 'd1');
  assert.equal(d1.combinedRank, 1);
});

test('rankWithRRF: null-semantic rows still surface via structural rank', () => {
  const scoredByType = {
    Memory: [
      {
        type: 'Memory',
        row: { id: 'm1', body: { updatedAt: '2026-04-20' } },
        structural: 0.9,
        semantic: null
      },
      {
        type: 'Memory',
        row: { id: 'm2', body: { updatedAt: '2026-04-19' } },
        structural: 0.1,
        semantic: 0.9
      }
    ],
    SessionLog: [],
    Decision: []
  };
  const { top } = rankWithRRF(scoredByType, {
    k: 60,
    totalK: 2,
    minFloors: { Memory: 2, SessionLog: 0, Decision: 0 }
  });
  const ids = top.map((r) => r.row.id);
  assert.ok(ids.includes('m1'));
  assert.ok(ids.includes('m2'));
  // m1 has structuralRank=1, semanticRank=null → combined = 1/61
  // m2 has structuralRank=2, semanticRank=1 → combined = 1/62 + 1/61
  const m2 = top.find((r) => r.row.id === 'm2');
  const m1 = top.find((r) => r.row.id === 'm1');
  assert.ok(m2.combined > m1.combined);
});

test('rankWithRRF: empty input all types → empty top and index', () => {
  const { top, index } = rankWithRRF(
    { Memory: [], SessionLog: [], Decision: [] },
    { k: 60, totalK: 5, minFloors: { Memory: 2, SessionLog: 1, Decision: 2 } }
  );
  assert.deepEqual(top, []);
  assert.deepEqual(index, []);
});

test('rankWithRRF: all rows null semantic → structural-only ordering', () => {
  const scoredByType = {
    Memory: [
      {
        type: 'Memory',
        row: { id: 'm1', body: { updatedAt: '2026-04-20' } },
        structural: 0.3,
        semantic: null
      },
      {
        type: 'Memory',
        row: { id: 'm2', body: { updatedAt: '2026-04-19' } },
        structural: 0.9,
        semantic: null
      }
    ],
    SessionLog: [],
    Decision: []
  };
  const { top } = rankWithRRF(scoredByType, {
    k: 60,
    totalK: 2,
    minFloors: { Memory: 1, SessionLog: 0, Decision: 0 }
  });
  // Output combined-desc: m2 first (structural 0.9, rank 1), m1 second.
  assert.equal(top[0].row.id, 'm2');
  assert.equal(top[1].row.id, 'm1');
  for (const r of top) assert.equal(r.semanticRank, null);
});
