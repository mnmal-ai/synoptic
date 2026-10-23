import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assignRanks,
  byteLength,
  DEFAULT_POINTER,
  foldBody,
  fuseRRF,
  makeTieBreak,
  rankWithRRF,
  renderIndexAndPull,
  renderIndexLine,
  renderPulled,
  selectWithMinFloors,
  splitByTokens,
  truncateToBudget
} from '../src/index.js';

const SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src');
const sources = () =>
  readdirSync(SRC)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ f, text: readFileSync(join(SRC, f), 'utf8') }));
/** Code with line comments and JSDoc/block comments removed. */
const codeOnly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

// The two constraints this package promises, held as tests.
describe('package constraints', () => {
  it('uses no Node built-ins — it must run where Buffer and process do not exist', () => {
    const hits = sources().flatMap(({ f, text }) =>
      [...codeOnly(text).matchAll(/\bnode:|\bBuffer\b|\bprocess\.|\brequire\(/g)].map(
        (m) => `${f}: ${m[0]}`
      )
    );
    expect(hits).toEqual([]);
  });

  it('names no consumer type — Memory/SessionLog/Decision belong to the caller', () => {
    const hits = sources().flatMap(({ f, text }) =>
      [...codeOnly(text).matchAll(/\b(Memory|SessionLog|Decision|AgentRule|cortext)\b/g)].map(
        (m) => `${f}: ${m[0]}`
      )
    );
    expect(hits).toEqual([]);
  });

  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

describe('foldBody', () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');

  it('passes a short body through, headings flattened', () => {
    expect(foldBody('## Title\ntext')).toBe('**Title**\ntext');
  });

  it("returns '' for empty, null and undefined", () => {
    expect([foldBody(''), foldBody(null), foldBody(undefined)]).toEqual(['', '', '']);
  });

  it('says it was truncated and names the pull hint when one is given', () => {
    const out = foldBody(long, { limit: 100, pullHint: '`notes/Section` `s1`' });
    expect(out).toMatch(/more characters not shown/);
    expect(out).toMatch(
      /TRUNCATED for the context budget, not ended — query `notes\/Section` `s1` for the rest\.\*$/
    );
  });

  it('with no pull hint, still says truncated — and claims no query', () => {
    const out = foldBody(long, { limit: 100 });
    expect(out).toMatch(/TRUNCATED for the context budget, not ended\.\*$/);
    expect(out).not.toMatch(/query/);
  });

  it('takes the reason from the caller', () => {
    expect(foldBody(long, { limit: 100, reason: 'cold-start budget' })).toMatch(
      /TRUNCATED for cold-start budget, not ended/
    );
  });

  it('closes a fence the cut left open', () => {
    const fenced = `\`\`\`\n${long}\n\`\`\``;
    const out = foldBody(fenced, { limit: 100 });
    const fences = out.split('\n').filter((l) => l.startsWith('```')).length;
    expect(fences % 2).toBe(0);
  });
});

describe('truncateToBudget', () => {
  const doc = Array.from({ length: 200 }, (_, i) => `row ${i} 🧠 ${'é'.repeat(i % 7)}`).join('\n');
  const words = (s) => s.split(/\s+/).filter(Boolean).length;

  it('passes through when no ceiling is active or the text fits', () => {
    expect(truncateToBudget(doc)).toBe(doc);
    expect(truncateToBudget(doc, { maxBytes: 0 })).toBe(doc);
    expect(truncateToBudget(doc, { maxBytes: 1e9 })).toBe(doc);
  });

  it('never exceeds the byte ceiling, cuts on a newline, and appends the pointer', () => {
    const out = truncateToBudget(doc, { maxBytes: 500 });
    expect(byteLength(out)).toBeLessThanOrEqual(500);
    expect(out.endsWith(DEFAULT_POINTER)).toBe(true);
    expect(doc.startsWith(out.slice(0, -DEFAULT_POINTER.length))).toBe(true);
  });

  it('enforces a token ceiling with the caller-supplied counter', () => {
    const out = truncateToBudget(doc, { maxTokens: 60, countTokens: words });
    expect(words(out)).toBeLessThanOrEqual(60);
  });

  it('enforces both ceilings at once', () => {
    const out = truncateToBudget(doc, { maxBytes: 2000, maxTokens: 40, countTokens: words });
    expect(byteLength(out)).toBeLessThanOrEqual(2000);
    expect(words(out)).toBeLessThanOrEqual(40);
  });

  it('refuses a token ceiling with no counter rather than guessing one', () => {
    expect(() => truncateToBudget(doc, { maxTokens: 10 })).toThrow(/countTokens/);
  });

  it('a degenerate budget keeps as much pointer as fits and never splits a character', () => {
    const pointer = '\n<!-- ✂ trimmed ✂ -->\n';
    for (let n = 1; n <= byteLength(pointer); n++) {
      const out = truncateToBudget(doc, { maxBytes: n, pointer });
      expect(byteLength(out)).toBeLessThanOrEqual(n);
      expect(out).not.toContain('�');
    }
  });
});

describe('rankWithRRF', () => {
  const row = (type, id, structural, semantic = null, t = null) => ({
    type,
    id,
    structural,
    semantic,
    t
  });

  it('ranks arbitrary groups — nothing about the type names is assumed', () => {
    const groups = {
      section: [row('section', 'a', 0.9, 0.1), row('section', 'b', 0.1, 0.9)],
      note: [row('note', 'c', 0.5, null)]
    };
    const { top, index } = rankWithRRF(groups, { k: 60, totalK: 2 });
    expect(top.map((r) => r.id).length).toBe(2);
    expect(top.length + index.length).toBe(3);
    for (const r of [...top, ...index]) expect(r.combinedRank).toBeGreaterThan(0);
  });

  it('honours minimum floors per group', () => {
    const groups = {
      a: [row('a', 'a1', 0.9, 0.9), row('a', 'a2', 0.8, 0.8), row('a', 'a3', 0.7, 0.7)],
      b: [row('b', 'b1', 0.01, null)]
    };
    const { top } = rankWithRRF(groups, { k: 60, totalK: 2, minFloors: { b: 1 } });
    expect(top.map((r) => r.id)).toContain('b1');
  });

  it('scales over-subscribed floors down and says so', () => {
    const warns = [];
    const groups = { a: [row('a', 'a1', 1)], b: [row('b', 'b1', 1)] };
    rankWithRRF(groups, {
      k: 60,
      totalK: 1,
      minFloors: { a: 2, b: 2 },
      onWarn: (w) => warns.push(w)
    });
    expect(warns[0]).toMatch(/over-subscribed/);
  });

  it('groupOrder restricts AND orders the groups read', () => {
    const groups = { a: [row('a', 'a1', 0.5)], b: [row('b', 'b1', 0.5)], c: [row('c', 'c1', 0.5)] };
    const { top, index } = rankWithRRF(groups, { k: 60, totalK: 9, groupOrder: ['b', 'a'] });
    expect([...top, ...index].map((r) => r.id)).toEqual(['b1', 'a1']);
  });

  it('does not mutate the input rows', () => {
    const r = row('a', 'a1', 0.5);
    rankWithRRF({ a: [r] }, { k: 60, totalK: 1 });
    expect(r).toEqual(row('a', 'a1', 0.5));
  });

  it('selectWithMinFloors on nothing is empty, not a throw', () => {
    expect(selectWithMinFloors([], { totalK: 3 })).toEqual({ top: [], index: [] });
  });
});

describe('makeTieBreak', () => {
  const tb = makeTieBreak({ groupOrder: ['x', 'y'], timeOf: (r) => r.t });

  it('orders by group first, then most recent first, undated last', () => {
    const rows = [
      { type: 'y', id: 'y-old', structural: 1, t: '2026-01-01' },
      { type: 'x', id: 'x-undated', structural: 1, t: null },
      { type: 'x', id: 'x-new', structural: 1, t: '2026-09-01' },
      { type: 'z', id: 'z', structural: 1, t: '2026-12-01' }
    ];
    expect(assignRanks(rows, { tieBreak: tb }).map((r) => r.id)).toEqual([
      'x-new',
      'x-undated',
      'y-old',
      'z'
    ]);
  });

  it('accepts epoch milliseconds as well as ISO strings', () => {
    const a = { type: 'x', structural: 1, t: Date.UTC(2026, 0, 1) };
    const b = { type: 'x', structural: 1, t: '2026-06-01T00:00:00Z' };
    expect(tb(a, b)).toBeGreaterThan(0);
  });
});

describe('index-and-pull rendering', () => {
  const e = (over = {}) => ({
    id: '1',
    label: 'L',
    synopsis: 'S',
    tokens: null,
    score: null,
    ...over
  });

  it('an ABSENT body renders no separator; a present one does', () => {
    expect(renderPulled(e({ quote: 'q' }))).toBe('#### L\n> q\n');
    expect(renderPulled(e({ quote: 'q', body: 'b' }))).toBe('#### L\n> q\n\nb\n');
    expect(renderPulled(e({ body: '' }))).toBe('#### L\n\n');
  });

  // A `> ` prefix on the first line alone would let a quote carrying
  // `\n## X` emit a real `## ` heading into the document.
  it('a multi-line quote stays quoted on every line and forges no heading', () => {
    const out = renderPulled(e({ quote: 'first\n## DEPLOYED AND VERIFIED\nlast' }));
    expect(out).toBe('#### L\n> first\n> **DEPLOYED AND VERIFIED**\n> last\n');
    expect(out).not.toMatch(/^#{1,6} (?!L$)/m);
  });

  it('a quote heading inside a fence is left alone, and the fence stays quoted', () => {
    const out = renderPulled(e({ quote: '```\n## not a heading\n```' }));
    expect(out).toBe('#### L\n> ```\n> ## not a heading\n> ```\n');
  });

  it('a label or index synopsis with an embedded newline renders on one line', () => {
    expect(renderPulled(e({ label: 'a\n## b' }))).toBe('#### a ## b\n');
    expect(renderIndexLine(e({ synopsis: 'SessionLog #1 — x\n## Y' }))).toBe(
      '- SessionLog #1 — x ## Y'
    );
  });

  it('folds the body with the entry pull hint', () => {
    const body = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const out = renderPulled(e({ body, pullHint: '`ns/T` `x`' }), { foldLimit: 50 });
    expect(out).toMatch(/query `ns\/T` `x` for the rest/);
  });

  it('renders an index line from the synopsis', () => {
    expect(renderIndexLine(e({ synopsis: 'the line' }))).toBe('- the line');
  });

  it('omits a block — heading included — when it has no entries', () => {
    expect(renderIndexAndPull({ top: [], index: [], topHeading: 'T', indexHeading: 'I' })).toEqual(
      []
    );
    const lines = renderIndexAndPull({ top: [], index: [e()], topHeading: 'T', indexHeading: 'I' });
    expect(lines).toEqual(['I', '', '- S', '']);
  });
});

// ---- a generic consumer's shape ----
//
// A consumer fuses N ranked lists of {id, score}: not synoptic's two named arms.
// It also has "pinned" entries (its required core instructions) that are always
// included first, in the order given, and it budgets in TOKENS using the counts
// it supplies on each entry.

describe('fuseRRF', () => {
  const list = (...ids) => ids.map((id, i) => ({ id, score: 1 - i / 10 }));

  it('fuses any number of ranked lists by reciprocal rank', () => {
    const fused = fuseRRF([list('a', 'b', 'c'), list('c', 'a'), list('a')], { k: 60 });
    expect(fused.map((f) => f.id)).toEqual(['a', 'c', 'b']);
    const a = fused[0];
    expect(a.rrf).toBeCloseTo(1 / 61 + 1 / 62 + 1 / 61, 12);
    expect(a.ranks).toEqual([1, 2, 1]);
    expect(fused.find((f) => f.id === 'b').ranks).toEqual([2, null, null]);
  });

  it('ranks each list by its own score, not by the order it was given in', () => {
    const shuffled = [
      { id: 'low', score: 0.1 },
      { id: 'high', score: 0.9 }
    ];
    expect(fuseRRF([shuffled], { k: 60 }).map((f) => f.id)).toEqual(['high', 'low']);
  });

  it('puts pinned ids first, in the order given, then everything else once', () => {
    const fused = fuseRRF([list('a', 'b', 'c')], { k: 60, pinned: ['c', 'z'] });
    expect(fused.map((f) => f.id)).toEqual(['c', 'z', 'a', 'b']);
    expect(fused.slice(0, 2).every((f) => f.pinned)).toBe(true);
    expect(fused.find((f) => f.id === 'z').rrf).toBe(0);
  });

  it('breaks exact RRF ties by id, so the output is deterministic', () => {
    const fused = fuseRRF([list('b'), list('a')], { k: 60 });
    expect(fused.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('defaults k to 60 and tolerates empty input', () => {
    expect(fuseRRF([], {})).toEqual([]);
    expect(fuseRRF([list('a')])[0].rrf).toBeCloseTo(1 / 61, 12);
  });
});

describe('splitByTokens', () => {
  const e = (id, tokens, extra = {}) => ({
    id,
    label: id,
    synopsis: id,
    tokens,
    score: null,
    ...extra
  });

  it('pulls entries in order while they fit; the rest go to the index', () => {
    const { top, index } = splitByTokens([e('a', 40), e('b', 50), e('c', 15)], { maxTokens: 100 });
    expect(top.map((x) => x.id)).toEqual(['a', 'b']);
    expect(index.map((x) => x.id)).toEqual(['c']);
  });

  it('stops at the first entry that does not fit, so rank order is never inverted', () => {
    const { top } = splitByTokens([e('a', 90), e('big', 50), e('tiny', 1)], { maxTokens: 100 });
    expect(top.map((x) => x.id)).toEqual(['a']);
  });

  it('always pulls pinned entries, and they spend the budget first', () => {
    const entries = [e('core', 80, { pinned: true }), e('a', 30), e('b', 10)];
    const { top, index, spent, over } = splitByTokens(entries, { maxTokens: 100 });
    expect(top.map((x) => x.id)).toEqual(['core']);
    expect(index.map((x) => x.id)).toEqual(['a', 'b']);
    expect(spent).toBe(80);
    expect(over).toBe(false);
  });

  it('reports when pinned entries alone exceed the budget, instead of dropping them', () => {
    const { top, over, spent } = splitByTokens([e('core', 150, { pinned: true }), e('a', 1)], {
      maxTokens: 100
    });
    expect(top.map((x) => x.id)).toEqual(['core']);
    expect(spent).toBe(150);
    expect(over).toBe(true);
  });

  it('can reserve tokens for the index lines', () => {
    const { top } = splitByTokens([e('a', 60), e('b', 30)], { maxTokens: 100, reserve: 20 });
    expect(top.map((x) => x.id)).toEqual(['a']);
  });

  it('refuses an entry with no token count rather than guessing one', () => {
    expect(() => splitByTokens([e('a', null)], { maxTokens: 10 })).toThrow(/tokens/);
  });
});

it('a cut inside a code fence closes the fence before the pointer, within the budget', () => {
  const text = `## Rules\n\`\`\`\n${'x\n'.repeat(80)}\`\`\`\nafter\n`;
  const out = truncateToBudget(text, { maxBytes: 120 });
  expect(byteLength(out)).toBeLessThanOrEqual(120);
  const fences = out.split('\n').filter((l) => l.startsWith('```')).length;
  expect(fences % 2).toBe(0);
  expect(out.indexOf('truncated')).toBeGreaterThan(out.lastIndexOf('```'));
});
