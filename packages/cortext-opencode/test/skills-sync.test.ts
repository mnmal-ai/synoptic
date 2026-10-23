// The OpenCode skills are pointer bodies into the Substrate-held Skill rows —
// the same files the Claude skin ships. A fork here is right on the day
// it is written, with nothing to propagate the change.
// So this test asserts byte-identity with the source, not just invariants:
// any divergence must be a deliberate, reviewed edit to BOTH copies.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const OURS = join(HERE, '..', 'skills');
const SOURCE = join(HERE, '..', '..', 'cortext-plugin', 'skills');

function read(dir: string, name: string): string {
  return readFileSync(join(dir, name, 'SKILL.md'), 'utf8');
}

describe('opencode skills stay identical to the Claude skin source', () => {
  for (const name of ['council', 'todos']) {
    it(`${name}/SKILL.md is byte-identical`, () => {
      expect(read(OURS, name)).toBe(read(SOURCE, name));
    });
  }
});

describe('substrate-run shares its harness-neutral steps with the Claude skin', () => {
  // Steps 0 (binary and identity) and 6 (permissions) are per-harness; 1-5 are not.
  const steps = (dir: string) => {
    const text = read(dir, 'substrate-run');
    return text.slice(text.indexOf('## 1.'), text.indexOf('## 6.'));
  };
  it('steps 1-5 are byte-identical', () => {
    expect(steps(OURS).length).toBeGreaterThan(0);
    expect(steps(OURS)).toBe(steps(SOURCE));
  });
});
