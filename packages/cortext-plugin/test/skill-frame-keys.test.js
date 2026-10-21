// Shipped skills must not query a retired namespace.
//
// The retired `claude` namespace answers `unknown_namespace`. The bug is
// MASKED BY COMPETENCE: an agent with the conventions
// fragment in context knows the namespace is `cortext` and silently substitutes.
// So the bug bites hardest where there is least context — a freshly onboarded
// repo, or a session after compaction — and nobody with enough context to
// notice is ever affected by it.
//
// A hardcoded namespace in a file that ships to every consumer is the same
// class as a hardcoded type list: right on the day it was written, with nothing
// to propagate the change. This test is that propagation.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const SKILLS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills');

function skillFiles() {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, text: readFileSync(join(SKILLS, d.name, 'SKILL.md'), 'utf8') }));
}

test('every shipped skill has a SKILL.md', () => {
  const files = skillFiles();
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) expect(f.text.length).toBeGreaterThan(0);
});

test('no shipped skill opens a query frame against the retired `claude` namespace', () => {
  // Matches a frame KEY in query position — `{ "claude/Type"` — and
  // deliberately not a bare mention, so a file may still SHOW the retired key
  // inside an `errors` example while teaching the reader to recognise it.
  const framePattern = /\{\s*"claude\//;
  for (const { name, text } of skillFiles()) {
    expect(framePattern.test(text), `${name}/SKILL.md queries the retired namespace`).toBe(false);
  }
});

test('a skill that queries Substrate tells the reader to check `errors`', () => {
  // A skill that anticipates only "server unreachable" misses the case where
  // the server answers 200 and puts the reason in `errors`. Follow it literally and you read an empty `data` as "no
  // such row" and report the wrong cause.
  for (const { name, text } of skillFiles()) {
    if (!/query|\/substrate\/v1\/query|"cortext\//.test(text)) continue;
    expect(
      /errors/.test(text),
      `${name}/SKILL.md queries Substrate but never mentions errors`
    ).toBe(true);
  }
});

test('a skill that queries Substrate says the namespace is configurable', () => {
  for (const { name, text } of skillFiles()) {
    if (!/"cortext\//.test(text)) continue;
    expect(/SUBSTRATE_NAMESPACE/.test(text), `${name}/SKILL.md hardcodes the namespace`).toBe(true);
  }
});
