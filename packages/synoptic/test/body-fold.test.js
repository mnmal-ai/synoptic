import assert from 'node:assert/strict';
import { test } from 'vitest';
import { closeOpenFence, cutAtLineBoundary, flattenHeadings, foldBody } from '../src/body-fold.js';

// ---- flattenHeadings: stored content must not forge document structure ----

test('flattenHeadings: an ATX heading becomes bold, not a deeper heading', () => {
  // Demotion would keep it in the heading namespace and only move the
  // collision; bold removes it from that namespace entirely.
  const out = flattenHeadings('## The sharper framing');
  assert.equal(out, '**The sharper framing**');
  assert.ok(!out.includes('#'));
});

test('flattenHeadings: every level 1-6 is flattened', () => {
  for (let n = 1; n <= 6; n++) {
    assert.equal(flattenHeadings(`${'#'.repeat(n)} T`), '**T**');
  }
});

test('flattenHeadings: seven hashes is not a heading and is left alone', () => {
  assert.equal(flattenHeadings('####### not a heading'), '####### not a heading');
});

test('flattenHeadings: a hash without a following space is not a heading', () => {
  assert.equal(flattenHeadings('#hashtag'), '#hashtag');
});

test('flattenHeadings: headings inside a fenced block are preserved verbatim', () => {
  // In a fence these are comments or shell prompts, not structure — rewriting
  // them would corrupt a snippet the reader may copy and run.
  const src = ['# outside', '```bash', '# a shell comment', 'ls -la', '```', '## after'].join('\n');
  const out = flattenHeadings(src);
  assert.ok(out.includes('**outside**'));
  assert.ok(out.includes('# a shell comment'), 'in-fence comment must survive');
  assert.ok(out.includes('**after**'), 'flattening resumes after the fence closes');
});

test('flattenHeadings: tilde fences are honoured too', () => {
  const out = flattenHeadings(['~~~', '# kept', '~~~', '# flattened'].join('\n'));
  assert.ok(out.includes('# kept'));
  assert.ok(out.includes('**flattened**'));
});

test('flattenHeadings: an empty heading collapses rather than emitting ****', () => {
  assert.equal(flattenHeadings('## '), '');
});

test('flattenHeadings: null and undefined are empty, not a crash', () => {
  assert.equal(flattenHeadings(null), '');
  assert.equal(flattenHeadings(undefined), '');
});

// ---- cutAtLineBoundary ----

test('cutAtLineBoundary: text within budget is returned untouched with cut 0', () => {
  const r = cutAtLineBoundary('short', 100);
  assert.equal(r.text, 'short');
  assert.equal(r.cut, 0);
});

test('cutAtLineBoundary: prefers the last newline inside the budget', () => {
  const src = `${'a'.repeat(30)}\n${'b'.repeat(30)}\n${'c'.repeat(30)}`;
  const r = cutAtLineBoundary(src, 70);
  assert.ok(r.text.endsWith('b'.repeat(30)), 'cut lands on a line boundary');
  assert.ok(!r.text.includes('c'));
  assert.ok(r.cut > 0);
});

test('cutAtLineBoundary: a single over-long line is cut hard rather than collapsing', () => {
  // Honouring an early newline here would throw away almost the whole budget.
  const src = `x\n${'y'.repeat(500)}`;
  const r = cutAtLineBoundary(src, 100);
  assert.ok(r.text.length > 50, `kept ${r.text.length}, expected most of the budget`);
});

test('cutAtLineBoundary: reported cut plus kept length accounts for the whole input', () => {
  const src = 'z'.repeat(500);
  const r = cutAtLineBoundary(src, 100);
  assert.equal(r.text.length + r.cut, src.length);
});

// ---- closeOpenFence ----

test('closeOpenFence: an unterminated fence is closed', () => {
  const out = closeOpenFence('```js\nconst a = 1;');
  assert.ok(out.endsWith('```'));
});

test('closeOpenFence: balanced fences are left alone', () => {
  const src = '```\nx\n```';
  assert.equal(closeOpenFence(src), src);
});

// ---- foldBody: the two jobs together ----

test('foldBody: a short body passes through with headings flattened', () => {
  const out = foldBody('## Title\n\nsome prose');
  assert.equal(out, '**Title**\n\nsome prose');
  assert.ok(!out.includes('not shown'), 'nothing was cut, so nothing is announced');
});

test('foldBody: empty input renders nothing so the caller can skip the push', () => {
  assert.equal(foldBody(''), '');
  assert.equal(foldBody(null), '');
  assert.equal(foldBody('   \n  '), '');
});

test('foldBody: an over-budget body is cut AND says so', () => {
  // The marker is the point. A silent truncation reads as a complete body,
  // which mistakes absence for "nothing there".
  const out = foldBody('p'.repeat(5000), { limit: 500, name: 'some-memory' });
  assert.ok(out.length < 1200, `folded to ${out.length}`);
  assert.match(out, /TRUNCATED for cold-start budget, not ended/);
  assert.match(out, /more characters not shown/);
});

test('foldBody: the marker names the query that returns the rest', () => {
  const out = foldBody('q'.repeat(3000), { limit: 200, ns: 'cortext', name: 'my-name' });
  assert.match(out, /`cortext\/Memory` `my-name`/);
});

test('foldBody: without a name the marker still names the type', () => {
  const out = foldBody('q'.repeat(3000), { limit: 200, ns: 'cortext' });
  assert.match(out, /`cortext\/Memory`/);
  assert.ok(!out.includes('``` ``'), 'no dangling empty handle');
});

test('foldBody: the announced cut count matches what was actually removed', () => {
  const src = 'r'.repeat(4000);
  const out = foldBody(src, { limit: 1000 });
  const m = /([\d,]+) more characters not shown/.exec(out);
  assert.ok(m, 'marker present');
  const announced = Number(m[1].replace(/,/g, ''));
  const kept = out.slice(0, out.indexOf('\n\n>'));
  assert.equal(kept.length + announced, src.length);
});

test('foldBody: a cut inside a fenced block does not leave the fence open', () => {
  // An open fence swallows every following SECTION of the document into one
  // code block — a budget trim becoming a rendering failure for content that
  // was never truncated.
  const src = `intro\n\n\`\`\`js\n${'const x = 1;\n'.repeat(200)}`;
  const out = foldBody(src, { limit: 300 });
  const fences = (out.match(/^```/gm) ?? []).length;
  assert.equal(fences % 2, 0, `unbalanced fences in folded output:\n${out}`);
});

test('foldBody: limit 0 disables folding rather than emptying the body', () => {
  const src = 'kept in full';
  assert.equal(foldBody(src, { limit: 0 }), src);
});

test('foldBody: a body exactly at the limit is not marked as truncated', () => {
  const src = 's'.repeat(100);
  const out = foldBody(src, { limit: 100 });
  assert.equal(out, src);
});
