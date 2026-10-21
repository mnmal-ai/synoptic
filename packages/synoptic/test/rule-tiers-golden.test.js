// The rules render's tiering lives in @mnmal-ai/context-render. The golden was
// recorded from render.js before the tiering moved there, so this proves
// synoptic's cold-start output did not change by a byte — and that the promoted set fed to salience write-back did not
// either. Regenerate only for a DELIBERATE output change, never to make it pass.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { renderAgentRules } from '../src/render.js';
import { CASES, RULES } from './fixtures/rule-tiers-cases.js';

const GOLDEN = JSON.parse(
  readFileSync(new URL('./fixtures/rule-tiers-golden.json', import.meta.url), 'utf8')
);

test('golden covers every case', () => {
  assert.deepEqual(Object.keys(GOLDEN).sort(), Object.keys(CASES).sort());
});

for (const [name, opts] of Object.entries(CASES)) {
  test(`rules render is byte-identical to the recorded golden: ${name}`, () => {
    const promoted = [];
    const md = renderAgentRules(RULES, {
      ...opts,
      onPromoted: (rs) => promoted.push(...rs.map((r) => r.shortId))
    });
    assert.equal(md, GOLDEN[name].md);
    assert.deepEqual(promoted, GOLDEN[name].promoted);
  });
}
