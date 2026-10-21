import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderSessionBlock, sessionTag, shortSessionId } from '../src/session.js';

test('shortSessionId takes the leading entropy of a UUID', () => {
  assert.equal(shortSessionId('125f8d22-0044-4e28-8aec-a80be97df2d5'), '125f8d22');
});

test('shortSessionId handles a non-UUID id the same way rather than special-casing', () => {
  assert.equal(shortSessionId('abcdefghijklmnop'), 'abcdefgh');
});

test('shortSessionId is null for absent or blank input', () => {
  assert.equal(shortSessionId(null), null);
  assert.equal(shortSessionId(undefined), null);
  assert.equal(shortSessionId('   '), null);
});

test('sessionTag is the wire form', () => {
  assert.equal(sessionTag('125f8d22-0044-4e28-8aec-a80be97df2d5'), 'session:125f8d22');
  assert.equal(sessionTag(null), null);
});

test('renderSessionBlock names the kid, the session, and the tag to send', () => {
  const out = renderSessionBlock({
    sessionId: '125f8d22-0044-4e28-8aec-a80be97df2d5',
    kid: 'synoptic-claude@Desk'
  });
  assert.match(out, /## This session/);
  assert.match(out, /`synoptic-claude@Desk`, session `125f8d22`/);
  assert.match(out, /tags: \["session:125f8d22"\]/);
});

test('renderSessionBlock explains WHY the identity cannot discriminate', () => {
  // Without the reason this reads as ceremony, and ceremony gets skipped.
  const out = renderSessionBlock({ sessionId: 'aaaaaaaa-bbbb', kid: 'x@y' });
  assert.match(out, /no sender field/);
  assert.match(out, /derived from the signing key/);
});

test('renderSessionBlock carries the provenance convention, not just the stamp', () => {
  // The stamp is advisory; the content is what actually establishes provenance.
  const out = renderSessionBlock({ sessionId: 'aaaaaaaa-bbbb', kid: 'x@y' });
  assert.match(out, /say what you DID/);
  assert.match(out, /advisory/);
});

test('renderSessionBlock renders NOTHING without a session id', () => {
  // Instructing a stamp of a value the agent does not have would put a literal
  // `session:undefined` on the wire — worse than no stamp, because it looks
  // like a discriminator and discriminates nothing.
  assert.equal(renderSessionBlock({ sessionId: null, kid: 'x@y' }), '');
  assert.equal(renderSessionBlock({}), '');
});

test('renderSessionBlock degrades gracefully when the kid is unknown', () => {
  const out = renderSessionBlock({ sessionId: 'aaaaaaaa-bbbb', kid: null });
  assert.match(out, /this repo’s agent identity/);
  assert.match(out, /session `aaaaaaaa`/);
});

test('the block is small enough to sit above the fold', () => {
  // It competes for the same budget as everything else and it governs
  // writes, so it has to be read before the session starts writing.
  const out = renderSessionBlock({
    sessionId: '125f8d22-0044-4e28-8aec-a80be97df2d5',
    kid: 'synoptic-claude@Desk'
  });
  assert.ok(out.length < 1200, `session block is ${out.length} B`);
});
