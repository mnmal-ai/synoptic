import { describe, expect, it } from 'vitest';
import { HARNESSES, wireMCP } from '../src/wire-mcp.js';

const ID = {
  substrateUrl: 'https://substrate.example.com',
  kid: 'kimi@Desk',
  keyPath: '/home/user/.config/substrate/keys/kimi@Desk.key',
  mcpBin: '/opt/substrate/node_modules/@mnmal-ai/substrate/dist/substrate.js'
};

describe('HARNESSES descriptor', () => {
  it('covers all seven harnesses with a cold-start tier', () => {
    expect(Object.keys(HARNESSES).sort()).toEqual(
      ['claude-code', 'codex', 'cursor', 'gemini', 'kimi', 'muse', 'opencode'].sort()
    );
    for (const caps of Object.values(HARNESSES)) {
      expect(['live-inject', 'auto-file', 'manual-prime']).toContain(caps.coldStartTier);
    }
  });

  it('marks Claude Code and Muse as having a session-start injection hook', () => {
    const withHook = Object.entries(HARNESSES)
      .filter(([, c]) => c.injectionHook === 'session-start')
      .map(([h]) => h)
      .sort();
    expect(withHook).toEqual(['claude-code', 'muse']);
  });

  it('marks Kimi as the only harness that does not auto-load instructions', () => {
    const noAuto = Object.entries(HARNESSES)
      .filter(([, c]) => !c.autoLoadsInstructions)
      .map(([h]) => h);
    expect(noAuto).toEqual(['kimi']);
  });
});

describe('wireMCP', () => {
  it('throws on an unknown harness', () => {
    expect(() => wireMCP('aider', ID)).toThrow(/unknown harness/i);
  });

  it('emits a Kimi JSON config at the project path with the substrate server + identity env', () => {
    const out = wireMCP('kimi', ID);
    expect(out.format).toBe('json');
    expect(out.path).toBe('.kimi-code/mcp.json');
    expect(out.merge).toBe(false);
    const parsed = JSON.parse(out.content);
    expect(parsed.mcpServers.substrate.command).toBe('node');
    expect(parsed.mcpServers.substrate.args).toEqual([ID.mcpBin, 'mcp']);
    expect(parsed.mcpServers.substrate.env).toEqual({
      SUBSTRATE_URL: ID.substrateUrl,
      SUBSTRATE_AGENT_KEY_PATH: ID.keyPath,
      SUBSTRATE_AGENT_KEY_ID: ID.kid
    });
  });

  it('emits Codex as TOML with an [mcp_servers.substrate] table + env subtable', () => {
    const out = wireMCP('codex', ID);
    expect(out.format).toBe('toml');
    expect(out.path).toBe('.codex/config.toml');
    expect(out.merge).toBe(true);
    expect(out.content).toContain('[mcp_servers.substrate]');
    expect(out.content).toContain('command = "node"');
    expect(out.content).toContain(`args = ["${ID.mcpBin}", "mcp"]`);
    expect(out.content).toContain('[mcp_servers.substrate.env]');
    expect(out.content).toContain(`SUBSTRATE_AGENT_KEY_ID = "${ID.kid}"`);
  });

  it('flags Gemini as a settings.json merge fragment', () => {
    const out = wireMCP('gemini', ID);
    expect(out.path).toBe('.gemini/settings.json');
    expect(out.merge).toBe(true);
    expect(JSON.parse(out.content).mcpServers.substrate).toBeDefined();
  });

  it('emits the canonical paths for cursor and claude-code', () => {
    expect(wireMCP('cursor', ID).path).toBe('.cursor/mcp.json');
    expect(wireMCP('claude-code', ID).path).toBe('.mcp.json');
  });

  it('emits OpenCode as an opencode.json merge fragment in the opencode dialect', () => {
    const out = wireMCP('opencode', ID);
    expect(out.format).toBe('opencode-json');
    expect(out.path).toBe('opencode.json');
    expect(out.merge).toBe(true);
    const parsed = JSON.parse(out.content);
    // OpenCode 2.x: servers live under `mcp.servers`, not `mcpServers` or
    // 1.x's bare `mcp.<name>`; `type: local` required; command is an array.
    const substrate = parsed.mcp.servers.substrate;
    expect(substrate.type).toBe('local');
    expect(substrate.command).toEqual(['node', ID.mcpBin, 'mcp']);
    // Code mode off: 2.x puts a local server's tools behind the
    // generic `execute` tool by default, so `substrate_*` never reach the model
    // by name, and an agent following the conventions reports no substrate tools.
    expect(substrate.codemode).toBe(false);
    // Identity rides as {env:} refs — opencode.json is committed, so no
    // machine-specific key path or kid may be baked in as a literal.
    expect(substrate.environment.SUBSTRATE_URL).toBe(ID.substrateUrl);
    expect(substrate.environment.SUBSTRATE_AGENT_KEY_PATH).toBe('{env:SUBSTRATE_AGENT_KEY_PATH}');
    expect(substrate.environment.SUBSTRATE_AGENT_KEY_ID).toBe('{env:SUBSTRATE_AGENT_KEY_ID}');
    expect(out.content).not.toContain(ID.keyPath);
    expect(out.content).not.toContain(ID.kid);
  });

  it('emits the OpenCode user path on user scope, npx form without mcpBin', () => {
    expect(wireMCP('opencode', ID, { scope: 'user' }).path).toBe(
      '~/.config/opencode/opencode.json'
    );
    const { mcpBin, ...noBin } = ID;
    const parsed = JSON.parse(wireMCP('opencode', noBin).content);
    expect(parsed.mcp.servers.substrate.command).toEqual([
      'npx',
      '-y',
      '@mnmal-ai/substrate',
      'mcp'
    ]);
  });

  it('honours user scope', () => {
    expect(wireMCP('kimi', ID, { scope: 'user' }).path).toBe('~/.kimi-code/mcp.json');
  });

  it('falls back to npx when no mcpBin is supplied', () => {
    const { mcpBin, ...noBin } = ID;
    const parsed = JSON.parse(wireMCP('kimi', noBin).content);
    expect(parsed.mcpServers.substrate.command).toBe('npx');
    expect(parsed.mcpServers.substrate.args).toEqual(['-y', '@mnmal-ai/substrate', 'mcp']);
  });

  it('respects a custom server name', () => {
    const parsed = JSON.parse(wireMCP('kimi', ID, { serverName: 'ctx' }).content);
    expect(parsed.mcpServers.ctx).toBeDefined();
    expect(parsed.mcpServers.substrate).toBeUndefined();
  });

  it('emits Muse as a user-scope mcpServers merge fragment in the Muse dialect', () => {
    const out = wireMCP('muse', ID, { scope: 'user' });
    expect(out.format).toBe('muse-json');
    expect(out.path).toBe('~/.config/muse/settings.json');
    expect(out.merge).toBe(true);
    const parsed = JSON.parse(out.content);
    // `mcpServers` (the binary migrates `mcp_servers` to this spelling) with
    // an explicit stdio transport per server.
    const substrate = parsed.mcpServers.substrate;
    expect(substrate.transport).toBe('stdio');
    // Absolute interpreter: the MCP child's spawn env is cleared, so a bare
    // `node` never resolves (spawn_or_connect_failed).
    expect(substrate.command).toBe(process.execPath);
    expect(substrate.args).toEqual([ID.mcpBin, 'mcp']);
    expect(substrate.enabled).toBe(true);
    expect(substrate.mode).toBe('optional');
    // User scope is machine-local, never committed — literals are correct.
    expect(substrate.env).toEqual({
      SUBSTRATE_URL: ID.substrateUrl,
      SUBSTRATE_AGENT_KEY_PATH: ID.keyPath,
      SUBSTRATE_AGENT_KEY_ID: ID.kid
    });
  });

  it('refuses Muse at project scope (no project-scope file exists)', () => {
    expect(() => wireMCP('muse', ID)).toThrow(/user.*scope|project-scope/i);
    expect(() => wireMCP('muse', ID, { scope: 'project' })).toThrow(/user.*scope|project-scope/i);
  });

  it('passes the npx fallback command through for Muse', () => {
    const { mcpBin, ...noBin } = ID;
    const parsed = JSON.parse(wireMCP('muse', noBin, { scope: 'user' }).content);
    expect(parsed.mcpServers.substrate.command).toBe('npx');
    expect(parsed.mcpServers.substrate.args).toEqual(['-y', '@mnmal-ai/substrate', 'mcp']);
  });
});
