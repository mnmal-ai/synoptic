// The three inbox entries read their settings from the REPO ROOT, the same as
// the cold-start, so a session started in a subdirectory signs as the repo's
// identity. The local-settings fallback reads exactly
// `<dir>/.claude/settings.local.json`, so a subdirectory would go anonymous.
//
// Observed through the broken-credential warning: it appears only when the
// root's settings were actually read, and every entry sends it to stderr.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';

const run = promisify(execFile);
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** A repo root whose settings name a configured-but-broken credential. */
function repoWithBrokenIdentity() {
  const root = mkdtempSync(join(tmpdir(), 'synoptic-inbox-root-'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, '.claude'));
  writeFileSync(
    join(root, '.claude', 'settings.local.json'),
    JSON.stringify({
      env: { SUBSTRATE_AGENT_KEY_PATH: '/nonexistent/agent.key', SUBSTRATE_AGENT_KEY_ID: 'k@h' }
    })
  );
  const sub = join(root, 'apps', 'tool');
  mkdirSync(sub, { recursive: true });
  return { root, sub };
}

function spawnFrom(entry, cwd, input, args = []) {
  const clean = { ...process.env };
  for (const k of [
    'SUBSTRATE_AGENT_KEY_PATH',
    'SUBSTRATE_AGENT_KEY_ID',
    'SUBSTRATE_URL',
    'SUBSTRATE_NAMESPACE'
  ]) {
    delete clean[k];
  }
  const child = run('node', [join(SRC, entry), ...args], { cwd, env: clean, timeout: 20000 });
  child.child.stdin.end(input);
  return child;
}

test('inbox-prompt-entry started in a subdirectory reads the repo root settings', async () => {
  const { sub } = repoWithBrokenIdentity();
  const { stderr } = await spawnFrom('inbox-prompt-entry.js', sub, '');
  assert.match(stderr, /agent identity misconfigured/);
});

test('inbox-stop-entry given a subdirectory cwd reads the repo root settings', async () => {
  const { sub } = repoWithBrokenIdentity();
  const { stderr } = await spawnFrom('inbox-stop-entry.js', sub, JSON.stringify({ cwd: sub }));
  assert.match(stderr, /agent identity misconfigured/);
});

test('inbox-watch-entry started in a subdirectory reads the repo root settings', async () => {
  const { sub } = repoWithBrokenIdentity();
  const { stderr } = await spawnFrom('inbox-watch-entry.js', sub, '');
  assert.match(stderr, /agent identity misconfigured/);
});
