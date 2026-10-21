// Every declared `bin` entry must at least LOAD.
//
// The unit tests exercise `onboard()` and friends directly, so a bin file
// whose own import fails (say, of a `../src/` this package does not have)
// would leave the logic covered and the only door onto it shut.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const entries = Object.entries(pkg.bin ?? {});

test('the package declares at least one bin entry', () => {
  expect(entries.length).toBeGreaterThan(0);
});

test.each(entries)('bin entry %s exists on disk', (_name, rel) => {
  expect(existsSync(join(ROOT, rel)), `${rel} is declared in package.json but absent`).toBe(true);
});

test.each(entries)('bin entry %s loads without throwing', (_name, rel) => {
  // Run it with no arguments in a child process. Every bin here either prints
  // usage and exits non-zero, or does its dry-run — both are FINE. What is not
  // fine is a module-resolution or syntax error, which is what this catches.
  let stderr = '';
  try {
    execFileSync(process.execPath, [join(ROOT, rel)], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    stderr = String(err?.stderr ?? '');
  }
  expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError/);
});

test('hooks/inbox-watch.mjs with no identity emits one disabled line and exits 0', () => {
  // Runs on a Linux pipe, where writes are synchronous, so this cannot by itself
  // prove the flush-before-exit behaviour.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(SUBSTRATE|SYNOPTIC)_/.test(k)) delete env[k];
  const cwd = mkdtempSync(join(tmpdir(), 'inbox-watch-'));
  const out = execFileSync(
    process.execPath,
    [join(ROOT, 'hooks/inbox-watch.mjs'), '--since', '2026-01-01T00:00:00Z'],
    { cwd, env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const lines = out.split('\n').filter(Boolean);
  expect(lines).toHaveLength(1);
  expect(out.endsWith('\n')).toBe(true);
  expect(JSON.parse(lines[0])).toEqual({
    type: 'status',
    state: 'disabled',
    reason: 'no SUBSTRATE_URL or SUBSTRATE_AGENT_KEY_ID'
  });
});
