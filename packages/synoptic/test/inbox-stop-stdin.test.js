// The Stop hook must read stop_hook_active even when the harness is slow to
// write stdin; losing it re-blocks every stop while mail is unread.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, test } from 'vitest';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'inbox-stop-entry.js');
let server;
let url;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const data = {};
      for (const key of Object.keys(JSON.parse(body || '{}'))) {
        if (key.endsWith('/AgentIdentity')) data[key] = [{ id: 'me-row' }];
        if (key.endsWith('/AgentMessage'))
          data[key] = [
            {
              id: 'uuid-7',
              shortId: '7',
              subject: 'hello',
              body: 'b',
              _metadata: {
                createdAt: '2026-10-23T00:00:00Z',
                createdBy: { kind: 'agent', id: 'peer@h' }
              }
            }
          ];
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

function runStop(payload, delayMs) {
  const cwd = mkdtempSync(join(tmpdir(), 'synoptic-stop-'));
  mkdirSync(join(cwd, '.git'));
  const env = { ...process.env, SUBSTRATE_URL: url, SUBSTRATE_AGENT_KEY_ID: 'me@h' };
  delete env.SUBSTRATE_AGENT_KEY_PATH;
  const child = spawn('node', [ENTRY], { cwd, env });
  let out = '';
  child.stdout.on('data', (c) => {
    out += c;
  });
  setTimeout(() => child.stdin.end(JSON.stringify({ cwd, ...payload })), delayMs);
  return new Promise((resolve) => child.on('close', () => resolve(out)));
}

test('unread mail blocks a first stop', async () => {
  const out = await runStop({ hook_event_name: 'Stop', stop_hook_active: false }, 0);
  assert.equal(JSON.parse(out).decision, 'block');
});

test('a payload written late still carries stop_hook_active, so the stop is allowed', async () => {
  const out = await runStop({ hook_event_name: 'Stop', stop_hook_active: true }, 400);
  assert.equal(out, '');
});

test('a payload with no event name is not trusted: the stop is allowed', async () => {
  const out = await runStop({ stop_hook_active: false }, 0);
  assert.equal(out, '');
});
