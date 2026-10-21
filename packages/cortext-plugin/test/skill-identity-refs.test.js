// A shipped skill must never hand an identity variable a `:-` default.
//
// A template such as `${SUBSTRATE_AGENT_KEY_PATH:-}` looks harmless, but an
// EMPTY signing key is exactly the value
// `makeAgentJwtProvider` treats as unconfigured — it returns `() => null`, the
// client sends no `Authorization`, and the repo writes ANONYMOUSLY while
// looking configured.
//
// WHY A TEST AND NOT CAREFUL PROSE. The bare `${VAR}` form fails loudly only
// because an unexpandable ref is passed through LITERALLY, so the substrate binary
// refuses on the literal path. That guarantee lives in the binary, not in
// Claude Code, and a single `:-` anywhere converts it back into a silent
// anonymous write. It is one character of edit away at all times, and the
// failure it produces is invisible by construction — the repo keeps working,
// just as somebody else.
//
// Same class as skill-frame-keys.test.js: a value hardcoded into a file
// that ships to every consumer, right on the day it was written, with nothing
// to propagate the change. This test is that propagation.
//
// Scoped to IDENTITY vars deliberately. A `:-` default on a cosmetic knob is
// fine; these two are the ones whose empty value is indistinguishable from
// "not configured" to the thing that consumes them.
//
// Scoped to FENCED CODE BLOCKS: prose may quote the bad form to warn about
// it. The hazard is the template — the thing an operator copies — not a sentence warning about it.
// A check that cannot tell those apart would push the next author to delete
// the warning rather than the defect.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const SKILLS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills');

const IDENTITY_VARS = ['SUBSTRATE_AGENT_KEY_PATH', 'SUBSTRATE_AGENT_KEY_ID'];

function skillFiles() {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, text: readFileSync(join(SKILLS, d.name, 'SKILL.md'), 'utf8') }));
}

/**
 * Only the fenced blocks — what an operator copies, rather than prose about it.
 *
 * The leading-whitespace allowance is not cosmetic. The FIRST version anchored
 * the fence at column 0, and the one template that actually mattered sits
 * indented inside a numbered list item — so the guard read the document,
 * matched nothing, and reported green on a file carrying the exact defect.
 * A mutation test is the only reason that is not still true.
 */
function codeBlocks(text) {
  return [...text.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)].map((m) => m[1]);
}

test('no shipped skill gives an identity variable a `:-` default', () => {
  const offenders = [];
  for (const { name, text } of skillFiles()) {
    for (const block of codeBlocks(text)) {
      for (const v of IDENTITY_VARS) {
        // `${VAR:-anything}` — including `${VAR:-}`, the empty default, which
        // is the harmful one precisely because it looks like it means "unset".
        const withDefault = new RegExp(`\\$\\{${v}:-[^}]*\\}`, 'g');
        for (const hit of block.matchAll(withDefault)) {
          offenders.push(`${name}/SKILL.md: ${hit[0]}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: the title names the literal `${VAR}` syntax under test
test('substrate-setup does not claim `${VAR}` expansion reads settings files', () => {
  // Claude Code does NOT expand a server's `${VAR}` refs against
  // `.claude/settings.local.json` — expansion reads only the shell `claude` was
  // launched with. Settings env IS inherited by the server at spawn (measured
  // on Claude Code 2.1.286). The skill relies on inheritance and forbids
  // expansion, so the guard is on EXPANSION claims only.
  //
  // Asserted as an absence because the claim is what misleads: any sentence
  // pairing settings.local.json with ${VAR} expansion is the defect returning,
  // unless it is saying expansion does NOT read it.
  const text = readFileSync(join(SKILLS, 'substrate-setup', 'SKILL.md'), 'utf8');
  const sentences = text.split(/(?<=\.)\s+/);
  const claims = sentences.filter(
    (s) =>
      s.includes('settings.local.json') &&
      /\$\{|expand/i.test(s) &&
      !/does \*\*not\*\*|not propagate|\bnever\b|\bliteral|nothing else|\bNOT\b/i.test(s)
  );
  expect(claims).toEqual([]);
});
