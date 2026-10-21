import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../src/cold-start-entry.js', import.meta.url));

// A cwd with no `.claude/settings.local.json` anywhere the entry looks (it
// reads exactly `<cwd>/.claude/settings.local.json`). Without this, the
// entry inherits the checkout's own settings when vitest launches from the
// repo root — which is the fallback working as designed, not an offline
// environment.
const BARE_DIR = mkdtempSync(join(tmpdir(), 'coldstart-bare-'));

function settingsDir(env) {
  const dir = mkdtempSync(join(tmpdir(), 'coldstart-settings-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ env }));
  return dir;
}

function runEntry({ stdin = '{}', env = {} } = {}) {
  const scrubbed = { ...process.env };
  for (const k of [
    'SUBSTRATE_URL',
    'SUBSTRATE_NAMESPACE',
    'SUBSTRATE_AGENT_KEY_PATH',
    'SUBSTRATE_AGENT_KEY_ID',
    'SYNOPTIC_PROJECT_SCOPE'
  ])
    delete scrubbed[k];
  // Spawned from a bare directory: the entry falls back to its own working
  // directory and resolves up to the repo root, so spawning from inside this
  // checkout would read its real settings and reach the live server.
  return spawnSync(process.execPath, [ENTRY], {
    cwd: BARE_DIR,
    input: stdin,
    env: { ...scrubbed, SYNOPTIC_HOST_REPORT: 'off', ...env },
    encoding: 'utf8',
    timeout: 30000
  });
}

describe('cold-start-entry (SessionStart executable)', () => {
  it('prints the offline note and exits 0 with no SUBSTRATE_URL', () => {
    const start = Date.now();
    const r = runEntry({ stdin: JSON.stringify({ cwd: BARE_DIR }) });
    // The 9s degrade timer must not hold the process open past its answer —
    // a lingered loser timer once pushed every run past vitest's 5s default.
    expect(Date.now() - start).toBeLessThan(8000);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SUBSTRATE_URL not set');
  });

  it('a session started in a subdirectory reads the repo root, not its own directory', () => {
    const root = settingsDir({ SUBSTRATE_URL: 'http://127.0.0.1:9' });
    mkdirSync(join(root, '.git'));
    const sub = join(root, 'apps', 'tool');
    mkdirSync(sub, { recursive: true });
    const r = runEntry({ stdin: JSON.stringify({ cwd: sub }) });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('SUBSTRATE_URL not set');
  });

  it('fills SUBSTRATE_URL repo-locally when the shell carries none', () => {
    // Unroutable localhost port: refused fast, so the run still exits
    // promptly while proving the URL came from settings, not the shell.
    const dir = settingsDir({ SUBSTRATE_URL: 'http://127.0.0.1:9' });
    const r = runEntry({ stdin: JSON.stringify({ cwd: dir }) });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('SUBSTRATE_URL not set');
  });

  it('reads cwd/session_id from hook stdin without failing', () => {
    const r = runEntry({
      stdin: JSON.stringify({ cwd: '/tmp', session_id: 'abc' })
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SUBSTRATE_URL not set');
  });

  it('never throws on malformed stdin', () => {
    const r = runEntry({ stdin: 'not json{{' });
    expect(r.status).toBe(0);
  });
});

// The overlay fills the env used for SIGNING; `agentKid` must come from the same
// overlay, not the raw `process.env.SUBSTRATE_AGENT_KEY_ID`, or a session whose
// identity lives only in settings.local.json signs correctly but never looks up
// its own AgentIdentity row, so no inbox and no kid. Pinned at the wire: the kid
// lookup must go out, for the kid the settings file names.
describe('both cold-start entries pass the repo-local kid through', () => {
  const ENTRIES = {
    'cold-start-entry.js': ENTRY,
    'entry.js (Claude bundle source)': fileURLToPath(new URL('../src/entry.js', import.meta.url))
  };

  async function kidLookups(entry) {
    const { createServer } = await import('node:http');
    const { spawn } = await import('node:child_process');
    const kids = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        if (req.url?.startsWith('/substrate/v1/query')) {
          try {
            const where = JSON.parse(body)['cortext/AgentIdentity']?.params?.where;
            if (where?.kid?.eq) kids.push(where.kid.eq);
          } catch {}
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":{}}');
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const dir = settingsDir({
      SUBSTRATE_URL: `http://127.0.0.1:${srv.address().port}`,
      SUBSTRATE_AGENT_KEY_ID: 'probe-claude@Box'
    });
    const scrubbed = { ...process.env };
    for (const k of [
      'SUBSTRATE_URL',
      'SUBSTRATE_NAMESPACE',
      'SUBSTRATE_AGENT_KEY_PATH',
      'SUBSTRATE_AGENT_KEY_ID'
    ])
      delete scrubbed[k];
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [entry], { cwd: dir, env: scrubbed });
      child.stdin.end(JSON.stringify({ cwd: dir, session_id: 's' }));
      child.on('exit', resolve);
    });
    await new Promise((r) => srv.close(r));
    return kids;
  }

  for (const [name, entry] of Object.entries(ENTRIES)) {
    it(`${name}: looks up the AgentIdentity for the settings kid`, async () => {
      expect(await kidLookups(entry)).toContain('probe-claude@Box');
    }, 30000);
  }
});
