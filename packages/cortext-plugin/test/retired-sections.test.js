// The cold-start renders a binding-rule index only. Text an agent or installer
// reads must not promise the retired Concepts / Memory / Open Work sections.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { truncateToBudget } from '../../synoptic/src/cold-start.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RETIRED = /Concepts|Agent Memory|Open Work|cortext\/Memory|cortext\/Todo/;

it('the plugin manifest description names the rule index', () => {
  const { description } = JSON.parse(
    readFileSync(join(root, 'packages/cortext-plugin/.claude-plugin/plugin.json'), 'utf8')
  );
  expect(description).not.toMatch(RETIRED);
});

it('the OpenCode compaction pointer names the rule index', () => {
  const src = readFileSync(join(root, 'packages/cortext-opencode/src/plugin.ts'), 'utf8');
  const line = src.slice(
    src.indexOf('const COMPACTION_POINTER'),
    src.indexOf(';', src.indexOf('const COMPACTION_POINTER'))
  );
  expect(line).not.toMatch(RETIRED);
});

it('the hook-ceiling truncation pointer names only what the cold-start renders', () => {
  const out = truncateToBudget(`${'x\n'.repeat(500)}`, 300);
  expect(out).not.toMatch(RETIRED);
  expect(out).toMatch(/cortext\/AgentRule/);
});
