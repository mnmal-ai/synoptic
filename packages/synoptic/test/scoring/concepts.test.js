import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderConcepts } from '../../src/scoring/concepts.js';

test('renderConcepts: empty list → no section emitted', () => {
  assert.equal(renderConcepts([]), '');
});

test('renderConcepts: groups by kind, alphabetical within kind', () => {
  const rows = [
    { name: 'AnchorIntent', description: 'topical anchor', kind: 'type' },
    { name: 'cold-start', description: 'session boot protocol', kind: 'protocol' },
    { name: 'Decision', description: 'architectural choice', kind: 'type' }
  ];
  const out = renderConcepts(rows);
  assert.match(out, /## Concepts \(operational semantics — 3 total\)/);
  assert.match(out, /### type/);
  assert.match(out, /### protocol/);
  // Within `type`, alphabetical: AnchorIntent before Decision.
  const typeIdx = out.indexOf('### type');
  const protoIdx = out.indexOf('### protocol');
  const anchorIdx = out.indexOf('AnchorIntent');
  const decisionIdx = out.indexOf('Decision');
  assert.ok(typeIdx < anchorIdx);
  assert.ok(anchorIdx < decisionIdx);
  assert.ok(decisionIdx < protoIdx); // type group ends before protocol begins
});

test('renderConcepts: each row shows description as a > blockquote', () => {
  const rows = [{ name: 'X', description: 'one-liner about X', kind: 'pattern' }];
  const out = renderConcepts(rows);
  assert.match(out, /\*\*X\*\*/);
  assert.match(out, /> one-liner about X/);
});

test('renderConcepts: omits archived rows defensively (caller should pre-filter, but be safe)', () => {
  const rows = [
    { name: 'Y', description: 'live', kind: 'role', archived: false },
    { name: 'Z', description: 'gone', kind: 'role', archived: true }
  ];
  const out = renderConcepts(rows);
  assert.match(out, /\*\*Y\*\*/);
  assert.doesNotMatch(out, /\*\*Z\*\*/);
});
