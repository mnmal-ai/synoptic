import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderRuleIndex } from '../src/index-render.js';
import { ruleFixture } from './fixtures/rule-index.js';

const FOOTER_21 =
  "Footer: one line, 'Written by [mnmal-ai-agent](https://github.com/mnmal-ai-agent) (<model name>)', e.g. (Claude Opus 5.5), on commits and PR bodies; commits authored as mnmal-ai-one, GitHub ops as mnmal-ai-agent; no Co-Authored-By, not the old mnmal-ai-claude line.";

const count = (s, sub) => s.split(sub).length - 1;

test('renders every must and pinned rule exactly once', () => {
  const rules = ruleFixture();
  const out = renderRuleIndex(rules, { project: 'synoptic' });
  for (const r of rules.filter((r) => r.severity === 'must' || r.pinned)) {
    assert.equal(count(out, `#${r.shortId} (`), 1, `#${r.shortId}`);
  }
  for (const r of rules.filter((r) => r.severity !== 'must' && !r.pinned)) {
    assert.ok(!out.includes(r.synopsis), `unpinned should #${r.shortId} leaked`);
  }
  assert.match(out, /20 more rules/);
});

test('renders a literal synopsis byte-for-byte', () => {
  const pipe = "Never pipe a command whose exit code matters — `cmd | tail` reports tail's.";
  const out = renderRuleIndex(
    [
      { shortId: 21, category: 'git', severity: 'must', synopsis: FOOTER_21 },
      { shortId: 52, category: 'verification', severity: 'must', synopsis: pipe }
    ],
    { project: 'synoptic' }
  );
  assert.ok(out.includes(`#21 (git) ${FOOTER_21}`));
  assert.ok(out.includes(`#52 (verification) ${pipe}`));
});

test('never clips a long synopsis', () => {
  const long = `${'word '.repeat(80)}end.`;
  const out = renderRuleIndex([{ shortId: 1, category: 'git', severity: 'must', synopsis: long }], {
    project: 'p'
  });
  assert.ok(out.includes(long));
});

test('musts precede pinned, both in category order', () => {
  const out = renderRuleIndex(
    [
      { shortId: 3, category: 'git', severity: 'must', synopsis: 'g' },
      { shortId: 53, category: 'permissions', severity: 'must', synopsis: 'p' },
      { shortId: 40, category: 'permissions', severity: 'should', pinned: true, synopsis: 'x' }
    ],
    { project: 'p' }
  );
  assert.ok(out.indexOf('#53 (') < out.indexOf('#3 ('));
  assert.ok(out.indexOf('#3 (') < out.indexOf('Always-on'));
  assert.ok(out.indexOf('Always-on') < out.indexOf('#40 ('));
});

test('no pinned rules: no Always-on label', () => {
  const out = renderRuleIndex([{ shortId: 3, category: 'git', severity: 'must', synopsis: 'g' }], {
    project: 'p'
  });
  assert.ok(!out.includes('Always-on'));
});

test('no synopsis names the row; no category drops the parens', () => {
  const out = renderRuleIndex(
    [
      { shortId: 9, category: 'git', severity: 'must', synopsis: null },
      { shortId: 8, severity: 'must', synopsis: 'bare' }
    ],
    { project: 'p' }
  );
  assert.ok(out.includes('#9 (git) (no synopsis — query the row)'));
  assert.ok(out.includes('#8 bare'));
});

test('pointer lines name the project and the namespace', () => {
  const out = renderRuleIndex([], { ns: 'cortext', project: 'synoptic' });
  assert.match(out, /cortext\/AnchorIntent/);
  assert.match(out, /synoptic/);
  assert.match(out, /cortext\/Todo/);
});

test('a null project (SYNOPTIC_PROJECT_SCOPE=all) says all projects, not a project filter', () => {
  const out = renderRuleIndex([], { ns: 'cortext', project: null });
  assert.match(out, /query \(all projects\)/);
  assert.doesNotMatch(out, /`project`/);
});
