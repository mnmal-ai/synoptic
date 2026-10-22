// Repo-local env fallback — the shell is not the carrier.
//
// `${VAR}` refs in a project `.mcp.json` expand from the shell that launched
// the harness, and from nowhere else (a variable defined in `.claude/settings.local.json` `env` reaches
// MCP server processes and the Bash tool, but is NEVER a source for `${}`
// expansion). So a fully-indirected `.mcp.json` — the portable form — can only
// resolve when the launching shell exports every variable, which pushes
// identity into EVERY shell under the tree, agent or not.
//
// The way out is to stop depending on expansion. Settings `env` IS inherited
// by hook processes, so a hook that reads its own fallback does not need the
// launching shell to carry anything: process env wins when present (operator
// boxes, CI, daemons where the env is genuinely correct), and the repo's own
// `.claude/settings.local.json` fills the gaps per repo, per machine,
// uncommitted. A plain shell then carries no identity at all, which is the
// correct answer for a shell running no session.
//
// Only the `LOCAL_ENV_KEYS` allowlist below (named `SUBSTRATE_*` and
// `SYNOPTIC_*` keys) is ever picked up — a hook must not slurp arbitrary
// settings env (notably never `PATH`) into its own process. Values must be
// non-empty strings. A missing file, an unparsable file, or a missing `env`
// object all mean "no fallback", never a throw: hooks never block a session.

import { join } from 'node:path';
import { readOrNull } from './fs-safe.js';

/** Settings keys a hook may inherit repo-locally. Everything else stays shell-only. */
export const LOCAL_ENV_KEYS = [
  'SUBSTRATE_URL',
  'SUBSTRATE_NAMESPACE',
  'SUBSTRATE_AGENT_KEY_ID',
  'SUBSTRATE_AGENT_KEY_PATH',
  'SUBSTRATE_AGENT_CAPABILITIES',
  'SYNOPTIC_AGENT_NAMESPACES',
  'SYNOPTIC_PROJECT_SCOPE',
  'SYNOPTIC_COLD_START_MAX_BYTES',
  'SYNOPTIC_INBOX_STOP_CHECK',
  'SYNOPTIC_INBOX_PROMPT_CHECK',
  'SYNOPTIC_INBOX_PUSH',
  'SYNOPTIC_INBOX_WAKE',
  'SYNOPTIC_INBOX_URGENT_FROM'
];

/**
 * The repo-local env overlay: `{ env, source }`.
 *
 * @param {{ targetDir: string, readFile?: (path: string) => string|null }} p
 * @returns {{ env: Record<string,string>, source: string|null }}
 *   `source` is the settings path the overlay came from, or null when there
 *   is none (absent/unparsable/no env object — all the same observation).
 */
export function readLocalEnv({ targetDir, readFile = readOrNull }) {
  const source = join(targetDir, '.claude', 'settings.local.json');
  let raw = null;
  try {
    raw = readFile(source);
  } catch {
    return { env: {}, source: null };
  }
  if (raw === null) return { env: {}, source: null };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { env: {}, source: null };
  }
  const block = parsed?.env;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    return { env: {}, source: null };
  }
  const env = {};
  for (const key of LOCAL_ENV_KEYS) {
    const v = block[key];
    if (typeof v === 'string' && v !== '') env[key] = v;
  }
  return { env, source: Object.keys(env).length === 0 ? null : source };
}

/**
 * Merge process env over the repo-local overlay. Process env always wins —
 * an explicitly exported value is a choice, and the fallback must never
 * silently replace one.
 *
 * @param {Record<string,string|undefined>} processEnv
 * @param {{ targetDir: string, readFile?: (path: string) => string|null }} p
 * @returns {{ env: Record<string,string|undefined>, source: string|null, filled: string[] }}
 *   `filled` names the keys the overlay supplied, so callers can report it.
 */
export function envWithLocalFallback(processEnv, { targetDir, readFile = readOrNull }) {
  const { env: local, source } = readLocalEnv({ targetDir, readFile });
  if (source === null) return { env: processEnv, source: null, filled: [] };
  const env = { ...processEnv };
  const filled = [];
  for (const [k, v] of Object.entries(local)) {
    if (env[k] === undefined || env[k] === '') {
      env[k] = v;
      filled.push(k);
    }
  }
  return { env, source, filled: filled.length === 0 ? [] : filled };
}
