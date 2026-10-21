import { describe, expect, it } from 'vitest';
import { onboard } from '../src/onboard.js';

const OPTS = {
  host: 'Desk',
  project: 'tools',
  substrateUrl: 'https://substrate.example.com',
  mcpBin: '/opt/substrate/node_modules/@mnmal-ai/substrate/dist/substrate.js',
  keyDir: '/home/user/.config/substrate/keys'
};

describe('onboard — full per-harness onboarding plan', () => {
  it('composes identity + MCP config + instructions for a harness', () => {
    const plan = onboard('cursor', OPTS);
    expect(plan.harness).toBe('cursor');
    expect(plan.agent).toBe('cursor');
    expect(plan.kid).toBe('cursor@Desk');
    expect(plan.identity.steps.map((s) => s.id)).toEqual(['keygen', 'register', 'restart']);

    const byKind = Object.fromEntries(plan.files.map((f) => [f.kind, f]));
    expect(byKind.mcp.path).toBe('.cursor/mcp.json');
    expect(byKind.instructions.path).toBe('.cursor/rules/substrate.mdc');
  });

  it('threads the provisioned identity into the MCP env (kid + key are consistent)', () => {
    const plan = onboard('cursor', OPTS);
    const mcp = plan.files.find((f) => f.kind === 'mcp');
    const env = JSON.parse(mcp.content).mcpServers.substrate.env;
    expect(env.SUBSTRATE_AGENT_KEY_ID).toBe(plan.kid);
    expect(env.SUBSTRATE_AGENT_KEY_PATH).toBe(plan.identity.keyPath);
  });

  it('scopes the instruction doc to the project (not the identity)', () => {
    const plan = onboard('cursor', OPTS);
    // identity stays per-agent; the project only scopes the cold-start doc.
    expect(plan.kid).toBe('cursor@Desk');
    expect(plan.files.find((f) => f.kind === 'instructions').content).toContain('tools');
  });

  it('surfaces a prime hint for Kimi (manual-prime) and none for auto-file harnesses', () => {
    expect(onboard('kimi', OPTS).primeHint).toMatch(/@AGENTS\.md/);
    expect(onboard('gemini', OPTS).primeHint).toBeNull();
  });

  it('maps claude-code to the `claude` agent label', () => {
    const plan = onboard('claude-code', OPTS);
    expect(plan.agent).toBe('claude');
    expect(plan.kid).toBe('claude@Desk');
    expect(plan.files.find((f) => f.kind === 'mcp').path).toBe('.mcp.json');
  });

  it('onboards opencode: live-inject doc, opencode.json merge fragment, opencode agent label', () => {
    const plan = onboard('opencode', OPTS);
    expect(plan.agent).toBe('opencode');
    expect(plan.kid).toBe('opencode@Desk');
    expect(plan.primeHint).toBeNull();
    const byKind = Object.fromEntries(plan.files.map((f) => [f.kind, f]));
    expect(byKind.mcp.path).toBe('opencode.json');
    expect(byKind.mcp.merge).toBe(true);
    expect(JSON.parse(byKind.mcp.content).mcp.servers.substrate.type).toBe('local');
    expect(byKind.instructions.path).toBe('AGENTS.md');
    expect(byKind.instructions.content.toLowerCase()).toMatch(/hook|injected/);
  });

  it('onboards muse: machine kid, user-scope settings merge, live-inject AGENTS.md', () => {
    const plan = onboard('muse', OPTS);
    expect(plan.agent).toBe('muse');
    expect(plan.kid).toBe('muse@Desk');
    expect(plan.primeHint).toBeNull();
    const byKind = Object.fromEntries(plan.files.map((f) => [f.kind, f]));
    // Single fleet server: user scope even when the caller passes no scope.
    expect(byKind.mcp.path).toBe('~/.config/muse/settings.json');
    expect(byKind.mcp.merge).toBe(true);
    const content = JSON.parse(byKind.mcp.content).mcpServers.substrate;
    expect(content.transport).toBe('stdio');
    expect(content.env.SUBSTRATE_AGENT_KEY_ID).toBe(plan.kid);
    expect(content.env.SUBSTRATE_AGENT_KEY_PATH).toBe(plan.identity.keyPath);
    expect(byKind.instructions.path).toBe('AGENTS.md');
    expect(byKind.instructions.content.toLowerCase()).toMatch(/hook|injected/);
  });

  it('throws on an unknown harness', () => {
    expect(() => onboard('aider', OPTS)).toThrow(/unknown harness/i);
  });
});
