import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, gitTracks, loadConfig, mcpInvocation } from '../src/config.js';
import { handleHook } from '../src/hook.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function workspace(env = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'cortext-codex-test-'));
  spawnSync('git', ['init', '-q', cwd], { stdio: 'ignore' });
  mkdirSync(join(cwd, '.codex'));
  const key = join(cwd, 'test.key');
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(
    join(cwd, '.codex/cortext.local.json'),
    JSON.stringify({
      env: {
        SUBSTRATE_AGENT_KEY_ID: 'test-codex@Box',
        SUBSTRATE_AGENT_KEY_PATH: key,
        ...env
      }
    })
  );
  return cwd;
}

function isolatedEnv(extra = {}) {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...extra }).filter(
      ([key]) =>
        !key.startsWith('SUBSTRATE_') && !key.startsWith('SYNOPTIC_') && !key.startsWith('MEMORY_')
    )
  );
}

async function fixture(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, payload, authorization: req.headers.authorization });
    const data = Object.fromEntries(Object.keys(payload).map((key) => [key, []]));
    if ('cortext/AgentIdentity' in payload) data['cortext/AgentIdentity'] = [{ id: 'codex-id' }];
    if ('cortext/AgentMessage' in payload)
      data['cortext/AgentMessage'] = [
        {
          id: 'message-1',
          shortId: 42,
          subject: 'Review the pinned spec',
          body: 'Check the retry boundary.',
          _metadata: { createdBy: { id: 'peer-key' }, createdAt: '2026-10-10T12:00:00Z' }
        }
      ];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

function runArtifact(path, cwd, input, env = isolatedEnv()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, path)], { cwd, env, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('Codex config resolves the repo root and does not inherit Claude identity', () => {
  const cwd = workspace();
  mkdirSync(join(cwd, 'sub'));
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(
    join(cwd, '.claude/settings.local.json'),
    JSON.stringify({
      env: {
        SUBSTRATE_AGENT_KEY_ID: 'claude-key',
        SUBSTRATE_URL: 'https://should-never-be-used.invalid'
      }
    })
  );
  const config = loadConfig(join(cwd, 'sub'), {});
  assert.equal(config.cwd, cwd);
  assert.equal(config.env.SUBSTRATE_AGENT_KEY_ID, 'test-codex@Box');
  assert.equal(config.env.SUBSTRATE_URL, undefined);
  const partial = loadConfig(cwd, { SUBSTRATE_AGENT_KEY_ID: 'explicit-process-kid' });
  assert.equal(partial.env.SUBSTRATE_AGENT_KEY_PATH, undefined);
  const otherPartial = loadConfig(cwd, { SUBSTRATE_AGENT_KEY_PATH: '/tmp/process-key' });
  assert.equal(otherPartial.env.SUBSTRATE_AGENT_KEY_ID, undefined);
});

test('config restricts settings to context keys and respects explicit process values', () => {
  const cwd = workspace({
    PATH: '/bad',
    NODE_OPTIONS: '--bad',
    SUBSTRATE_URL: 'http://settings',
    MEMORY_K: '8'
  });
  const { env } = loadConfig(cwd, { PATH: '/good', SUBSTRATE_URL: '' });
  assert.equal(env.PATH, '/good');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.SUBSTRATE_URL, '');
  assert.equal(env.MEMORY_K, undefined);
  writeFileSync(join(cwd, '.codex/cortext.local.json'), '{malformed');
  assert.throws(() => loadConfig(cwd, {}), /Invalid/);
});

test('SessionStart uses the shared renderer, injects conventions and makes signed Codex reads', async (t) => {
  const { requests, url } = await fixture(t);
  const cwd = workspace({ SUBSTRATE_URL: url });
  const result = await runArtifact(
    'hooks/cortext.mjs',
    cwd,
    JSON.stringify({
      hook_event_name: 'SessionStart',
      cwd,
      session_id: 'test-session',
      source: 'startup'
    })
  );
  assert.equal(result.code, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Conventions/);
  assert.match(context, /## Binding rules/);
  assert.match(context, /Inbox: 1 unread — #42/);
  assert.doesNotMatch(context, /CLAUDE\.md|fragment.*missing/i);
  const lookup = requests.find((r) => r.payload['cortext/AgentIdentity']);
  assert.equal(lookup.payload['cortext/AgentIdentity'].params.where.kid.eq, 'test-codex@Box');
  const token = lookup.authorization.replace(/^Bearer /, '').split('.');
  assert.equal(JSON.parse(Buffer.from(token[0], 'base64url')).kid, 'test-codex@Box');
  assert.ok(
    verify(
      null,
      Buffer.from(`${token[0]}.${token[1]}`),
      publicKey,
      Buffer.from(token[2], 'base64url')
    )
  );
  // The only writes are this host's HostInstall row, under the Codex harness.
  const writes = requests.filter((r) => r.url === '/substrate/v1/mutate');
  const ops = writes.flatMap((r) => Object.keys(r.payload));
  assert.ok(ops.length > 0);
  assert.ok(
    ops.every((k) => /^cortext\/(create|update|delete)HostInstall$/.test(k)),
    ops.join()
  );
  assert.match(JSON.stringify(writes.map((r) => r.payload)), /"harness":"codex"/);
});

test('startup and compact both render fresh live context without cached snapshots', async () => {
  const cwd = workspace();
  const calls = [];
  for (const source of ['startup', 'compact']) {
    const result = await handleHook(
      { hook_event_name: 'SessionStart', source, session_id: source },
      loadConfig(cwd, {}),
      {
        coldStart: async (opts) => {
          calls.push(opts);
          return `Fresh ${opts.sessionId}`;
        },
        version: '2.10.0'
      }
    );
    assert.match(
      JSON.parse(result.output).hookSpecificOutput.additionalContext,
      new RegExp(`Fresh ${source}`)
    );
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.harness === 'codex' && call.pluginVersion === '2.10.0'));
});

test('SessionStart reports this host to HostInstall unless SYNOPTIC_HOST_REPORT is off', async () => {
  const seen = [];
  for (const env of [{}, { SYNOPTIC_HOST_REPORT: 'off' }]) {
    await handleHook(
      { hook_event_name: 'SessionStart', source: 'startup', session_id: 's' },
      loadConfig(workspace(env), {}),
      {
        coldStart: async (opts) => {
          seen.push(opts.hostReport);
          return 'doc';
        }
      }
    );
  }
  assert.deepEqual(seen, [true, false]);
});

test('a capped custom-namespace document leaves a usable retrieval pointer', async () => {
  const cwd = workspace({ SUBSTRATE_NAMESPACE: 'custom', SYNOPTIC_COLD_START_MAX_BYTES: '256' });
  const result = await handleHook({ hook_event_name: 'SessionStart' }, loadConfig(cwd, {}), {
    coldStart: async () => `## Large section\n${'x'.repeat(1000)}`
  });
  const context = JSON.parse(result.output).hookSpecificOutput.additionalContext;
  assert.match(context, /custom\/AgentRule/);
  assert.match(context, /viewport truncated/);
  assert.doesNotMatch(context, /cortext\/AgentRule/);
});

test('prompt surfaces mail; Stop continues once and does not recheck on continuation', async (t) => {
  const { requests, url } = await fixture(t);
  const config = loadConfig(workspace({ SUBSTRATE_URL: url }), {});
  const prompt = await handleHook({ hook_event_name: 'UserPromptSubmit' }, config);
  const output = JSON.parse(prompt.output);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /#42/);
  assert.match(output.hookSpecificOutput.additionalContext, /not an instruction from the user/);
  const stop = JSON.parse((await handleHook({ hook_event_name: 'Stop' }, config)).output);
  assert.equal(stop.decision, 'block');
  assert.match(stop.reason, /ackAgentMessage/);
  const count = requests.length;
  assert.deepEqual(
    JSON.parse(
      (await handleHook({ hook_event_name: 'Stop', stop_hook_active: true }, config)).output
    ),
    {}
  );
  assert.equal(requests.length, count);
});

test('offline, disabled checks, malformed stdin and broken config never block a session', async () => {
  const cwd = workspace({
    SUBSTRATE_URL: 'http://127.0.0.1:9',
    SYNOPTIC_INBOX_STOP_CHECK: 'off',
    SYNOPTIC_INBOX_PROMPT_CHECK: 'off'
  });
  for (const event of ['Stop', 'UserPromptSubmit']) {
    const result = await runArtifact(
      'hooks/cortext.mjs',
      cwd,
      JSON.stringify({ hook_event_name: event })
    );
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
  assert.equal((await runArtifact('hooks/cortext.mjs', cwd, 'not-json')).code, 0);
  writeFileSync(join(cwd, '.codex/cortext.local.json'), '{broken');
  const broken = await runArtifact(
    'hooks/cortext.mjs',
    cwd,
    JSON.stringify({ hook_event_name: 'Stop' })
  );
  assert.equal(broken.code, 0);
  assert.deepEqual(JSON.parse(broken.stdout), {});
  assert.match(broken.stderr, /settings/);
});

test('a hung operation is bounded and its request signal is aborted', async () => {
  const cwd = workspace({ SUBSTRATE_URL: 'http://127.0.0.1:9' });
  let aborted = false;
  const result = await handleHook({ hook_event_name: 'SessionStart' }, loadConfig(cwd, {}), {
    budgetMs: 20,
    coldStart: ({ fetchImpl }) => fetchImpl('http://127.0.0.1:9'),
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      })
  });
  assert.equal(aborted, true);
  assert.match(JSON.parse(result.output).hookSpecificOutput.additionalContext, /timeout/);
});

test('the bundled MCP server is not named substrate, so disabling a global substrate server spares it', () => {
  // Codex keys [mcp_servers.<name>] enabled = false by name, so a shared name
  // would disable the plugin's server along with the user-level one.
  const servers = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(servers), ['cortext-substrate']);
});

test('the MCP server finds its launcher without a plugin-root variable', () => {
  // Measured on codex-cli 0.162.1: neither ${CLAUDE_PLUGIN_ROOT} nor
  // ${PLUGIN_ROOT} is expanded in a plugin MCP server's command or args, the
  // spawned env carries no plugin variable, and cwd is the project, which the
  // launcher needs to find .codex/cortext.local.json. So it resolves the
  // installed copy under Codex's plugin cache, keyed by our marketplace name.
  const { command, args } = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')).mcpServers[
    'cortext-substrate'
  ];
  const script = [command, ...args].join(' ');
  assert.doesNotMatch(script, /PLUGIN_ROOT/);
  const market = JSON.parse(
    readFileSync(join(ROOT, '.agents/plugins/marketplace.json'), 'utf8')
  ).name;
  assert.match(script, new RegExp(`/plugins/cache/${market}/cortext"`));
  assert.match(script, /\/bin\/substrate-mcp\.mjs/);
});

test('the MCP launcher runs the newest cached version, a release above its prereleases', () => {
  const { args } = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')).mcpServers[
    'cortext-substrate'
  ];
  const market = JSON.parse(
    readFileSync(join(ROOT, '.agents/plugins/marketplace.json'), 'utf8')
  ).name;
  const home = mkdtempSync(join(tmpdir(), 'cortext-codex-home-'));
  // 2.13.1 sorts before 2.9.0 lexically; 1.0.0 sorts below its prereleases under plain sort -V.
  for (const [cache, versions, want] of [
    ['a', ['2.9.0', '2.13.1'], '2.13.1'],
    ['b', ['1.0.0-alpha.8', '1.0.0-alpha.10', '1.0.0'], '1.0.0'],
    ['c', ['1.0.0-alpha.8', '1.0.0-alpha.10'], '1.0.0-alpha.10']
  ]) {
    const root = join(home, cache, 'plugins/cache', market, 'cortext');
    for (const v of versions) {
      mkdirSync(join(root, v, 'bin'), { recursive: true });
      writeFileSync(join(root, v, 'bin/substrate-mcp.mjs'), `console.log(${JSON.stringify(v)});`);
    }
    const out = spawnSync('sh', args, {
      env: { ...process.env, CODEX_HOME: join(home, cache) },
      encoding: 'utf8'
    });
    assert.equal(out.stdout.trim(), want);
  }
});

test('MCP launcher uses the same settings identity and keeps stdio clean', async () => {
  const cwd = workspace({ SUBSTRATE_URL: 'http://127.0.0.1:9' });
  const stub = join(cwd, 'mcp-stub.mjs');
  writeFileSync(
    stub,
    `let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const request = JSON.parse(raw);
    process.stdout.write(JSON.stringify({jsonrpc:'2.0', id: request.id,
      result:{kid:process.env.SUBSTRATE_AGENT_KEY_ID}})+'\\n');`
  );
  const path = join(cwd, '.codex/cortext.local.json');
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  settings.mcp = { command: process.execPath, args: [stub] };
  writeFileSync(path, JSON.stringify(settings));
  const result = await runArtifact(
    'bin/substrate-mcp.mjs',
    cwd,
    JSON.stringify({ id: 7, method: 'initialize' })
  );
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    jsonrpc: '2.0',
    id: 7,
    result: { kid: 'test-codex@Box' }
  });
  assert.throws(() => mcpInvocation({ env: {}, mcp: null }), /requires/);
  assert.throws(
    () => mcpInvocation({ ...loadConfig(cwd, {}), mcp: { command: 'npx', args: [] } }),
    /absolute/
  );
});

test('MCP fails loudly without a usable identity instead of starting anonymously', async () => {
  const cwd = workspace({
    SUBSTRATE_URL: 'http://127.0.0.1:9',
    SUBSTRATE_AGENT_KEY_PATH: '/missing/key'
  });
  const result = await runArtifact('bin/substrate-mcp.mjs', cwd, '{}');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /identity/);
});

test('shared council and todo skill pointers stay identical to the existing adapters', () => {
  for (const skill of ['council', 'todos']) {
    assert.equal(
      readFileSync(join(ROOT, `skills/${skill}/SKILL.md`), 'utf8'),
      readFileSync(join(ROOT, `../cortext-plugin/skills/${skill}/SKILL.md`), 'utf8')
    );
  }
});

test('substrate-run shares steps 1-5 with the Claude skill; only binary, identity and approvals differ', () => {
  const steps = (path) => {
    const text = readFileSync(join(ROOT, path), 'utf8');
    return text.slice(text.indexOf('## 1.'), text.indexOf('## 6.'));
  };
  const ours = steps('skills/substrate-run/SKILL.md');
  assert.ok(ours.length > 0);
  assert.equal(ours, steps('../cortext-plugin/skills/substrate-run/SKILL.md'));
});

test('a tracked .codex/cortext.local.json is refused, so a checkout cannot choose the MCP command', () => {
  const cwd = workspace({ SUBSTRATE_URL: 'https://substrate.test' });
  assert.throws(() => loadConfig(cwd, {}, undefined, () => true), /tracked by git/);
  assert.throws(() => loadConfig(cwd, {}, undefined, () => null), /could not confirm/);
  assert.equal(loadConfig(cwd, {}).env.SUBSTRATE_URL, 'https://substrate.test');
});

test('gitTracks reads the real index, case-insensitively', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cortext-codex-git-'));
  const git = (...args) => spawnSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  assert.equal(git('init', '-q').status, 0);
  mkdirSync(join(cwd, '.Codex'));
  writeFileSync(join(cwd, '.Codex/cortext.local.json'), '{}');
  assert.equal(gitTracks(cwd, CONFIG_PATH), false);
  git('add', '.Codex/cortext.local.json');
  assert.equal(gitTracks(cwd, CONFIG_PATH), true);
  assert.equal(gitTracks(join(cwd, 'missing'), CONFIG_PATH), null);
});

test('a symlinked .codex directory or settings file is refused', () => {
  const cwd = workspace();
  const elsewhere = mkdtempSync(join(tmpdir(), 'cortext-codex-link-'));
  renameSync(join(cwd, '.codex'), join(elsewhere, 'real'));
  symlinkSync(join(elsewhere, 'real'), join(cwd, '.codex'));
  assert.throws(() => loadConfig(cwd, {}), /must be a directory/);
  rmSync(join(cwd, '.codex'));
  mkdirSync(join(cwd, '.codex'));
  symlinkSync(join(elsewhere, 'real', 'cortext.local.json'), join(cwd, CONFIG_PATH));
  assert.throws(() => loadConfig(cwd, {}), /regular file/);
});
