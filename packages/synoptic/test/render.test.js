import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildRuleSessionContext,
  renderAgentRules,
  renderConcepts,
  renderMustDigest,
  renderRecallState,
  renderStructural,
  renderTodos,
  renderUnified
} from '../src/render.js';

// ---- renderAgentRules namespace templating (born-neutral cortext instance) ----

test('renderAgentRules (classic): skim hint templates the namespace', () => {
  const rules = [{ shortId: 1, rule: 'a should-tier rule', severity: 'should', category: 'x' }];
  const out = renderAgentRules(rules, { ns: 'cortext' });
  assert.match(out, /cortext\/AgentRule/);
  assert.doesNotMatch(out, /claude\/AgentRule/);
});

test('renderAgentRules (salient): skim heading templates the namespace', () => {
  const rules = [
    { shortId: 1, rule: 'rule one', severity: 'should' },
    { shortId: 2, rule: 'rule two', severity: 'should' }
  ];
  const out = renderAgentRules(rules, { ns: 'cortext', salience: true, topK: 0 });
  assert.match(out, /cortext\/AgentRule/);
  assert.doesNotMatch(out, /claude\/AgentRule/);
});

test('renderAgentRules: defaults to the cortext namespace', () => {
  const rules = [{ shortId: 1, rule: 'a should-tier rule', severity: 'should' }];
  assert.match(renderAgentRules(rules), /cortext\/AgentRule/);
});

// ---- renderStructural (Increment 1 format) ----

test('renderStructural: empty rows → offline-like minimal header', () => {
  const out = renderStructural({
    rows: [],
    projectSlug: 'substrate',
    topK: 10,
    halfLifeH: 720,
    baseline: 0.2,
    importanceWeights: { user: 1, feedback: 1 },
    ns: 'claude'
  });
  assert.match(out, /## Agent Memory \(from claude\/Memory — 0 total, 0 top\)/);
  assert.match(out, /Project scope: `substrate`/);
});

test('renderStructural: top + index sections render correctly', () => {
  const rows = [
    {
      name: 'fresh',
      type: 'user',
      description: 'a fresh memory',
      body: 'body content',
      updatedAt: new Date(Date.now() - 60_000).toISOString()
    },
    {
      name: 'stale_one',
      type: 'project',
      description: 'older',
      body: '',
      updatedAt: '2025-01-01T00:00:00Z'
    },
    {
      name: 'stale_two',
      type: 'reference',
      description: 'oldest',
      body: '',
      updatedAt: '2024-01-01T00:00:00Z'
    }
  ];
  const out = renderStructural({
    rows,
    projectSlug: 'substrate',
    topK: 1,
    halfLifeH: 720,
    baseline: 0.2,
    importanceWeights: { user: 1, project: 0.7, reference: 0.4 },
    ns: 'claude'
  });
  assert.match(out, /### Top recall/);
  assert.match(out, /#### fresh {2}`user`/);
  assert.match(out, /### Index/);
  assert.match(out, /\*\*stale_one\*\*/);
  assert.match(out, /\*\*stale_two\*\*/);
});

// ---- renderUnified (Increment 4 — RRF + unified output) ----

test('renderUnified: emits one Top recall section with type-tagged rows and inline ranks', () => {
  const result = {
    mode: 'hybrid',
    anchor: {
      id: 'anchor-sl',
      body: {
        shortId: 1068,
        branch: 'feat/graded-recall-i4-spec',
        startedAt: '2026-04-24T18:30:00Z'
      },
      source: 'sessionlog'
    },
    byType: {
      Memory: [
        {
          type: 'Memory',
          row: {
            id: 'm1',
            body: {
              name: 'feedback_fold_back',
              type: 'feedback',
              description: 'When I notice drift',
              body: 'Full body…'
            }
          },
          structural: 0.9,
          semantic: 0.8
        }
      ],
      SessionLog: [
        {
          type: 'SessionLog',
          row: { id: 's1', body: { shortId: 1067, branch: 'feat/x', summary: 'A short summary.' } },
          structural: 0.8,
          semantic: 0.7
        }
      ],
      Decision: [
        {
          type: 'Decision',
          row: {
            id: 'd1',
            body: { shortId: 1086, topic: 'phased impl', status: 'active', choice: 'do the thing' }
          },
          structural: 0.7,
          semantic: 0.9
        }
      ]
    }
  };
  const ranked = { top: [], index: [] };
  ranked.top = [
    {
      type: 'Memory',
      row: result.byType.Memory[0].row,
      structural: 0.9,
      semantic: 0.8,
      structuralRank: 1,
      semanticRank: 2,
      combined: 0.033,
      combinedRank: 1
    },
    {
      type: 'Decision',
      row: result.byType.Decision[0].row,
      structural: 0.7,
      semantic: 0.9,
      structuralRank: 3,
      semanticRank: 1,
      combined: 0.032,
      combinedRank: 2
    },
    {
      type: 'SessionLog',
      row: result.byType.SessionLog[0].row,
      structural: 0.8,
      semantic: 0.7,
      structuralRank: 2,
      semanticRank: 3,
      combined: 0.031,
      combinedRank: 3
    }
  ];
  // The hybrid header is a claim about the SERVER's retrieval arms,
  // so this fixture has to establish it rather than assume it.
  const arms = {
    dense: 'wired',
    lexical: 'wired',
    label: 'hybrid recall — RRF, unified',
    evidence: 'dense wired, lexical wired'
  };
  const out = renderUnified({
    result,
    ranked,
    ns: 'claude',
    projectSlug: 'substrate',
    k: 60,
    arms
  });

  // Header bits
  assert.match(out, /^## Agent Memory \(hybrid recall — RRF, unified\)/m);
  assert.match(out, /Project scope: `substrate`/);
  assert.match(out, /Anchor: SessionLog #1068/);
  assert.match(out, /Mode: RRF fusion, structural \+ semantic \(k=60\)/);

  // Top recall section
  // The count names the project split. This fixture's rows carry no
  // `project` field at all, so all three count as `unknown` rather than being
  // folded into cross-cutting — which is the assertion worth having here.
  assert.match(out, /### Top recall \(3 of 3 — 0 for this project, 0 cross-cutting, 3 unknown\)/);
  // Type tag up front
  assert.match(out, /#### Memory: feedback_fold_back/);
  assert.match(out, /#### Decision: #1086/);
  assert.match(out, /#### SessionLog: #1067/);
  // Inline rank display — combined first (global RRF position), then components.
  assert.match(out, /\[rank: combined #1, struct 1, sem 2\]/);
  assert.match(out, /\[rank: combined #2, struct 3, sem 1\]/);
  assert.match(out, /\[rank: combined #3, struct 2, sem 3\]/);
});

test('renderUnified: null semanticRank renders as em-dash', () => {
  const result = {
    mode: 'hybrid',
    anchor: {
      id: 'a',
      body: { shortId: 99, branch: 'x', startedAt: '2026-04-24T00:00:00Z' },
      source: 'sessionlog'
    },
    byType: { Memory: [], SessionLog: [], Decision: [] }
  };
  const ranked = {
    top: [
      {
        type: 'Memory',
        row: { id: 'm1', body: { name: 'no_vec', type: 'user', body: 'x' } },
        structural: 0.5,
        semantic: null,
        structuralRank: 1,
        semanticRank: null,
        combined: 0.016,
        combinedRank: 1
      }
    ],
    index: []
  };
  const out = renderUnified({ result, ranked, ns: 'claude', projectSlug: 'substrate', k: 60 });
  assert.match(out, /\[rank: combined #1, struct 1, sem —\]/);
});

// SessionLog summaries and Decision choices must be quoted on every line: a
// `> ` prefix on the first line only lets a `## ` inside one forge a section.
test('renderUnified: SessionLog and Decision previews forge no ## heading', () => {
  const result = {
    mode: 'hybrid',
    anchor: {
      id: 'a',
      body: { shortId: 1, branch: 'x', startedAt: '2026-04-24T00:00:00Z' },
      source: 'sessionlog'
    },
    byType: { Memory: [], SessionLog: [], Decision: [] }
  };
  const row = (type, id, body, rank) => ({
    type,
    row: { id, body },
    structural: 0.5,
    semantic: 0.5,
    structuralRank: rank,
    semanticRank: rank,
    combined: 0.03,
    combinedRank: rank
  });
  const ranked = {
    top: [
      row(
        'SessionLog',
        's1',
        { shortId: 827, summary: 'Shipped.\n## DEPLOYED AND VERIFIED\nok' },
        1
      ),
      row('Decision', 'd1', { shortId: 5, topic: 't', choice: 'Do it.\n## THE MISTAKE\nwhy' }, 2)
    ],
    index: [row('SessionLog', 's2', { shortId: 828, summary: 'x\n## MERGED' }, 3)]
  };
  const out = renderUnified({ result, ranked, ns: 'cortext', projectSlug: 'synoptic', k: 60 });
  const forged = out.split('\n').filter((l) => /^## /.test(l) && !/^## Agent Memory/.test(l));
  assert.deepEqual(forged, []);
  assert.match(out, /^> \*\*DEPLOYED AND VERIFIED\*\*$/m);
  assert.match(out, /^> \*\*THE MISTAKE\*\*$/m);
});

test('renderUnified: empty top → no Top recall section (graceful)', () => {
  const result = {
    mode: 'hybrid',
    anchor: {
      id: 'a',
      body: { shortId: 1, branch: 'x', startedAt: '2026-04-24T00:00:00Z' },
      source: 'sessionlog'
    },
    byType: { Memory: [], SessionLog: [], Decision: [] }
  };
  const ranked = { top: [], index: [] };
  const out = renderUnified({ result, ranked, ns: 'claude', projectSlug: 'substrate', k: 60 });
  assert.doesNotMatch(out, /### Top recall/);
  assert.match(out, /Mode: RRF fusion/); // header still there
});

test('renderUnified: intent anchor renders with "(intent, authored by <kind> — \\"...\\")" form', () => {
  const result = {
    mode: 'hybrid',
    anchor: {
      id: 'ai-1',
      body: {
        shortId: 1092,
        synopsis: 'Brainstorm anchor-C: AnchorIntent type, newest-wins.',
        authoredBy: { kind: 'agent' },
        updatedAt: '2026-04-24T18:30:00Z',
        project: 'substrate'
      },
      source: 'intent'
    },
    byType: { Memory: [], SessionLog: [], Decision: [] }
  };
  const ranked = { top: [], index: [] };
  const out = renderUnified({ result, ranked, ns: 'claude', projectSlug: 'substrate', k: 60 });
  assert.match(out, /Anchor: AnchorIntent #1092/);
  assert.match(out, /\(intent, authored .* by agent/);
  assert.match(out, /"Brainstorm anchor-C/);
});

test('renderUnified: stale intent anchor renders the staleness warning line', () => {
  const result = {
    mode: 'hybrid',
    anchor: {
      id: 'ai-stale',
      body: {
        shortId: 1234,
        text: 'Active focus that the work has long since moved past.',
        authoredBy: { kind: 'agent' },
        updatedAt: '2026-05-01T10:00:00Z',
        project: 'substrate'
      },
      source: 'intent',
      stale: true,
      sessionLogsSince: 4,
      lastSessionLogAt: '2026-05-07T22:00:00Z'
    },
    byType: { Memory: [], SessionLog: [], Decision: [] }
  };
  const ranked = { top: [], index: [] };
  const out = renderUnified({ result, ranked, ns: 'claude', projectSlug: 'substrate', k: 60 });
  assert.match(out, /Anchor: AnchorIntent #1234/);
  assert.match(out, /Anchor stale: 4 SessionLogs filed since authored/);
  assert.match(out, /Audit \+ re-author/);
});

test('renderUnified: fresh intent anchor (stale=false) does not render the warning line', () => {
  const result = {
    mode: 'hybrid',
    anchor: {
      id: 'ai-fresh',
      body: {
        shortId: 999,
        text: 'fresh',
        authoredBy: { kind: 'agent' },
        updatedAt: '2026-05-07T22:00:00Z'
      },
      source: 'intent',
      stale: false,
      sessionLogsSince: 0,
      lastSessionLogAt: null
    },
    byType: { Memory: [], SessionLog: [], Decision: [] }
  };
  const ranked = { top: [], index: [] };
  const out = renderUnified({ result, ranked, ns: 'claude', projectSlug: 'substrate', k: 60 });
  assert.doesNotMatch(out, /Anchor stale/);
});

test('renderUnified: sessionlog fallback anchor renders with "(fallback — no active AnchorIntent for project …)" form', () => {
  const result = {
    mode: 'hybrid',
    anchor: {
      id: 'sl-1',
      body: {
        shortId: 1071,
        branch: 'feat/graded-recall-i5-synopsis',
        startedAt: '2026-04-24T23:30:00Z',
        summary: 'synopsis ship'
      },
      source: 'sessionlog'
    },
    byType: { Memory: [], SessionLog: [], Decision: [] }
  };
  const ranked = { top: [], index: [] };
  const out = renderUnified({ result, ranked, ns: 'claude', projectSlug: 'substrate', k: 60 });
  assert.match(out, /Anchor: SessionLog #1071/);
  assert.match(out, /\(fallback — no active AnchorIntent/);
  assert.match(out, /branch feat\/graded-recall-i5-synopsis/);
});

// ---- renderTodos ----

test('renderTodos: empty list → no section emitted', () => {
  assert.equal(renderTodos([]), '');
});

test('renderTodos: header summarises open + blocked counts', () => {
  const todos = [
    { shortId: 1, title: 'a', area: 'x', priority: 'high', status: 'open' },
    { shortId: 2, title: 'b', area: 'x', priority: 'low', status: 'open' },
    { shortId: 3, title: 'c', area: 'x', priority: 'medium', status: 'blocked' }
  ];
  const out = renderTodos(todos);
  // The header leads with what a session can ACT on, not with how many
  // rows exist. The `blocked` row is counted under the waiting group
  // rather than in the headline, because a count of things you cannot start
  // is not an answer to "what should I do".
  assert.match(out, /## Open Work \(3 total — 2 ready, 1 waiting\)/);
});

test('renderTodos: high → medium → low ordering with priority emoji', () => {
  const todos = [
    { shortId: 1, title: 'low task', area: 'a', priority: 'low', status: 'open' },
    { shortId: 2, title: 'high task', area: 'b', priority: 'high', status: 'open' },
    { shortId: 3, title: 'med task', area: 'c', priority: 'medium', status: 'open' }
  ];
  const out = renderTodos(todos);
  const idxHigh = out.indexOf('high task');
  const idxMed = out.indexOf('med task');
  const idxLow = out.indexOf('low task');
  assert.ok(idxHigh < idxMed && idxMed < idxLow, 'priority ordering: high < med < low');
  assert.match(out, /🔴.*high task/);
  assert.match(out, /🟡.*med task/);
  assert.match(out, /🟢.*low task/);
});

test('renderTodos: blocked status overrides priority emoji with 🚫', () => {
  const todos = [
    { shortId: 1, title: 'blocked task', area: 'x', priority: 'high', status: 'blocked' }
  ];
  const out = renderTodos(todos);
  assert.match(out, /🚫.*blocked task/);
});

test('renderTodos: shortId + area appear inline', () => {
  const todos = [
    {
      shortId: 999,
      title: 'something',
      area: 'substrate-claude',
      priority: 'medium',
      status: 'open'
    }
  ];
  const out = renderTodos(todos);
  assert.match(out, /#999/);
  assert.match(out, /substrate-claude/);
});

// ---- renderAgentRules ----

test('renderAgentRules: empty list → no section emitted', () => {
  assert.equal(renderAgentRules([]), '');
});

test('renderAgentRules: must rules render in full grouped by category', () => {
  const rules = [
    {
      shortId: 100,
      rule: 'always X',
      category: 'process',
      severity: 'must',
      rationale: 'because Y'
    },
    {
      shortId: 101,
      rule: 'never Z',
      category: 'git',
      severity: 'must',
      rationale: 'lessons from W'
    },
    {
      shortId: 102,
      rule: 'prefer A',
      category: 'process',
      severity: 'must',
      rationale: 'efficiency'
    }
  ];
  const out = renderAgentRules(rules);
  assert.match(out, /## Agent Rules \(3 must\)/);
  assert.match(out, /### must/);
  // category subheaders inside the must block
  assert.match(out, /#### git/);
  assert.match(out, /#### process/);
  assert.match(out, /always X/);
  assert.match(out, /never Z/);
  // The rule body renders in full, the rationale does not.
  assert.doesNotMatch(out, /because Y/);
});

// ---- rationale is pointed at, never injected ----
//
// Rationale prose would roughly double the rules payload, so the assertions are
// on ABSENCE of the prose, which is the property that decays if
// someone re-adds `${r.rationale}` to a render path.

test('no full tier injects raw rationale prose', () => {
  const prose = 'INCIDENT-HISTORY-SENTINEL that must never be injected inline';
  const rules = [
    { shortId: 1, rule: 'must body', category: 'git', severity: 'must', rationale: prose },
    {
      shortId: 2,
      rule: 'pinned should body',
      category: 'git',
      severity: 'should',
      pinned: true,
      rationale: prose
    },
    {
      shortId: 3,
      rule: 'salient should body',
      category: 'git',
      severity: 'should',
      rationale: prose
    }
  ];
  const mustMd = renderAgentRules(rules, { only: 'must' });
  const salientMd = renderAgentRules(rules, { only: 'should', salience: true, topK: 5 });
  const classicMd = renderAgentRules(rules);

  for (const [name, md] of [
    ['must', mustMd],
    ['salient', salientMd],
    ['classic', classicMd]
  ]) {
    assert.doesNotMatch(md, new RegExp(prose), `${name} tier leaked rationale prose`);
  }
  // ...and the rule bodies themselves are untouched.
  assert.match(mustMd, /must body/);
  assert.match(salientMd, /pinned should body/);
  assert.match(salientMd, /salient should body/);
});

// No per-rule `*Why:* recorded — query …` line: it would repeat, once per rule,
// what the must preamble already says once.
test('no tier carries a per-rule rationale pointer', () => {
  const rules = [
    { shortId: 7, rule: 'r', category: 'git', severity: 'must', rationale: 'evidence' },
    { shortId: 8, rule: 'p', category: 'git', severity: 'should', pinned: true, rationale: 'e' },
    { shortId: 9, rule: 's', category: 'git', severity: 'should', rationale: 'e' }
  ];
  for (const md of [
    renderAgentRules(rules, { only: 'must' }),
    renderAgentRules(rules, { only: 'should', salience: true, salientMode: 'full' }),
    renderAgentRules(rules)
  ]) {
    assert.doesNotMatch(md, /\*Why:\*/);
    assert.doesNotMatch(md, /for `rationale`/);
  }
});

test('the must preamble names the namespace to fetch rationale from', () => {
  const rules = [
    { shortId: 7, rule: 'r', category: 'git', severity: 'must', rationale: 'evidence' }
  ];
  const out = renderAgentRules(rules, { only: 'must', ns: 'othernamespace' });
  assert.match(out, /`othernamespace\/AgentRule`/);
  assert.match(out, /rationale/);
});

// The salient tier renders one line per rule by default, like skim.
// `salientMode: 'full'` (SYNOPTIC_COLD_START_SALIENT=full) restores full bodies.
test('salient rules render as one-liners by default', () => {
  const rules = [
    {
      shortId: 41,
      rule: 'Prefer batched payloads. **How to apply:** BODY-DETAIL-SENTINEL.',
      synopsis: 'Batch mutate payloads.',
      category: 'tooling',
      severity: 'should'
    }
  ];
  const out = renderAgentRules(rules, { only: 'should', salience: true, topK: 5 });
  assert.match(out, /### salient — most relevant to this session/);
  assert.match(out, /- \*\*#41\*\* \*\(tooling\)\* — Batch mutate payloads\./);
  assert.doesNotMatch(out, /BODY-DETAIL-SENTINEL/);
  assert.doesNotMatch(out, /#### tooling/);
});

test('salientMode full restores salient bodies', () => {
  const rules = [
    {
      shortId: 41,
      rule: 'Prefer batched payloads. **How to apply:** BODY-DETAIL-SENTINEL.',
      synopsis: 'Batch mutate payloads.',
      category: 'tooling',
      severity: 'should'
    }
  ];
  const out = renderAgentRules(rules, {
    only: 'should',
    salience: true,
    topK: 5,
    salientMode: 'full'
  });
  assert.match(out, /BODY-DETAIL-SENTINEL/);
});

test('the must preamble says the rationale is recorded, not absent', () => {
  const rules = [
    { shortId: 10, rule: 'r', category: 'git', severity: 'must', rationale: 'evidence' }
  ];
  const out = renderAgentRules(rules, { only: 'must' });
  assert.match(out, /recorded but not injected/);
});

test('renderAgentRules: should rules render as one-line bullets in their own section', () => {
  const rules = [
    {
      shortId: 200,
      rule: 'big multiline rule. With multiple sentences. And so on.',
      category: 'style',
      severity: 'should',
      rationale: ''
    },
    { shortId: 201, rule: 'another tip', category: 'tooling', severity: 'should', rationale: '' }
  ];
  const out = renderAgentRules(rules);
  assert.match(out, /## Agent Rules — should \(2\)/);
  assert.match(out, /### should/);
  // First sentence only — multi-sentence body must be truncated
  assert.match(out, /#200.*\(style\).*big multiline rule\./);
  assert.doesNotMatch(out, /With multiple sentences/);
  // Bullet style for shoulds; no #### category subheaders inside the should block
  assert.doesNotMatch(out, /#### style/);
});

test('renderAgentRules: rules without severity default to should bucket', () => {
  const rules = [{ shortId: 1, rule: 'unclassified rule', category: 'tooling', rationale: '' }];
  const out = renderAgentRules(rules);
  assert.match(out, /## Agent Rules — should \(1\)/);
  assert.match(out, /### should/);
  assert.match(out, /unclassified rule/);
});

test('renderAgentRules: must without rationale renders rule body alone (no Why line)', () => {
  const rules = [
    { shortId: 1, rule: 'do the thing', category: 'tooling', severity: 'must', rationale: '' }
  ];
  const out = renderAgentRules(rules);
  assert.match(out, /do the thing/);
  assert.doesNotMatch(out, /\*Why:\*/);
});

test('renderAgentRules: mixed severities split correctly with header counts', () => {
  const rules = [
    { shortId: 1, rule: 'must rule', category: 'git', severity: 'must', rationale: '' },
    { shortId: 2, rule: 'should rule', category: 'style', severity: 'should', rationale: '' },
    { shortId: 3, rule: 'unclassified', category: 'process', rationale: '' }
  ];
  const out = renderAgentRules(rules);
  assert.match(out, /## Agent Rules \(1 must, 2 should\)/);
});

// ---- renderAgentRules: salience mode (cold-start dilution reduction) ----

const mkRule = (shortId, rule, category, severity, pinned = false) => ({
  shortId,
  rule,
  category,
  severity,
  rationale: '',
  pinned
});

test('renderAgentRules salience OFF (default): pinned flag ignored, classic must/should', () => {
  const rules = [mkRule(1, 'a must rule', 'git', 'must', true)];
  const out = renderAgentRules(rules); // no opts → flag off
  assert.match(out, /## Agent Rules \(1 must\)/);
});

test('renderAgentRules salience ON: pinned rules render full, exempt from ranking', () => {
  const rules = [
    mkRule(3, 'never commit to main always branch', 'git', 'must', true),
    mkRule(50, 'a contextual tooling note about widgets', 'tooling', 'should', false)
  ];
  const out = renderAgentRules(rules, {
    salience: true,
    sessionContext: 'unrelated topic',
    topK: 0
  });
  assert.match(out, /pinned/i);
  assert.match(out, /never commit to main always branch/); // full body, not summarized away
});

test('renderAgentRules salience ON: never-omit — every rule appears exactly once across tiers', () => {
  const rules = [
    mkRule(3, 'never commit to main', 'git', 'must', true),
    mkRule(40, 'always create a feature branch and open a pull request', 'git', 'should', false),
    mkRule(50, 'widget tooling tip', 'tooling', 'should', false),
    mkRule(60, 'gadget style note', 'style', 'should', false)
  ];
  const out = renderAgentRules(rules, {
    salience: true,
    sessionContext: 'working on a git branch and pull request',
    topK: 1
  });
  for (const id of [3, 40, 50, 60]) {
    const count = (out.match(new RegExp(`#${id}\\b`, 'g')) || []).length;
    assert.equal(count, 1, `#${id} should appear exactly once, saw ${count}`);
  }
});

test('renderAgentRules salience ON: top-K relevant unpinned promoted to full, rest skimmed', () => {
  const rules = [
    mkRule(
      40,
      'always create a feature branch and open a pull request for changes',
      'git',
      'should',
      false
    ),
    mkRule(50, 'unrelated widget gadget tooling note here', 'tooling', 'should', false)
  ];
  const out = renderAgentRules(rules, {
    salience: true,
    sessionContext: 'git branch pull request feature',
    topK: 1
  });
  // The git rule is topically relevant → promoted to full body.
  assert.match(out, /always create a feature branch and open a pull request for changes/);
  // The unrelated rule is present in the skim tail.
  assert.match(out, /#50/);
  assert.match(out, /salient/i);
});

test('buildRuleSessionContext: concatenates todo titles + areas; tolerates empties', () => {
  const ctx = buildRuleSessionContext([
    { title: 'extract composeFromManifests', area: 'substrate-compose' },
    { title: 'fix lint', area: null },
    {}
  ]);
  assert.match(ctx, /extract composeFromManifests/);
  assert.match(ctx, /substrate-compose/);
  assert.match(ctx, /fix lint/);
  assert.equal(buildRuleSessionContext(undefined), '');
  assert.equal(buildRuleSessionContext([]), '');
});

// ---- renderConcepts wiring ----
//
// Smoke-asserts the hook's binding to scoring/concepts.js. Renderer-internal
// behavior is covered by scoring/concepts.test.js; this guards the row-shape
// contract the hook relies on (name + description + kind, archived filter).

test('renderConcepts (wiring): empty list → empty string (matches hook no-emit branch)', () => {
  assert.equal(renderConcepts([]), '');
});

test('renderConcepts (wiring): row-shape contract — name + description + kind appear in output', () => {
  const rows = [{ name: 'cold-start', description: 'session boot protocol', kind: 'protocol' }];
  const out = renderConcepts(rows);
  assert.match(out, /## Concepts \(operational semantics — 1 total\)/);
  assert.match(out, /### protocol/);
  assert.match(out, /\*\*cold-start\*\*/);
  assert.match(out, /> session boot protocol/);
});

// ---- renderAgentRules: severity split for placement ----

test('renderAgentRules only:"must" returns just the binding tier', () => {
  const rules = [
    mkRule(1, 'a must rule', 'git', 'must'),
    mkRule(2, 'an advisory rule', 'style', 'should')
  ];
  const out = renderAgentRules(rules, { only: 'must' });
  assert.match(out, /## Agent Rules — must \(1\)/);
  assert.ok(out.includes('a must rule'));
  assert.ok(!out.includes('an advisory rule'));
});

test('renderAgentRules only:"should" returns just the advisory tier', () => {
  const rules = [
    mkRule(1, 'a must rule', 'git', 'must'),
    mkRule(2, 'an advisory rule', 'style', 'should')
  ];
  const out = renderAgentRules(rules, { only: 'should' });
  assert.match(out, /## Agent Rules — should \(1\)/);
  assert.ok(out.includes('an advisory rule'));
  assert.ok(!out.includes('a must rule'));
});

test('renderAgentRules only:"should" treats a missing severity as advisory', () => {
  const out = renderAgentRules([mkRule(9, 'no severity set', 'tooling', undefined)], {
    only: 'should'
  });
  assert.ok(out.includes('no severity set'));
});

test('renderAgentRules: an empty tier renders nothing at all', () => {
  const out = renderAgentRules([mkRule(1, 'only a should', 'style', 'should')], { only: 'must' });
  assert.equal(out, '');
});

test('renderAgentRules: salience never ranks a must rule out of view', () => {
  // Ranking a binding rule below a cutoff is the failure the split prevents,
  // so the must tier is not eligible for salience even when it is switched on.
  const rules = [
    mkRule(3, 'never commit straight to main', 'git', 'must'),
    mkRule(50, 'a contextual tooling note about widgets', 'tooling', 'should')
  ];
  const out = renderAgentRules(rules, {
    only: 'must',
    salience: true,
    sessionContext: 'a completely unrelated topic',
    topK: 0
  });
  assert.ok(out.includes('never commit straight to main'), 'must survives topK: 0');
});

test('renderAgentRules: the must section states that it binds', () => {
  const out = renderAgentRules([mkRule(1, 'r', 'git', 'must')], { only: 'must' });
  assert.match(out, /Binding\. These are not preferences\./);
});

test('renderAgentRules default only:"all" keeps the combined rendering', () => {
  const rules = [mkRule(1, 'm', 'git', 'must'), mkRule(2, 's', 'style', 'should')];
  assert.match(renderAgentRules(rules), /## Agent Rules \(1 must, 1 should\)/);
});

test('renderAgentRules: a salient render of one tier names that tier in its heading', () => {
  // Without the label the split would emit a second `## Agent Rules`
  // that looks like the whole set while silently missing every must rule.
  const rules = [
    mkRule(1, 'a must rule', 'git', 'must'),
    mkRule(2, 'an advisory rule about widgets', 'tooling', 'should')
  ];
  const out = renderAgentRules(rules, { only: 'should', salience: true, sessionContext: 'x' });
  assert.match(out, /## Agent Rules — should \(/);
  assert.ok(!/## Agent Rules \(/.test(out), 'must not emit an unlabelled Agent Rules heading');
});

test('renderAgentRules: a salient render of ALL rules keeps the unlabelled heading', () => {
  const rules = [mkRule(1, 'm', 'git', 'must'), mkRule(2, 's', 'style', 'should')];
  const out = renderAgentRules(rules, { salience: true, sessionContext: 'x' });
  assert.match(out, /## Agent Rules \(\d+ pinned, \d+ salient, \d+ skim\)/);
});

// ---- category ordering (attention position is a decision, not a spelling) ----
//
// Categories are ordered deliberately, not by `Object.keys().sort()`: in a
// payload long enough to lose the middle, alphabetical order would spend the
// strongest positions on whatever happens to sort early.

const ORDERING_RULES = [
  { shortId: 10, rule: 'style rule', category: 'style', severity: 'must', synopsis: 's' },
  {
    shortId: 11,
    rule: 'verification rule',
    category: 'verification',
    severity: 'must',
    synopsis: 'v'
  },
  { shortId: 12, rule: 'substrate rule', category: 'substrate', severity: 'must', synopsis: 'sub' },
  { shortId: 13, rule: 'git rule', category: 'git', severity: 'must', synopsis: 'g' }
];

test('categories render by COST of violation, not alphabetically', () => {
  const out = renderAgentRules(ORDERING_RULES, { ns: 'cortext' });
  const at = (c) =>
    out.indexOf(`### ${c}`) >= 0 ? out.indexOf(`### ${c}`) : out.indexOf(`#### ${c}`);
  assert.ok(at('substrate') < at('verification'), 'substrate must precede verification');
  assert.ok(at('verification') < at('git'), 'verification must precede git');
  assert.ok(at('git') < at('style'), 'git must precede style');
});

test('alphabetical order is genuinely NOT what is produced — the guard would pass by accident otherwise', () => {
  const out = renderAgentRules(ORDERING_RULES, { ns: 'cortext' });
  const cats = ['substrate', 'verification', 'git', 'style'];
  const positions = cats.map((c) => ({ c, i: out.indexOf(c) }));
  const byRender = positions
    .slice()
    .sort((a, b) => a.i - b.i)
    .map((p) => p.c);
  const byAlpha = cats.slice().sort();
  assert.notDeepEqual(byRender, byAlpha);
});

test('an UNRANKED category renders after the ranked ones, not silently at the front', () => {
  const rules = [
    ...ORDERING_RULES,
    { shortId: 14, rule: 'novel', category: 'aaa-brand-new', severity: 'must', synopsis: 'n' }
  ];
  const out = renderAgentRules(rules, { ns: 'cortext' });
  assert.ok(
    out.indexOf('aaa-brand-new') > out.indexOf('style'),
    'an unranked category sorts alphabetically first and must NOT lead the block'
  );
});

test('the must digest is ordered and numbered — it is the strongest position in the payload', () => {
  const out = renderMustDigest(ORDERING_RULES, 'cortext');
  assert.match(out, /^1\. \*\*#12\*\*/m, 'kernel leads the digest');
  assert.ok(out.indexOf('#12') < out.indexOf('#11'), 'kernel before verification');
  assert.ok(out.indexOf('#11') < out.indexOf('#13'), 'verification before git');
  assert.ok(out.indexOf('#13') < out.indexOf('#10'), 'git before style');
});

test('pinned leads within a category; shortId breaks the tie', () => {
  const rules = [
    { shortId: 30, rule: 'later', category: 'verification', severity: 'must', synopsis: 'a' },
    { shortId: 20, rule: 'earlier', category: 'verification', severity: 'must', synopsis: 'b' },
    {
      shortId: 40,
      rule: 'pinned',
      category: 'verification',
      severity: 'must',
      synopsis: 'c',
      pinned: true
    }
  ];
  const out = renderMustDigest(rules, 'cortext');
  assert.ok(out.indexOf('#40') < out.indexOf('#20'), 'pinned leads regardless of shortId');
  assert.ok(out.indexOf('#20') < out.indexOf('#30'), 'shortId ascending breaks the tie');
});

test('every rule still renders — reordering must not drop one', () => {
  const out = renderMustDigest(ORDERING_RULES, 'cortext');
  for (const r of ORDERING_RULES) assert.match(out, new RegExp(`#${r.shortId}\\b`));
  assert.match(out, /4 `must`/);
});

// ---- the header must not name arms it did not verify ----
//
// `renderUnified` is only reached when recall answered, which establishes that
// rows came back and nothing about WHICH ARMS produced them. These pin the
// header to what `describeRecallArms` actually established.

function unifiedFixture() {
  const row = { id: 'm1', body: { shortId: 7, name: 'a_memory', type: 'insight', body: 'x' } };
  const result = {
    mode: 'hybrid',
    anchor: {
      id: 'a1',
      source: 'sessionlog',
      body: { shortId: 1068, startedAt: 't', branch: 'main' }
    },
    byType: { Memory: [{ row }], SessionLog: [], Decision: [] }
  };
  const ranked = {
    top: [
      {
        type: 'Memory',
        row,
        structural: 0.9,
        semantic: 0.8,
        structuralRank: 1,
        semanticRank: 1,
        combined: 0.03,
        combinedRank: 1
      }
    ],
    index: []
  };
  return { result, ranked };
}

test('renderUnified: both arms verified wired → the hybrid header is earned', () => {
  const { result, ranked } = unifiedFixture();
  const arms = {
    dense: 'wired',
    lexical: 'wired',
    label: 'hybrid recall — RRF, unified',
    evidence: 'e'
  };
  const out = renderUnified({ result, ranked, projectSlug: 'synoptic', k: 60, arms });
  assert.match(out, /^## Agent Memory \(hybrid recall — RRF, unified\)/m);
});

test('renderUnified: dense arm only → header names it and never says hybrid', () => {
  const { result, ranked } = unifiedFixture();
  const arms = {
    dense: 'wired',
    lexical: 'off',
    label: 'recall — RRF, dense arm only',
    evidence: 'e'
  };
  const out = renderUnified({ result, ranked, projectSlug: 'synoptic', k: 60, arms });
  assert.match(out, /^## Agent Memory \(recall — RRF, dense arm only\)/m);
  assert.doesNotMatch(out, /hybrid/);
});

test('renderUnified: arms unverified → header says so instead of claiming hybrid', () => {
  const { result, ranked } = unifiedFixture();
  const arms = {
    dense: 'unknown',
    lexical: 'unknown',
    label: 'recall — RRF, arms unverified',
    evidence: 'e'
  };
  const out = renderUnified({ result, ranked, projectSlug: 'synoptic', k: 60, arms });
  assert.match(out, /^## Agent Memory \(recall — RRF, arms unverified\)/m);
  assert.doesNotMatch(out, /hybrid/);
});

test('renderUnified: renders the arms evidence line under Mode', () => {
  const { result, ranked } = unifiedFixture();
  const arms = {
    dense: 'wired',
    lexical: 'off',
    label: 'recall — RRF, dense arm only',
    evidence: 'dense wired, lexical off — from GET /substrate/v1/embed-stats.'
  };
  const out = renderUnified({ result, ranked, projectSlug: 'synoptic', k: 60, arms });
  assert.match(
    out,
    /Recall arms: dense wired, lexical off — from GET \/substrate\/v1\/embed-stats\./
  );
});

// The default matters more than any of the above: an omitted `arms` is the
// state the old code was permanently in, and it must be the modest one.
test('renderUnified: arms omitted → falls back to unverified, never to hybrid', () => {
  const { result, ranked } = unifiedFixture();
  const out = renderUnified({ result, ranked, projectSlug: 'synoptic', k: 60 });
  assert.doesNotMatch(out, /hybrid/);
  assert.match(out, /arms unverified/);
});

// ---- `renderUnified` follows the same rule as `renderTodos`, which returns ''
// rather than head an empty list: no header claiming hybrid recall and no Mode
// line naming a fusion over nothing, without saying there was nothing.
//
// Read with the question removed, two clauses still had to be true and neither
// was checked: that there IS agent memory, and that RRF fused a structural
// rank with a semantic one. The arms clause beside them is correctly hedged;
// the presupposition sat in the grammar nobody was reviewing.
//
// Reachable: an empty-but-successful recall leaves `recallRows` as `[]`, which
// is not null, so `recallAvailable` is true and this branch renders. The real
// instance is a fresh store's first session, where /substrate-setup authors an
// AnchorIntent before any SessionLog exists.
const WIRED_ARMS = {
  dense: 'wired',
  lexical: 'wired',
  label: 'hybrid recall — RRF, unified',
  evidence: 'dense wired, lexical wired — from GET /substrate/v1/embed-stats.'
};

function emptyUnifiedFixture() {
  const { result } = unifiedFixture();
  return { result, ranked: { top: [], index: [] } };
}

test('renderUnified: nothing ranked → says so, instead of heading an empty section', () => {
  const { result, ranked } = emptyUnifiedFixture();
  const out = renderUnified({ result, ranked, projectSlug: 'synoptic', k: 60, arms: WIRED_ARMS });
  assert.match(out, /No Memory, SessionLog or Decision rows in scope/);
  assert.match(out, /nothing was ranked/i);
});

test('renderUnified: nothing ranked → the Mode line does not assert a fusion that did not happen', () => {
  const { result, ranked } = emptyUnifiedFixture();
  const out = renderUnified({ result, ranked, projectSlug: 'synoptic', k: 60, arms: WIRED_ARMS });
  const mode = out.split('\n').find((l) => l.startsWith('Mode:'));
  assert.ok(mode, 'a Mode line should still render — it is configuration, and worth showing');
  assert.match(mode, /no rows to fuse/);
});

// The populated case must not grow the disclaimer, or it stops meaning
// anything — the same guard as the `partial coverage` qualifier.
test('renderUnified: with rows ranked, no empty-scope notice and an unqualified Mode line', () => {
  const { result, ranked } = unifiedFixture();
  const out = renderUnified({ result, ranked, projectSlug: 'synoptic', k: 60, arms: WIRED_ARMS });
  assert.doesNotMatch(out, /rows in scope/);
  assert.doesNotMatch(out, /no rows to fuse/);
});

// The defect was an inconsistency BETWEEN emitters, so pin them together:
// neither may head a section it has no rows for without saying so.
test('renderUnified and renderTodos agree that an empty set is stated, not implied', () => {
  assert.equal(renderTodos([]), '');
  const { result, ranked } = emptyUnifiedFixture();
  const out = renderUnified({ result, ranked, projectSlug: 'synoptic', k: 60, arms: WIRED_ARMS });
  assert.match(out, /^## Agent Memory/m);
  assert.match(out, /in scope/);
});

// ---- the section says whose memory it is showing. Without the split, a
// project with no rows of its own rendering only cross-cutting rows would look
// the same as one with rows of its own.
//
// The two arms can also disagree about scope — the
// structural query filters on project, `recall/Hit` accepts no filter — so the
// render also reports what the client-side filter removed. See recall-scoring.
const NO_DROPS = { total: 0, unknown: 0, byProject: {} };

function projectedFixture(projects) {
  const { result, ranked } = unifiedFixture();
  const proto = ranked.top[0];
  ranked.top = projects.map((project, i) => ({
    ...proto,
    row: {
      id: `r${i}`,
      body: project === undefined ? { ...proto.row.body } : { ...proto.row.body, project }
    }
  }));
  ranked.index = [];
  return { result, ranked };
}

test('renderUnified: the recall count names the project / cross-cutting split', () => {
  const { result, ranked } = projectedFixture(['synoptic', null, null]);
  const out = renderUnified({
    result,
    ranked,
    projectSlug: 'synoptic',
    k: 60,
    arms: WIRED_ARMS,
    scopeDrops: NO_DROPS
  });
  assert.match(out, /### Top recall \(3 of 3 — 1 for this project, 2 cross-cutting\)/);
});

// The case the todo was filed for: a project contributing nothing must not be
// indistinguishable from one contributing everything.
test('renderUnified: a project contributing no rows of its own says so', () => {
  const { result, ranked } = projectedFixture([null, null]);
  const out = renderUnified({
    result,
    ranked,
    projectSlug: 'brand-new',
    k: 60,
    arms: WIRED_ARMS,
    scopeDrops: NO_DROPS
  });
  assert.match(out, /0 for this project, 2 cross-cutting/);
});

// Scope `all` has no project to split against, so the annotation would be
// meaningless — the same guard as the `partial coverage` qualifier.
test('renderUnified: no split when the scope is all projects', () => {
  const { result, ranked } = projectedFixture(['synoptic', null]);
  const out = renderUnified({
    result,
    ranked,
    projectSlug: null,
    k: 60,
    arms: WIRED_ARMS,
    scopeDrops: NO_DROPS
  });
  assert.match(out, /### Top recall \(2 of 2\)/);
  assert.doesNotMatch(out, /for this project/);
});

// A row whose `project` never arrived is not counted as cross-cutting — that
// would be the absent-is-false conflation.
test('renderUnified: rows with no project field are counted as unknown, not cross-cutting', () => {
  const { result, ranked } = projectedFixture([null, undefined]);
  const out = renderUnified({
    result,
    ranked,
    projectSlug: 'synoptic',
    k: 60,
    arms: WIRED_ARMS,
    scopeDrops: NO_DROPS
  });
  assert.match(out, /0 for this project, 1 cross-cutting, 1 unknown/);
});

test('renderUnified: reports what the client-side scope filter dropped, and why', () => {
  const { result, ranked } = projectedFixture([null]);
  const out = renderUnified({
    result,
    ranked,
    projectSlug: 'synoptic',
    k: 60,
    arms: WIRED_ARMS,
    scopeDrops: { total: 78, unknown: 0, byProject: { app: 51, substrate: 27 } }
  });
  assert.match(out, /Scope filter: dropped 78 semantic hits from other projects/);
  assert.match(out, /app 51, substrate 27/);
  assert.match(out, /recall\/Hit refused the project filter \(an older server\)/);
});

// Nothing dropped is the ordinary case, and a line saying "dropped 0" every
// session is noise the qualifier guards exist to avoid.
test('renderUnified: no scope-filter line when nothing was dropped', () => {
  const { result, ranked } = projectedFixture([null]);
  const out = renderUnified({
    result,
    ranked,
    projectSlug: 'synoptic',
    k: 60,
    arms: WIRED_ARMS,
    scopeDrops: NO_DROPS
  });
  assert.doesNotMatch(out, /Scope filter/);
});

// ---- the memory section has TWO emitters, `renderUnified` and
// `renderStructural`, and `recallAvailable` upstream decides which a session
// sees. The path that renders BECAUSE recall was unavailable must say so too.
//
// Enforced at the choke point rather than in each emitter: a rule enforced in
// one place is a guarantee, where the same rule repeated in every emitter is a
// convention that the next emitter is free to omit. `renderRecallState` owns WHAT must be disclosed;
// each renderer only places it.
//
// Three states, not two. `unavailable` (recall was asked and could not answer)
// and `not-attempted` (no anchor, so nothing was asked) are different facts,
// and collapsing them would be the absent-is-false conflation.
const ARMS_FOR_STATE = {
  dense: 'wired',
  lexical: 'wired',
  label: 'hybrid recall — RRF, unified',
  evidence: 'dense wired, lexical wired — from GET /substrate/v1/embed-stats.'
};

test('renderRecallState: fused names the fusion and the arms', () => {
  const lines = renderRecallState({
    recallState: 'fused',
    arms: ARMS_FOR_STATE,
    k: 60,
    total: 3,
    searched: ['Memory', 'SessionLog', 'Decision']
  });
  const text = lines.join('\n');
  assert.match(text, /Mode: RRF fusion, structural \+ semantic \(k=60\)/);
  assert.match(text, /Recall arms: dense wired/);
});

test('renderRecallState: unavailable says recall was asked and could not answer', () => {
  const text = renderRecallState({
    recallState: 'unavailable',
    arms: ARMS_FOR_STATE,
    k: 60,
    total: 3,
    searched: ['Memory']
  }).join('\n');
  assert.match(text, /structural only/);
  assert.match(text, /semantic recall was unavailable/);
  assert.doesNotMatch(text, /RRF fusion/);
});

test('renderRecallState: not-attempted is distinct from unavailable', () => {
  const text = renderRecallState({
    recallState: 'not-attempted',
    arms: ARMS_FOR_STATE,
    k: 60,
    total: 3,
    searched: ['Memory']
  }).join('\n');
  assert.match(text, /not attempted/);
  assert.doesNotMatch(text, /unavailable/);
});

// The arms line renders on every state. It reports CONFIGURATION, which is a
// fact about the server whether or not a query ran — and its own wording
// already disclaims that any arm answered, so it cannot imply recall ran.
test('renderRecallState: the arms line renders even when recall never ran', () => {
  for (const recallState of ['fused', 'unavailable', 'not-attempted']) {
    const text = renderRecallState({
      recallState,
      arms: ARMS_FOR_STATE,
      k: 60,
      total: 1,
      searched: ['Memory']
    }).join('\n');
    assert.match(text, /Recall arms:/, `missing on ${recallState}`);
  }
});

// ---- A per-emitter assertion cannot
// see a split; only a pairwise one can.
test('both memory emitters disclose the same facts about the same situation', () => {
  const arms = ARMS_FOR_STATE;
  const structural = renderStructural({
    rows: [],
    projectSlug: 'synoptic',
    topK: 10,
    baseline: 0,
    importanceWeights: {},
    ns: 'cortext',
    recallState: 'unavailable',
    arms
  });
  const { result, ranked } = emptyUnifiedFixture();
  const unified = renderUnified({
    result,
    ranked,
    projectSlug: 'synoptic',
    k: 60,
    arms,
    scopeDrops: NO_DROPS
  });
  for (const out of [structural, unified]) {
    assert.match(out, /^## Agent Memory/m);
    assert.match(out, /Project scope:/);
    assert.match(out, /^Mode: /m);
    assert.match(out, /^Recall arms: /m);
    assert.match(out, /rows in scope/);
  }
});

test('renderStructural: says it is a fallback rather than looking like a healthy session', () => {
  const out = renderStructural({
    rows: [{ name: 'a', type: 'user', description: 'd', body: 'b', updatedAt: '2026-09-10' }],
    projectSlug: 'synoptic',
    topK: 10,
    baseline: 0,
    importanceWeights: {},
    ns: 'cortext',
    recallState: 'unavailable',
    arms: ARMS_FOR_STATE
  });
  assert.match(out, /semantic recall was unavailable/);
  assert.match(out, /Recall arms:/);
});
