import assert from 'node:assert/strict';
import { test } from 'vitest';
import { envWithLocalFallback, LOCAL_ENV_KEYS, readLocalEnv } from '../src/local-env.js';

const TARGET = '/repo';

function reader(files) {
  return (p) => (Object.hasOwn(files, p) ? files[p] : null);
}

const settingsPath = `${TARGET}/.claude/settings.local.json`;

function settingsFile(env) {
  return { [settingsPath]: JSON.stringify({ env }) };
}

// ---- overlay reading ----

test('no settings file means no overlay and no source', () => {
  const { env, source } = readLocalEnv({ targetDir: TARGET, readFile: reader({}) });
  assert.deepEqual(env, {});
  assert.equal(source, null);
});

test('unparsable settings means no overlay, never a throw', () => {
  const { env, source } = readLocalEnv({
    targetDir: TARGET,
    readFile: reader({ [settingsPath]: '{oops' })
  });
  assert.deepEqual(env, {});
  assert.equal(source, null);
});

test('only allowlisted SUBSTRATE_* string values are picked up', () => {
  const { env, source } = readLocalEnv({
    targetDir: TARGET,
    readFile: reader(
      settingsFile({
        SUBSTRATE_AGENT_KEY_ID: 'synoptic-claude@box',
        SUBSTRATE_AGENT_KEY_PATH: '/home/u/.config/substrate/keys/x.key',
        PATH: '/evil',
        SUBSTRATE_URL: 42,
        OTHER: 'yes'
      })
    )
  });
  assert.deepEqual(env, {
    SUBSTRATE_AGENT_KEY_ID: 'synoptic-claude@box',
    SUBSTRATE_AGENT_KEY_PATH: '/home/u/.config/substrate/keys/x.key'
  });
  assert.equal(source, settingsPath);
  for (const k of Object.keys(env)) assert.ok(LOCAL_ENV_KEYS.includes(k));
});

test('empty strings and non-object env blocks contribute nothing', () => {
  for (const block of [{ SUBSTRATE_AGENT_KEY_ID: '' }, null, [], 'x']) {
    const { env, source } = readLocalEnv({
      targetDir: TARGET,
      readFile: reader({ [settingsPath]: JSON.stringify({ env: block }) })
    });
    assert.deepEqual(env, {});
    assert.equal(source, null);
  }
});

// ---- merge precedence ----

test('process env always wins; the overlay fills only gaps', () => {
  const { env, filled } = envWithLocalFallback(
    { SUBSTRATE_AGENT_KEY_ID: 'shell@box', SUBSTRATE_URL: '' },
    {
      targetDir: TARGET,
      readFile: reader(
        settingsFile({
          SUBSTRATE_AGENT_KEY_ID: 'repo@box',
          SUBSTRATE_URL: 'https://x',
          SUBSTRATE_NAMESPACE: 'cortext'
        })
      )
    }
  );
  assert.equal(env.SUBSTRATE_AGENT_KEY_ID, 'shell@box');
  assert.equal(env.SUBSTRATE_URL, 'https://x');
  assert.equal(env.SUBSTRATE_NAMESPACE, 'cortext');
  assert.deepEqual([...filled].sort(), ['SUBSTRATE_NAMESPACE', 'SUBSTRATE_URL']);
});

test('no overlay passes the process env through untouched', () => {
  const proc = { SUBSTRATE_AGENT_KEY_ID: 'a@b' };
  const { env, source, filled } = envWithLocalFallback(proc, {
    targetDir: TARGET,
    readFile: reader({})
  });
  assert.equal(env, proc);
  assert.equal(source, null);
  assert.deepEqual(filled, []);
});
