// The four `createAgentAuth` call sites and what each does with `warning`.
//
// These SPAWN the entry files rather than inspecting their source. A grep for
// `process.stderr.write` would pass on a line that never executes, and would
// keep passing if stdout and stderr were later swapped — the two failure modes
// that matter here are both invisible to a source assertion. What is asserted
// is the wire: which STREAM carries the warning, and that the other stream
// stays exactly what the harness parses.
//
// The channel differs per caller deliberately, so it is asserted per caller:
//
//   cold-start      stdout, inline    injected context; once per session
//   inbox-stop      stderr            stdout is a JSON decision the harness parses
//   inbox-prompt    stderr            stdout is injected on EVERY prompt submit
//   audit           neither           threaded into auditAuthority as a check

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';

const run = promisify(execFile);
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// A configured-but-BROKEN credential: both env vars set, key file absent. This
// is the state the no-throw contract exists for — not "unconfigured", which is
// the supported anonymous mode and must stay silent.
const BROKEN = {
  SUBSTRATE_AGENT_KEY_PATH: '/nonexistent/agent.key',
  SUBSTRATE_AGENT_KEY_ID: 'k@h'
};

/** Spawn an entry with a scrubbed env, and never inherit the runner's identity. */
function spawnEntry(entry, env = {}, input = '') {
  const clean = { ...process.env };
  for (const k of [
    'SUBSTRATE_AGENT_KEY_PATH',
    'SUBSTRATE_AGENT_KEY_ID',
    'SUBSTRATE_URL',
    'SUBSTRATE_NAMESPACE'
  ]) {
    delete clean[k];
  }
  const child = run('node', [join(SRC, entry)], { env: { ...clean, ...env } });
  child.child.stdin.end(input);
  return child;
}

for (const [entry, input] of [
  ['inbox-stop-entry.js', '{}'],
  ['inbox-prompt-entry.js', '']
]) {
  test(`${entry} sends a broken-credential warning to STDERR, leaving stdout clean`, async () => {
    const { stdout, stderr } = await spawnEntry(entry, BROKEN, input);
    assert.match(stderr, /agent identity misconfigured/);
    assert.match(stderr, /nonexistent\/agent\.key/);
    // The whole point of the channel split. A warning on stdout is a parse
    // error for the stop hook and per-turn context noise for the prompt hook.
    assert.doesNotMatch(stdout, /misconfigured/);
    // And stdout must still be what the harness expects: nothing, or JSON.
    if (stdout.trim() !== '') JSON.parse(stdout);
  });

  test(`${entry} stays SILENT when no credential is configured`, async () => {
    // Unconfigured is the supported open mode, not a fault. Warning here would
    // train every operator without an identity to ignore the channel.
    const { stdout, stderr } = await spawnEntry(entry, {}, input);
    assert.doesNotMatch(stderr, /misconfigured/);
    assert.doesNotMatch(stdout, /misconfigured/);
  });
}

test('the cold-start keeps its INLINE treatment — stdout, not stderr', async () => {
  // Guards the over-correction. This hook's stdout IS the injected context, it
  // fires once per session, and the warning has to be where the agent reads.
  // Moving it to stderr to match the others would hide it from the only reader
  // that can act on it.
  const { stdout } = await spawnEntry('entry.js', BROKEN, '{}');
  assert.match(stdout, /agent identity misconfigured/);
});

test('a REAL key produces no warning on either stream, from any entry', async () => {
  // The discriminating half: a check that fires on a working credential is
  // noise, and this one runs at every session seam.
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'synoptic-hookwarn-'));
  const keyPath = join(dir, 'agent.key');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const env = { SUBSTRATE_AGENT_KEY_PATH: keyPath, SUBSTRATE_AGENT_KEY_ID: 'k@h' };
  for (const [entry, input] of [
    ['inbox-stop-entry.js', '{}'],
    ['inbox-prompt-entry.js', ''],
    ['entry.js', '{}']
  ]) {
    const { stdout, stderr } = await spawnEntry(entry, env, input);
    assert.doesNotMatch(stderr, /misconfigured/, entry);
    assert.doesNotMatch(stdout, /misconfigured/, entry);
  }
});
