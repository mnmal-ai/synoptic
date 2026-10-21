import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  reduceFindings,
  runHostChecks,
  SETTINGS_ENV_ALLOWLIST,
  settingsEnvSnapshot
} from '../src/host-checks.js';

describe('reduceFindings', () => {
  it('takes the worst state, warn over unknown over ok, and that finding as the note', () => {
    expect(
      reduceFindings([
        { id: 'a', state: 'ok', text: 'fine' },
        { id: 'b', state: 'unknown', text: 'could not ask', detail: 'x' },
        { id: 'c', state: 'warn', text: 'broken' }
      ])
    ).toEqual({ state: 'warn', note: 'broken' });
    expect(reduceFindings([{ id: 'a', state: 'ok', text: 'fine' }])).toEqual({
      state: 'ok',
      note: 'fine'
    });
  });

  it('on a tie, keeps the later and more specific finding', () => {
    expect(
      reduceFindings([
        { id: 'pin.read', state: 'ok', text: 'pin v2.9.0' },
        { id: 'pin.installed', state: 'ok', text: 'installed 2.9.0 matches' }
      ])
    ).toEqual({ state: 'ok', note: 'installed 2.9.0 matches' });
  });

  it('drops ignored ids, and an empty result is unknown rather than ok', () => {
    expect(
      reduceFindings(
        [
          { id: 'pin.freshness', state: 'unknown', text: 'not fetched', detail: 'x' },
          { id: 'pin.installed', state: 'ok', text: 'matches' }
        ],
        { ignore: ['pin.freshness'] }
      )
    ).toEqual({ state: 'ok', note: 'matches' });
    expect(reduceFindings([])).toEqual({ state: 'unknown', note: 'the check produced no finding' });
  });

  it('keeps a note to one capped line', () => {
    const { note } = reduceFindings([{ id: 'a', state: 'warn', text: `x\ny${'z'.repeat(400)}` }]);
    expect(note).not.toMatch(/\n/);
    expect(note.length).toBeLessThanOrEqual(201);
  });
});

describe('settingsEnvSnapshot', () => {
  it('records allowlisted values and only the presence of identity keys', () => {
    const snap = settingsEnvSnapshot({
      SUBSTRATE_URL: 'https://h:3100',
      SUBSTRATE_NAMESPACE: 'cortext',
      SYNOPTIC_INBOX_PUSH: 'off',
      SUBSTRATE_AGENT_KEY_ID: 'synoptic-claude@Desk',
      SUBSTRATE_AGENT_KEY_PATH: '/home/me/.config/substrate/keys/synoptic.key',
      GH_TOKEN: 'secret',
      PATH: '/usr/bin'
    });
    expect(snap).toEqual({
      SUBSTRATE_URL: 'https://h:3100',
      SUBSTRATE_NAMESPACE: 'cortext',
      SYNOPTIC_INBOX_PUSH: 'off',
      SUBSTRATE_AGENT_KEY_ID: true,
      SUBSTRATE_AGENT_KEY_PATH: true
    });
    expect(JSON.stringify(snap)).not.toContain('.config/substrate/keys');
    expect(JSON.stringify(snap)).not.toContain('secret');
  });

  it('keeps only the origin and path of SUBSTRATE_URL, never credentials', () => {
    expect(
      settingsEnvSnapshot({ SUBSTRATE_URL: 'https://user:tok3n@h.example:3100/base?token=abc#x' })
        .SUBSTRATE_URL
    ).toBe('https://h.example:3100/base');
    expect(settingsEnvSnapshot({ SUBSTRATE_URL: 'https://h:3100' }).SUBSTRATE_URL).toBe(
      'https://h:3100'
    );
    expect(settingsEnvSnapshot({ SUBSTRATE_URL: 'not a url' }).SUBSTRATE_URL).toBe('(unparseable)');
  });

  it('records an unset identity key as false, and omits unset switches', () => {
    expect(settingsEnvSnapshot({})).toEqual({
      SUBSTRATE_AGENT_KEY_ID: false,
      SUBSTRATE_AGENT_KEY_PATH: false
    });
  });

  it('allowlists only non-secret switches', () => {
    for (const k of SETTINGS_ENV_ALLOWLIST) expect(k).not.toMatch(/KEY|TOKEN|SECRET|PASS/);
  });
});

function repo({ settings = null, mcp = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'host-checks-'));
  mkdirSync(join(dir, '.claude'));
  if (settings !== null) writeFileSync(join(dir, '.claude', 'settings.local.json'), settings);
  if (mcp !== null) writeFileSync(join(dir, '.mcp.json'), mcp);
  return dir;
}

const whoamiOk = (grants) => async (url) => {
  if (!url.endsWith('/substrate/v1/whoami')) throw new Error(`unexpected ${url}`);
  return {
    ok: true,
    status: 200,
    json: async () => ({ authEnabled: true, identity: { id: 'k@h', grants } })
  };
};

const base = (over = {}) => ({
  substrateUrl: 'https://h',
  namespace: 'cortext',
  agentKid: 'k@h',
  authWarning: null,
  harness: 'claude-code',
  pluginVersion: '2.9.0',
  env: {},
  pluginsDir: '/nonexistent/plugins',
  fetchImpl: whoamiOk({ '*': ['*'] }),
  ...over
});

describe('runHostChecks', () => {
  it('produces all four states and the settings snapshot', async () => {
    const cwd = repo({ settings: '{"enableAllProjectMcpServers": true}' });
    const out = await runHostChecks(base({ cwd, env: { SUBSTRATE_NAMESPACE: 'cortext' } }));
    expect(Object.keys(out).sort()).toEqual(
      [
        'authorityNote',
        'authorityState',
        'mcpJsonNote',
        'mcpJsonState',
        'pinNote',
        'pinState',
        'settingsEnv',
        'settingsNote',
        'settingsState'
      ].sort()
    );
    expect(out.mcpJsonState).toBe('ok');
    expect(out.settingsState).toBe('ok');
    expect(out.settingsEnv.SUBSTRATE_NAMESPACE).toBe('cortext');
    // No marketplace clone under pluginsDir: the pin cannot be compared.
    expect(out.pinState).toBe('unknown');
  });

  it('records no pin verdict off claude-code: other harnesses have no marketplace rail', async () => {
    const out = await runHostChecks(base({ cwd: repo(), harness: 'opencode' }));
    expect(out.pinState).toBeNull();
    expect(out.pinNote).toBeNull();
  });

  for (const harness of ['opencode', 'codex']) {
    it(`${harness}: no .mcp.json or settings verdict, because those are Claude Code's files`, async () => {
      // A broken Claude settings file in the same repo must not reach this row.
      const cwd = repo({ settings: '{"a": 1,,}', mcp: '{}' });
      const out = await runHostChecks(
        base({ cwd, harness, env: { SUBSTRATE_NAMESPACE: 'cortext' } })
      );
      for (const k of ['mcpJsonState', 'mcpJsonNote', 'settingsState', 'settingsNote']) {
        expect(out[k]).toBeNull();
      }
      expect(out.authorityState).toBe('warn');
      expect(out.settingsEnv.SUBSTRATE_NAMESPACE).toBe('cortext');
    });
  }

  it('a pin matching the served plugin is ok, without the network freshness check', async () => {
    const plugins = mkdtempSync(join(tmpdir(), 'plugins-'));
    const clone = join(plugins, 'marketplaces', 'mnmal-ai', '.claude-plugin');
    mkdirSync(clone, { recursive: true });
    writeFileSync(
      join(clone, 'marketplace.json'),
      JSON.stringify({
        name: 'mnmal-ai',
        plugins: [
          {
            name: 'cortext',
            version: '2.9.0',
            source: { source: 'git-subdir', url: 'mnmal-ai/synoptic', ref: 'v2.9.0' }
          }
        ]
      })
    );
    const out = await runHostChecks(base({ cwd: repo(), pluginsDir: plugins }));
    expect(out.pinState).toBe('ok');
    const behind = await runHostChecks(
      base({ cwd: repo(), pluginsDir: plugins, pluginVersion: '2.8.0' })
    );
    expect(behind.pinState).toBe('warn');
    expect(behind.pinNote).toContain('2.8.0');
  });

  it('asks git whether .mcp.json is tracked, without blocking', async () => {
    const cwd = repo({ mcp: '{"mcpServers": {"substrate": {"command": "substrate"}}}' });
    execFileSync('git', ['init', '-q', cwd]);
    const out = await runHostChecks(base({ cwd }));
    // An untracked file git answered for, not "could not tell".
    expect(out.mcpJsonState).not.toBe('unknown');
  });

  it('broken settings JSON is a warn', async () => {
    const out = await runHostChecks(base({ cwd: repo({ settings: '{"a": 1,,}' }) }));
    expect(out.settingsState).toBe('warn');
    expect(out.settingsNote).toMatch(/NOT VALID JSON/);
  });

  it('a failed whoami is unknown, and nothing throws', async () => {
    const out = await runHostChecks(
      base({
        cwd: repo(),
        fetchImpl: async () => {
          throw new Error('network down');
        }
      })
    );
    expect(out.authorityState).toBe('unknown');
  });

  it('a check that throws is recorded as unknown with its reason', async () => {
    const out = await runHostChecks(
      base({
        cwd: repo(),
        readFile: () => {
          throw new Error('EACCES');
        }
      })
    );
    expect(out.settingsState).toBe('unknown');
    expect(out.settingsNote).toContain('EACCES');
  });
});
