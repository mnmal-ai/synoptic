// The audit's fact gatherers. Each runs against temp
// directories or a stubbed Substrate; the pure audit* checks they feed are tested
// in audit.test.js.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditSalientTier, auditSemanticRecall, check, credentialIsTargets } from '../src/audit.js';
import { buildGroups } from '../src/audit-facts/groups.js';
import { readDeclaredKid, readDeclaredName, readKeyFiles } from '../src/audit-facts/identity.js';
import { gatherKeyRefs } from '../src/audit-facts/key-refs.js';
import { gatherPluginFacts } from '../src/audit-facts/plugin.js';
import { DIRECTORY_LIMIT, probeServer, readDirectory } from '../src/audit-facts/server.js';

const URL_ = 'https://substrate.test';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `audit-facts-${prefix}-`));
}

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/**
 * A Substrate stub. `answer(key, params)` returns the value for one frame key, or
 * undefined to leave the key absent (a refused frame). Every request body is
 * recorded so tests can assert what was asked.
 */
function stubSubstrate({ answer, whoami = { authEnabled: true, identity: null } }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).slice(URL_.length);
    if (path === '/substrate/v1/whoami') {
      calls.push({ path });
      return { ok: true, status: 200, json: async () => whoami };
    }
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    const data = {};
    for (const [key, frame] of Object.entries(body)) {
      const v = answer(key, frame.params ?? {});
      if (v !== undefined) data[key] = v;
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { fetchImpl, calls };
}

describe('gatherPluginFacts', () => {
  it('reads the registry, the cache candidates and a cache-derived served root', () => {
    const pluginsDir = tmp('plugins');
    const cacheDir = join(pluginsDir, 'cache', 'mnmal-ai', 'cortext');
    write(
      join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'cortext@mnmal-ai': [{ version: '2.15.0' }] } })
    );
    write(join(cacheDir, '2.15.0', 'fragments', 'substrate-conventions.md'), '# frag\n');
    const facts = gatherPluginFacts({
      pluginsDir,
      cacheDir,
      targetDir: tmp('target'),
      envRoot: null,
      selfRoot: join(cacheDir, '2.15.0')
    });
    expect(facts.installedVersion).toBe('2.15.0');
    expect(facts.installedRegistry).toBe('present');
    expect(facts.cacheDirState).toBe('readable');
    expect(facts.candidates.map((c) => c.version)).toEqual(['2.15.0']);
    expect(facts.servedRootState).toBe('derived-cache');
  });

  it('reports an unreadable registry and cache as holes, and an env root as set', () => {
    const pluginsDir = tmp('empty');
    const facts = gatherPluginFacts({
      pluginsDir,
      cacheDir: join(pluginsDir, 'cache', 'mnmal-ai', 'cortext'),
      targetDir: tmp('target'),
      envRoot: tmp('envroot'),
      selfRoot: '/elsewhere'
    });
    expect(facts.installedVersion).toBeNull();
    expect(facts.installedRegistry).toBe('unreadable');
    expect(facts.cacheDirState).toBe('unreadable');
    expect(facts.candidates).toEqual([]);
    expect(facts.servedRootState).toBe('set');
  });

  it('tells a registry without this plugin from an unreadable one', () => {
    const pluginsDir = tmp('noentry');
    write(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ plugins: {} }));
    const facts = gatherPluginFacts({
      pluginsDir,
      cacheDir: join(pluginsDir, 'cache'),
      targetDir: tmp('target'),
      envRoot: null,
      selfRoot: '/src/checkout'
    });
    expect(facts.installedRegistry).toBe('no-entry');
    expect(facts.servedRootState).toBe('derived-source');
  });
});

describe('identity facts', () => {
  it('reads the declared kid from settings when there is no .mcp.json', () => {
    const dir = tmp('kid');
    write(
      join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { SUBSTRATE_AGENT_KEY_ID: 'repo-claude@Host' } })
    );
    expect(readDeclaredKid(dir)).toBe('repo-claude@Host');
  });

  it('answers null when .mcp.json pins two different kids', () => {
    const dir = tmp('ambiguous');
    write(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          a: { env: { SUBSTRATE_AGENT_KEY_ID: 'a@h' } },
          b: { env: { SUBSTRATE_AGENT_KEY_ID: 'b@h' } }
        }
      })
    );
    expect(readDeclaredKid(dir)).toBeNull();
  });

  it('reads the declared name from settings.json', () => {
    const dir = tmp('name');
    write(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ env: { SYNOPTIC_AGENT_NAME: 'n' } })
    );
    expect(readDeclaredName(dir)).toBe('n');
    expect(readDeclaredName(tmp('noname'))).toBeNull();
  });

  it('splits key files into live and revoked names, and null when unreadable', () => {
    const dir = tmp('keys');
    write(join(dir, 'a.key'), '');
    write(join(dir, 'b.key.revoked'), '');
    write(join(dir, 'a.pub'), '');
    expect(readKeyFiles(dir)).toEqual({ keyNames: ['a'], revokedNames: ['b'] });
    expect(readKeyFiles(join(dir, 'missing'))).toEqual({ keyNames: null, revokedNames: null });
  });
});

describe('readDirectory', () => {
  const env = { SUBSTRATE_NAMESPACE: 'cortext' };

  it('carries active through, so retired identities are not live kids', async () => {
    const { fetchImpl } = stubSubstrate({
      answer: () => [
        { kid: 'a@h', active: true },
        { kid: 'b@h', active: false }
      ]
    });
    const d = await readDirectory({ substrateUrl: URL_, env, fetchImpl });
    expect(d.directoryKids).toEqual(['a@h', 'b@h']);
    expect(d.activeKids).toEqual(['a@h']);
  });

  it('reads a refused frame as unknown, never as an empty directory', async () => {
    const { fetchImpl, calls } = stubSubstrate({ answer: () => undefined });
    const d = await readDirectory({ substrateUrl: URL_, env, fetchImpl });
    expect(d).toEqual({ directoryRows: null, directoryKids: null, activeKids: null });
    // Retried once without `roaming` for an older runtime.
    expect(calls).toHaveLength(2);
    expect(calls[1].body['cortext/AgentIdentity'].fields.roaming).toBeUndefined();
  });

  it('asks nothing without SUBSTRATE_URL', async () => {
    const { fetchImpl, calls } = stubSubstrate({ answer: () => [] });
    const d = await readDirectory({ substrateUrl: null, env, fetchImpl });
    expect(d.directoryKids).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('exposes the page size the truncation finding compares against', () => {
    expect(DIRECTORY_LIMIT).toBe(200);
  });
});

describe('probeServer', () => {
  const env = { SUBSTRATE_NAMESPACE: 'cortext' };
  const targetDir = '/w/synoptic';

  /** Rules r1, r2 with vectors; the anchor queries answer as given. */
  function server({ liveAnchor, everAnchor }) {
    return stubSubstrate({
      answer: (key, params) => {
        if (key === 'cortext/AgentRule') return [{ id: 'r1' }, { id: 'r2' }];
        if (key === 'cortext/AnchorIntent') {
          return params.where?.project?.eq !== undefined ? everAnchor : liveAnchor;
        }
        if (key === 'recall/fetchEmbeddings') {
          return { vectors: params.refs.map((r) => ({ id: r.id, vector: [1] })) };
        }
        if (key === 'recall/Hit') return [];
        return undefined;
      }
    });
  }

  it('reports unknown for both probes without SUBSTRATE_URL', async () => {
    const out = await probeServer({
      substrateUrl: null,
      env,
      targetDir,
      fetchImpl: null,
      kid: null
    });
    expect(out.whoami.ok).toBe(false);
    expect(out.salientFindings.map((f) => f.state)).toEqual(['unknown']);
    expect(out.recallFindings.map((f) => f.state)).toEqual(['unknown']);
  });

  it('asks whether this project EVER had an anchor when none is live', async () => {
    const { fetchImpl, calls } = server({ liveAnchor: [], everAnchor: [] });
    const out = await probeServer({ substrateUrl: URL_, env, targetDir, fetchImpl, kid: null });
    const ever = calls.find(
      (c) => c.body?.['cortext/AnchorIntent']?.params?.where?.project?.eq === 'synoptic'
    );
    expect(ever).toBeDefined();
    expect(out.salientFindings).toEqual(
      auditSalientTier({
        probe: {
          vectors: new Map([
            ['r1', [1]],
            ['r2', [1]]
          ]),
          failed: null
        },
        activeRuleIds: ['r1', 'r2'],
        anchorId: null,
        anchorHistory: 'none'
      })
    );
  });

  it('tells an archived anchor from none', async () => {
    const { fetchImpl } = server({ liveAnchor: [], everAnchor: [{ id: 'old' }] });
    const out = await probeServer({ substrateUrl: URL_, env, targetDir, fetchImpl, kid: null });
    expect(out.salientFindings).toEqual(
      auditSalientTier({
        probe: {
          vectors: new Map([
            ['r1', [1]],
            ['r2', [1]]
          ]),
          failed: null
        },
        activeRuleIds: ['r1', 'r2'],
        anchorId: null,
        anchorHistory: 'archived'
      })
    );
  });

  it('skips the history query under SYNOPTIC_PROJECT_SCOPE=all', async () => {
    const { fetchImpl, calls } = server({ liveAnchor: [], everAnchor: [] });
    await probeServer({
      substrateUrl: URL_,
      env: { ...env, SYNOPTIC_PROJECT_SCOPE: 'all' },
      targetDir,
      fetchImpl,
      kid: null
    });
    expect(calls.filter((c) => c.body?.['cortext/AnchorIntent'])).toHaveLength(1);
  });

  it('scores a live anchor and recall that answers', async () => {
    const { fetchImpl } = server({ liveAnchor: [{ id: 'a1' }], everAnchor: [] });
    const out = await probeServer({ substrateUrl: URL_, env, targetDir, fetchImpl, kid: null });
    expect(out.salientFindings).toEqual(
      auditSalientTier({
        probe: {
          vectors: new Map([
            ['r1', [1]],
            ['r2', [1]],
            ['a1', [1]]
          ]),
          failed: null
        },
        activeRuleIds: ['r1', 'r2'],
        anchorId: 'a1',
        anchorHistory: null
      })
    );
    expect(out.recallFindings).toEqual(
      auditSemanticRecall({
        answered: true,
        credentialAttributed: credentialIsTargets({
          whoami: out.whoami,
          resolvedKid: null,
          declaredKid: null
        }),
        reachable: true,
        reason: 'the recall frame did not answer and gave no reason'
      })
    );
  });

  it('reports a refused rule frame as a failed probe, and recall as unreachable-attributed', async () => {
    const { fetchImpl } = stubSubstrate({ answer: () => undefined });
    const out = await probeServer({ substrateUrl: URL_, env, targetDir, fetchImpl, kid: null });
    expect(out.salientFindings.some((f) => f.state === 'unknown')).toBe(true);
    expect(out.recallFindings).toEqual(
      auditSemanticRecall({
        answered: false,
        credentialAttributed: credentialIsTargets({
          whoami: out.whoami,
          resolvedKid: null,
          declaredKid: null
        }),
        reachable: false,
        reason: 'recall/Hit: requested but absent from `data`, with no error given'
      })
    );
  });
});

describe('gatherKeyRefs', () => {
  it('scans only the target without --fleet, and calls that scan incomplete', () => {
    const target = tmp('target');
    write(
      join(target, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          substrate: {
            env: { SUBSTRATE_AGENT_KEY_ID: 't@h', SUBSTRATE_AGENT_KEY_PATH: '/k/target-claude.key' }
          }
        }
      })
    );
    const out = gatherKeyRefs({ fleetDir: null, targetDir: target, home: tmp('home') });
    expect(out.refScanComplete).toBe(false);
    expect(out.keyRefs).toEqual([
      { keyName: 'target-claude', kid: 't@h', source: join(target, '.mcp.json') }
    ]);
  });

  it('scans every fleet repo and the installed systemd units', () => {
    const fleet = tmp('fleet');
    write(
      join(fleet, 'a', 'mise.toml'),
      '[env]\nWORKER_KID = "w@h"\nWORKER_KEY = "/k/worker.key"\n'
    );
    const home = tmp('home');
    write(
      join(home, '.config', 'systemd', 'user', 'd.service'),
      '[Service]\nEnvironment=SUBSTRATE_AGENT_KEY_ID=d@h\nEnvironment=SUBSTRATE_AGENT_KEY_PATH=/home/u/.config/substrate/keys/daemon.key\n'
    );
    const out = gatherKeyRefs({ fleetDir: fleet, targetDir: '/unused', home });
    expect(out.refScanComplete).toBe(true);
    expect(out.keyRefs.map((r) => r.kid).sort()).toEqual(['d@h', 'w@h']);
  });
});

describe('buildGroups', () => {
  /** The facts of a box with nothing installed and no server. */
  function bareFacts(over = {}) {
    return {
      pin: null,
      installedVersion: null,
      installedRegistry: 'unreadable',
      cloneFreshness: 'unchecked',
      cloneDetail: null,
      opencodeSkinVersion: null,
      candidates: [],
      cacheDirState: 'unreadable',
      servedVersion: null,
      servedRootState: 'derived-source',
      resolution: { action: 'none', reason: 'no fragment found' },
      kid: null,
      source: null,
      declaredName: null,
      declaredKid: null,
      keyNames: null,
      revokedNames: null,
      directoryKids: null,
      activeKids: null,
      directoryRows: null,
      whoami: { ok: false, failed: 'SUBSTRATE_URL is not set, so the server could not be asked' },
      authWarning: null,
      targetDir: '/w/r',
      cwd: '/w/r',
      env: {},
      keyRefs: [],
      refScanComplete: false,
      mcpJsonFacts: { present: false, tracked: null, markers: null },
      salientFindings: [],
      recallFindings: [],
      settingsFindings: [],
      fleetFindings: null,
      hostFindings: null,
      ...over
    };
  }

  it('renders the groups in report order, fleet and hosts only when gathered', () => {
    expect(buildGroups(bareFacts()).map(([name]) => name)).toEqual([
      'pin',
      'skins',
      'plugin',
      'fragment',
      'identity',
      'authority',
      'drift',
      'mcp-json',
      'inbox push',
      'salient tier',
      'settings'
    ]);
    const fleet = [check('fleet.x', 'ok', 'x')];
    const names = buildGroups(bareFacts({ fleetFindings: fleet, hostFindings: [] })).map(
      ([n]) => n
    );
    expect(names.slice(-2)).toEqual(['fleet', 'hosts']);
  });

  it('flags a full directory page as possibly truncated', () => {
    const rows = Array.from({ length: DIRECTORY_LIMIT }, (_, i) => ({ kid: `k${i}@h` }));
    const drift = buildGroups(
      bareFacts({
        directoryRows: rows,
        directoryKids: rows.map((r) => r.kid),
        activeKids: rows.map((r) => r.kid)
      })
    ).find(([n]) => n === 'drift')[1];
    expect(drift.some((f) => f.id === 'directory.truncated' && f.state === 'unknown')).toBe(true);
  });
});
