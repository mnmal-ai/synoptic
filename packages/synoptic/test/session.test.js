import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderSessionBlock, shortSessionId } from '../src/session.js';

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

test('renderSessionBlock is one line naming the kid, the session and the instance stamp', () => {
  const out = renderSessionBlock({
    sessionId: '125f8d22-0044-4e28-8aec-a80be97df2d5',
    kid: 'synoptic-claude@Desk'
  });
  assert.equal(
    out,
    'Session `125f8d22` as `synoptic-claude@Desk` — stamp sends with `instance: "session:125f8d22"`.'
  );
  assert.ok(!out.includes('tags'));
});

test('renderSessionBlock renders NOTHING without a session id', () => {
  // A literal `session:undefined` stamp would look like a discriminator and discriminate nothing.
  assert.equal(renderSessionBlock({ sessionId: null, kid: 'x@y' }), '');
  assert.equal(renderSessionBlock({}), '');
});

test('renderSessionBlock degrades gracefully when the kid is unknown', () => {
  const out = renderSessionBlock({ sessionId: 'aaaaaaaa-bbbb', kid: null });
  assert.match(out, /this repo’s agent identity/);
  assert.match(out, /Session `aaaaaaaa`/);
});
