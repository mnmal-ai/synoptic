// The cold-start's local checks for HostInstall: the audit's pin, .mcp.json,
// authority and settings checks, run on every session start and reduced to a
// state and a note each, so any host can read another's verdicts while they
// are as fresh as its refreshedAt.
//
// Never throws: a check that cannot run is recorded as `unknown` with the
// reason, and a session is never held up by one.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { auditAuthority, auditMcpJson } from './audit.js';
import { createCortext } from './capabilities/cortext.js';
import { compareVersions } from './fragment-resolve.js';
import { listDirsOrNull, readOrNull } from './fs-safe.js';
import { auditPin, readMarketplacePin } from './marketplace-pin.js';
import { readMcpJsonFactsAsync } from './mcp-json-facts.js';
import { checkSettings } from './settings-check.js';
import { probeWhoami } from './substrate-http.js';

/** Non-secret switches whose values are recorded, for fleet-wide drift. */
export const SETTINGS_ENV_ALLOWLIST = [
  'SUBSTRATE_URL',
  'SUBSTRATE_NAMESPACE',
  'SYNOPTIC_PROJECT_SCOPE',
  'SYNOPTIC_INBOX_PUSH',
  'SYNOPTIC_INBOX_WAKE',
  'SYNOPTIC_INBOX_URGENT_FROM'
];

/** Identity keys recorded only as set or unset: one holds a key file's path. */
export const SETTINGS_ENV_PRESENCE = ['SUBSTRATE_AGENT_KEY_ID', 'SUBSTRATE_AGENT_KEY_PATH'];

const RANK = { ok: 0, unknown: 1, warn: 2 };
const NOTE_MAX = 200;
const WHOAMI_TIMEOUT_MS = 1000;
const GIT_TIMEOUT_MS = 1000;

function oneLine(text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > NOTE_MAX ? `${flat.slice(0, NOTE_MAX)}…` : flat;
}

/**
 * The worst finding's state and text: warn over unknown over ok, the later
 * finding on a tie. An empty
 * list is unknown, never ok, because nothing was established.
 *
 * @param {Array<{ id: string, state: 'ok'|'warn'|'unknown', text: string }>} findings
 * @param {{ ignore?: string[] }} [opts] finding ids to leave out
 * @returns {{ state: 'ok'|'warn'|'unknown', note: string }}
 */
export function reduceFindings(findings, { ignore = [] } = {}) {
  // `info` is a statement about the check's limits, never a verdict.
  const kept = findings.filter((f) => !ignore.includes(f.id) && f.state !== 'info');
  if (kept.length === 0) return { state: 'unknown', note: 'the check produced no finding' };
  // On a tie the later finding wins: checks list their general findings
  // first and their most specific last.
  const worst = kept.reduce((a, b) => ((RANK[b.state] ?? 1) >= (RANK[a.state] ?? 1) ? b : a));
  return { state: worst.state, note: oneLine(worst.text) };
}

/**
 * The allowlisted switch values that are set, and whether each identity key
 * is set. Nothing else from `env` is read.
 *
 * @param {Record<string, string|undefined>} env
 */
export function settingsEnvSnapshot(env) {
  const out = {};
  for (const k of SETTINGS_ENV_ALLOWLIST) {
    if (typeof env[k] === 'string' && env[k] !== '') {
      out[k] = k === 'SUBSTRATE_URL' ? withoutCredentials(env[k]) : env[k];
    }
  }
  for (const k of SETTINGS_ENV_PRESENCE) out[k] = typeof env[k] === 'string' && env[k] !== '';
  return out;
}

// A URL can carry credentials in its userinfo or query, and the row is read
// by the whole fleet: keep only the origin and path.
function withoutCredentials(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

async function guarded(run) {
  try {
    return await run();
  } catch (err) {
    return { state: 'unknown', note: oneLine(`the check failed: ${err?.message ?? err}`) };
  }
}

/**
 * Run the four checks against the repo at `cwd`.
 *
 * @param {{ cwd: string, env: Record<string, string|undefined>, harness: string,
 *   pluginVersion: string|null, substrateUrl: string, namespace: string,
 *   fetchImpl: typeof fetch, agentKid: string|null, authWarning: string|null,
 *   pluginsDir?: string, readFile?: (p: string) => string|null,
 *   listDir?: (p: string) => string[]|null }} p
 * @returns {Promise<Record<string, unknown>>} the HostInstall check fields
 */
export async function runHostChecks({
  cwd,
  env,
  harness,
  pluginVersion,
  substrateUrl,
  namespace,
  fetchImpl,
  agentKid,
  authWarning,
  pluginsDir = join(homedir(), '.claude', 'plugins'),
  readFile = readOrNull,
  listDir = listDirsOrNull
}) {
  // The pin, .mcp.json and settings checks read Claude Code's files: its
  // marketplace clone, its project MCP config and its settings. Under another
  // harness they would judge files that harness never reads, so they record
  // nothing there, and authority and the switch snapshot still apply.
  const claudeCode = harness === 'claude-code';
  const notApplicable = Promise.resolve({ state: null, note: null });

  // The marketplace rail pins only the Claude Code plugin. The clone's own
  // freshness needs the network and stays with the audit, so it is left out
  // here rather than reported unknown on every session.
  const pin = claudeCode
    ? guarded(() =>
        reduceFindings(
          auditPin({
            pin: readMarketplacePin({
              marketplacesDir: join(pluginsDir, 'marketplaces'),
              listDir,
              readFile
            }),
            installedVersion: pluginVersion,
            compare: compareVersions
          }),
          { ignore: ['pin.freshness'] }
        )
      )
    : notApplicable;

  const mcpJson = claudeCode
    ? guarded(async () =>
        reduceFindings(
          auditMcpJson(await readMcpJsonFactsAsync(cwd, { gitTimeoutMs: GIT_TIMEOUT_MS }))
        )
      )
    : notApplicable;

  const authority = guarded(async () => {
    const capability = createCortext(namespace);
    const whoami = await probeWhoami(substrateUrl, { fetchImpl, timeoutMs: WHOAMI_TIMEOUT_MS });
    return reduceFindings(
      auditAuthority({
        whoami,
        expectedNamespaces: capability.namespaces,
        expectedCapabilities: capability.needs,
        resolvedKid: agentKid,
        selfAudit: true,
        authWarning
      }),
      // A standing caveat that a self view cannot see other identities'
      // credentials: true of every row, and not about this key.
      { ignore: ['authority.fleet'] }
    );
  });

  const settings = claudeCode
    ? guarded(() =>
        reduceFindings(
          checkSettings({
            settingsText: readFile(join(cwd, '.claude', 'settings.local.json')),
            hasProjectMcp: readFile(join(cwd, '.mcp.json')) !== null
          }).map((f, i) => ({ id: `settings.${i}`, ...f }))
        )
      )
    : notApplicable;

  const [p, m, a, s] = await Promise.all([pin, mcpJson, authority, settings]);
  return {
    pinState: p.state,
    pinNote: p.note,
    mcpJsonState: m.state,
    mcpJsonNote: m.note,
    authorityState: a.state,
    authorityNote: a.note,
    settingsState: s.state,
    settingsNote: s.note,
    settingsEnv: settingsEnvSnapshot(env)
  };
}
