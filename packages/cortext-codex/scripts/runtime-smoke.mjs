#!/usr/bin/env node
// Optional installed-runtime verification. All state, inference and mail are
// fixtures in /tmp; no real provider, credentials, Substrate or agents are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'cortext-codex-runtime-'));
const home = join(scratch, 'home');
const repo = join(scratch, 'repo');
const plugin = join(scratch, 'plugin');
for (const dir of [home, join(repo, '.git'), join(repo, '.codex'), plugin])
  mkdirSync(dir, { recursive: true });
for (const path of [
  '.codex-plugin',
  '.mcp.json',
  'hooks',
  'bin',
  'skills',
  '.agents',
  'package.json'
])
  cpSync(join(packageRoot, path), join(plugin, path), { recursive: true });

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(SUBSTRATE_|SYNOPTIC_|MEMORY_|OPENAI_|CODEX_)/.test(key)
  )
);
env.CODEX_HOME = home;
const modelRequests = [];
const hookLookups = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url === '/substrate/v1/query') {
    const data = Object.fromEntries(Object.keys(body).map((key) => [key, []]));
    if ('cortext/AgentIdentity' in body) {
      hookLookups.push(body['cortext/AgentIdentity'].params.where.kid.eq);
      data['cortext/AgentIdentity'] = [{ id: 'fixture-agent' }];
    }
    if ('cortext/AgentMessage' in body)
      data['cortext/AgentMessage'] = [
        {
          id: 'fixture-mail',
          shortId: 42,
          subject: 'FIXTURE_MAIL_SUBJECT',
          body: 'FIXTURE_MAIL_BODY',
          _metadata: { createdBy: { id: 'fixture-peer' }, createdAt: '2026-10-10T12:00:00Z' }
        }
      ];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data }));
    return;
  }
  if (req.url?.endsWith('/responses')) {
    modelRequests.push(body);
    const id = `fixture-${modelRequests.length}`;
    const item = {
      id: `msg-${id}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Fixture review complete.', annotations: [] }]
    };
    const response = {
      id,
      object: 'response',
      model: 'gpt-5.1-codex',
      status: 'completed',
      output: [item],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] }
      },
      {
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: 'Fixture review complete.'
      },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response }
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [] }));
});

function command(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd: repo, env, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Codex fixture timed out: ${args[0]}`));
    }, 30000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
writeFileSync(
  join(home, 'config.toml'),
  `
model = "gpt-5.1-codex"
model_provider = "cortext_fixture"
[model_providers.cortext_fixture]
name = "Loopback fixture"
base_url = "${url}/v1"
wire_api = "responses"
requires_openai_auth = false
[features]
remote_plugin = false
apps = false
memories = false
[analytics]
enabled = false
[projects.${JSON.stringify(repo)}]
trust_level = "trusted"
[plugins."cortext@synoptic-codex-local"]
enabled = true
`
);
const { privateKey } = generateKeyPairSync('ed25519');
const key = join(scratch, 'fixture.key');
writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const stub = join(scratch, 'mcp-fixture.mjs');
writeFileSync(
  stub,
  `import { createInterface } from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
  const r = JSON.parse(line); if (!('id' in r)) continue;
  const result = r.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'0'}} : {tools:[]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
}`
);
writeFileSync(
  join(repo, '.codex/cortext.local.json'),
  JSON.stringify({
    env: {
      SUBSTRATE_URL: url,
      SUBSTRATE_AGENT_KEY_ID: 'fixture-codex@Box',
      SUBSTRATE_AGENT_KEY_PATH: key
    },
    mcp: { command: process.execPath, args: [stub] }
  })
);

let app;
try {
  const added = await command(['plugin', 'marketplace', 'add', plugin]);
  assert.equal(added.code, 0, added.stderr);
  app = spawn('codex', ['app-server'], { cwd: repo, env, stdio: 'pipe' });
  let errors = '';
  app.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const pending = new Map();
  const lines = createInterface({ input: app.stdout });
  lines.on('line', (line) => {
    const response = JSON.parse(line);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) request.reject(new Error(JSON.stringify(response.error)));
    else request.resolve(response.result);
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      id++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out: ${errors}`)), 15000);
      pending.set(id, { resolve, reject, timer });
      app.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  await call('initialize', {
    clientInfo: { name: 'cortext-runtime-smoke', version: '0.1.0' },
    capabilities: { experimentalApi: true }
  });
  app.stdin.write('{"method":"initialized"}\n');
  const catalog = await call('plugin/list', {
    cwds: [repo],
    marketplaceKinds: ['local'],
    forceRefetch: false
  });
  const market = catalog.marketplaces.find((m) => m.name === 'synoptic-codex-local');
  assert.ok(market, 'package-local catalog must resolve from the configured marketplace root');
  const { plugin: detail } = await call('plugin/read', {
    marketplacePath: market.path,
    pluginName: 'cortext'
  });
  assert.equal(
    detail.summary.localVersion,
    JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version
  );
  assert.equal(detail.skills.length, 4);
  assert.deepEqual(detail.mcpServers, ['substrate']);
  const hooks = (await call('hooks/list', { cwds: [repo] })).data[0];
  assert.deepEqual(hooks.errors, []);
  assert.deepEqual(hooks.hooks.map((h) => h.eventName).sort(), [
    'sessionStart',
    'stop',
    'userPromptSubmit'
  ]);
  assert.ok(hooks.hooks.every((h) => h.trustStatus === 'untrusted' && h.source === 'plugin'));
  app.kill('SIGKILL');
  const executed = await command([
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--dangerously-bypass-hook-trust',
    '--json',
    '--sandbox',
    'read-only',
    'LOCAL_FIXTURE_PROMPT: return the fixture review result.'
  ]);
  assert.equal(executed.code, 0, executed.stderr);
  assert.equal(modelRequests.length, 2, 'unread mail should request exactly one Stop continuation');
  const first = JSON.stringify(modelRequests[0].input);
  assert.match(first, /Conventions/);
  assert.match(first, /FIXTURE_MAIL_BODY/);
  assert.match(first, /FIXTURE_MAIL_SUBJECT/);
  assert.match(JSON.stringify(modelRequests[1].input), /Before finishing/);
  assert.ok(hookLookups.length >= 3);
  assert.ok(hookLookups.every((kid) => kid === 'fixture-codex@Box'));
  console.log(
    'PASS: installed Codex discovers the catalog, four skills, MCP and three untrusted hooks.'
  );
  console.log(
    'PASS: loopback inference sees startup context, prompt mail and exactly one Stop continuation.'
  );
  console.log(`Temporary fixtures: ${scratch}`);
} finally {
  app?.kill('SIGKILL');
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
