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
