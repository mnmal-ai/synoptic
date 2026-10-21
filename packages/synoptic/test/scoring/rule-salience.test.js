// Tests for the AgentRule salience scorer (cold-start dilution reduction).
// Pure, deterministic, no I/O — mirrors memory-scorer.js conventions.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { rankRules, scoreRules, tokenize } from '../../src/scoring/rule-salience.js';

const gitRule = {
  shortId: 3,
  rule: 'Always create a feature branch and open a pull request; never commit to main.',
  category: 'git',
  severity: 'must'
};
const debugRule = {
  shortId: 33,
  rule: 'Write a plane observation pattern when you hit a non-obvious debugging recipe.',
  category: 'context-capture',
  severity: 'should'
};

test('tokenize lowercases, drops stopwords and short tokens, dedupes', () => {
  const toks = tokenize('Always open a Pull Request and the branch');
  assert.equal(toks.includes('pull'), true);
  assert.equal(toks.includes('request'), true);
  assert.equal(toks.includes('branch'), true);
  assert.equal(toks.includes('and'), false); // stopword
  assert.equal(toks.includes('a'), false); // too short / stopword
});

test('ranks the topically-relevant rule above an unrelated one', () => {
  const ranked = scoreRules(
    [debugRule, gitRule],
    'working on a git branch and pull request for the release'
  );
  assert.equal(ranked[0].shortId, 3); // git rule wins under git-heavy context
  assert.equal(ranked[0].score > ranked[1].score, true);
});

test('is deterministic — identical inputs produce identical ranking + scores', () => {
  const ctx = 'git branch pull request';
  const a = scoreRules([debugRule, gitRule], ctx);
  const b = scoreRules([debugRule, gitRule], ctx);
  assert.deepEqual(a, b);
});

test('empty context → no lexical signal; `should` rules score 0, ordered by shortId', () => {
  // Use boost-free `should` rules so the only signal is lexical overlap (none).
  const s1 = {
    shortId: 7,
    rule: 'responses should be concise',
    category: 'style',
    severity: 'should'
  };
  const s2 = {
    shortId: 1,
    rule: 'defer style judgment to the agent',
    category: 'style',
    severity: 'should'
  };
  const ranked = scoreRules([s1, s2], '');
  assert.deepEqual(
    ranked.map((r) => r.score),
    [0, 0]
  );
  assert.deepEqual(
    ranked.map((r) => r.shortId),
    [1, 7] // ascending shortId tiebreak
  );
});

test('a `must` rule keeps its boost even under empty context (mildly favored when untopical)', () => {
  const ranked = scoreRules([debugRule, gitRule], '');
  assert.equal(ranked[0].shortId, 3); // git rule is `must` → 0.5 > debug `should` 0
  assert.equal(ranked[0].score, 0.5);
  assert.equal(ranked[1].score, 0);
});

test('a `must` rule outranks a `should` rule of equal lexical overlap', () => {
  const mustRule = {
    shortId: 10,
    rule: 'review the deployment carefully',
    category: 'process',
    severity: 'must'
  };
  const shouldRule = {
    shortId: 11,
    rule: 'review the deployment carefully',
    category: 'process',
    severity: 'should'
  };
  const ranked = scoreRules([shouldRule, mustRule], 'deployment review');
  assert.equal(ranked[0].shortId, 10); // must boost breaks the tie
});

test('ties on score break by ascending shortId (never random)', () => {
  const r1 = { shortId: 8, rule: 'unrelated alpha', category: 'style', severity: 'should' };
  const r2 = { shortId: 2, rule: 'unrelated beta', category: 'style', severity: 'should' };
  const ranked = scoreRules([r1, r2], 'completely orthogonal context terms');
  assert.deepEqual(
    ranked.map((r) => r.shortId),
    [2, 8]
  );
});

// ---- rankRules: structural × semantic (anchor-cosine) RRF ----

const vec = (...xs) => Float32Array.from(xs);

test('rankRules with no anchor vector → identical to structural-only scoreRules', () => {
  const rules = [gitRule, debugRule];
  const ctx = 'git branch pull request';
  const hybrid = rankRules(rules, {
    sessionContext: ctx,
    anchorVector: null,
    ruleVectors: new Map()
  });
  assert.deepEqual(hybrid, scoreRules(rules, ctx));
});

test('rankRules lifts a zero-term-overlap rule when it is semantically close to the anchor', () => {
  // Three rules, none share vocabulary with the context → structural all-zero,
  // so structural order is by shortId: [50, 51, 52]. Rule 52 is semantically
  // aligned with the anchor; it should rank HIGHER with the anchor than the
  // structural-only ordering puts it (last).
  const rules = [
    { shortId: 50, rule: 'alpha widget', category: 'tooling', severity: 'should' },
    { shortId: 51, rule: 'beta gadget', category: 'tooling', severity: 'should' },
    { shortId: 52, rule: 'gamma sprocket', category: 'tooling', severity: 'should' }
  ];
  const ctx = 'completely unrelated session terms';
  const anchorVector = vec(1, 0, 0);
  const ruleVectors = new Map([
    [50, vec(0, 1, 0)], // cosine 0
    [51, vec(0, 0, 1)], // cosine 0
    [52, vec(1, 0, 0)] // cosine 1 — semantically aligned
  ]);
  const structuralPos = scoreRules(rules, ctx).findIndex((r) => r.shortId === 52);
  const hybridPos = rankRules(rules, { sessionContext: ctx, anchorVector, ruleVectors }).findIndex(
    (r) => r.shortId === 52
  );
  assert.equal(hybridPos < structuralPos, true);
});

test('rankRules tolerates rules with no stored vector (structural-only for those)', () => {
  const rules = [
    { shortId: 50, rule: 'alpha widget', category: 'tooling', severity: 'should' },
    { shortId: 51, rule: 'beta gadget', category: 'tooling', severity: 'should' }
  ];
  const ruleVectors = new Map([[50, vec(1, 0, 0)]]); // 51 has no vector
  const out = rankRules(rules, {
    sessionContext: 'beta gadget',
    anchorVector: vec(1, 0, 0),
    ruleVectors
  });
  assert.equal(out.length, 2);
  assert.deepEqual([...out].map((r) => r.shortId).sort(), [50, 51]);
});

test('rankRules is deterministic', () => {
  const rules = [gitRule, debugRule];
  const opts = {
    sessionContext: 'git branch',
    anchorVector: vec(1, 0),
    ruleVectors: new Map([
      [3, vec(1, 0)],
      [33, vec(0, 1)]
    ])
  };
  assert.deepEqual(rankRules(rules, opts), rankRules(rules, opts));
});
