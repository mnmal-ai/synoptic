import assert from 'node:assert/strict';
import { test } from 'vitest';
import { planCachePrune, renderPrunePlan } from '../src/cache-prune.js';
import { compareVersions as compare } from '../src/fragment-resolve.js';

const V8 = ['1.2.0', '1.2.1', '1.4.1', '1.5.0', '1.6.0', '1.7.0', '1.7.1', '1.9.0'];

test('the live eight-version case prunes to the keep budget', () => {
  const p = planCachePrune({
    versions: V8,
    installedVersion: '1.9.0',
    servedVersion: '1.9.0',
    compare
  });
  assert.equal(p.refusal, null);
  assert.equal(p.keep.length, 2);
  assert.equal(p.remove.length, 6);
  assert.ok(p.keep.includes('1.9.0'));
  assert.ok(p.keep.includes('1.7.1'), 'the rollback target is the NEWEST survivor');
});

test('the installed version is never removed', () => {
  const p = planCachePrune({
    versions: V8,
    installedVersion: '1.5.0',
    servedVersion: null,
    compare
  });
  assert.ok(!p.remove.includes('1.5.0'));
  assert.equal(p.protectedReason['1.5.0'], 'installed');
});

test('the SERVING version is never removed, even when it is not the installed one', () => {
  // Deleting the directory a running session is reading from turns a tidy-up
  // into an outage, because installed != serving.
  const p = planCachePrune({
    versions: V8,
    installedVersion: '1.9.0',
    servedVersion: '1.6.0',
    compare
  });
  assert.ok(!p.remove.includes('1.6.0'));
  assert.equal(p.protectedReason['1.6.0'], 'serving this session');
  assert.ok(!p.remove.includes('1.9.0'));
});

test('REFUSES when no installed version can be determined', () => {
  // No floor to protect. "Keep the highest N" would happily delete the version
  // in use on a box whose registry is unreadable.
  const p = planCachePrune({
    versions: V8,
    installedVersion: null,
    servedVersion: null,
    compare
  });
  assert.match(p.refusal, /no floor to protect/);
  assert.equal(p.remove.length, 0);
});

test('REFUSES when the installed version is absent from the cache', () => {
  const p = planCachePrune({
    versions: ['1.2.0', '1.5.0'],
    installedVersion: '1.9.0',
    servedVersion: null,
    compare
  });
  assert.match(p.refusal, /broken install, not a pruning opportunity/);
  assert.equal(p.remove.length, 0);
});

test('a cache already at or below the budget removes nothing', () => {
  const p = planCachePrune({
    versions: ['1.9.0', '1.7.1'],
    installedVersion: '1.9.0',
    servedVersion: '1.9.0',
    compare
  });
  assert.equal(p.remove.length, 0);
});

test('ordering is numeric, so 1.10.0 outranks 1.9.0 as the survivor', () => {
  const p = planCachePrune({
    versions: ['1.9.0', '1.10.0', '1.2.0'],
    installedVersion: '1.10.0',
    servedVersion: null,
    compare
  });
  assert.ok(p.keep.includes('1.10.0'));
  assert.ok(p.keep.includes('1.9.0'), 'lexical sort would have picked 1.2.0 here');
  assert.deepEqual(p.remove, ['1.2.0']);
});

test('after a version-line reset the rollback is the previous release, not the old line', () => {
  // The line went 2.16.0 -> 1.0.0-alpha.*, so the old line sorts ABOVE what is
  // installed. A rollback must sort below the installed version.
  const p = planCachePrune({
    versions: ['2.15.0', '2.16.0', '1.0.0-alpha.0', '1.0.0-alpha.1'],
    installedVersion: '1.0.0-alpha.1',
    servedVersion: null,
    compare
  });
  assert.deepEqual(p.keep, ['1.0.0-alpha.1', '1.0.0-alpha.0']);
  assert.equal(p.protectedReason['1.0.0-alpha.0'], 'rollback');
  assert.deepEqual(p.remove.sort(), ['2.15.0', '2.16.0']);
});

test('no version below the installed one means no rollback is kept', () => {
  const p = planCachePrune({
    versions: ['2.16.0', '1.0.0-alpha.0'],
    installedVersion: '1.0.0-alpha.0',
    servedVersion: null,
    compare
  });
  assert.deepEqual(p.keep, ['1.0.0-alpha.0']);
  assert.deepEqual(p.remove, ['2.16.0']);
});

test('a non-version directory name is a prune candidate', () => {
  // The resolver cannot deliberately choose something that is not a version.
  const p = planCachePrune({
    versions: ['1.10.0', '1.9.0', 'scratch'],
    installedVersion: '1.10.0',
    servedVersion: null,
    compare
  });
  assert.ok(p.remove.includes('scratch'));
});

test('keep: 1 retains only the installed version', () => {
  const p = planCachePrune({
    versions: V8,
    installedVersion: '1.9.0',
    servedVersion: null,
    keep: 1,
    compare
  });
  assert.deepEqual(p.keep, ['1.9.0']);
});

test('protecting the served version can exceed the keep budget rather than drop it', () => {
  const p = planCachePrune({
    versions: V8,
    installedVersion: '1.9.0',
    servedVersion: '1.2.0',
    keep: 1,
    compare
  });
  assert.ok(p.keep.includes('1.2.0'));
  assert.ok(p.keep.includes('1.9.0'));
});

test('render: a dry run says "would" and never "DELETE"', () => {
  const p = planCachePrune({
    versions: V8,
    installedVersion: '1.9.0',
    servedVersion: '1.9.0',
    compare
  });
  const out = renderPrunePlan(p, { apply: false });
  assert.match(out, /would {3}1\.2\.0/);
  assert.ok(!out.includes('DELETE'));
  assert.match(out, /Re-run with --apply/);
});

test('render: a refusal states plainly that nothing was deleted', () => {
  const p = planCachePrune({
    versions: V8,
    installedVersion: null,
    servedVersion: null,
    compare
  });
  const out = renderPrunePlan(p, { apply: true });
  assert.match(out, /REFUSED/);
  assert.match(out, /Nothing was deleted/);
});

test('render: keeps are labelled with WHY they were kept', () => {
  const p = planCachePrune({
    versions: V8,
    installedVersion: '1.9.0',
    servedVersion: '1.6.0',
    compare
  });
  const out = renderPrunePlan(p, { apply: false });
  assert.match(out, /KEEP {4}1\.9\.0 {6}\(installed\)/);
  assert.match(out, /KEEP {4}1\.6\.0 {6}\(serving this session\)/);
});
