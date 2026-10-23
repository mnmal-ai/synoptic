import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { findRepoRoot } from '../../synoptic/src/repo-root.js';

export const CONFIG_PATH = '.codex/cortext.local.json';
const IDENTITY_KEYS = ['SUBSTRATE_AGENT_KEY_ID', 'SUBSTRATE_AGENT_KEY_PATH'];
const LOCAL_KEYS = new Set([
  'SUBSTRATE_URL',
  'SUBSTRATE_NAMESPACE',
  ...IDENTITY_KEYS,
  'SUBSTRATE_AGENT_CAPABILITIES',
  'SYNOPTIC_AGENT_NAMESPACES',
  'SYNOPTIC_PROJECT_SCOPE',
  'SYNOPTIC_COLD_START_MAX_BYTES',
  'SYNOPTIC_HOST_REPORT',
  'SYNOPTIC_INBOX_STOP_CHECK',
  'SYNOPTIC_INBOX_PROMPT_CHECK'
]);

/** Whether git tracks `rel` in the repo at `cwd`. False outside a repo or without git. */
export function gitTracks(cwd, rel) {
  const r = spawnSync('git', ['-C', cwd, 'ls-files', '--error-unmatch', '--', rel], {
    stdio: 'ignore',
    timeout: 2000
  });
  return r.status === 0;
}

/**
 * One settings source for hooks and MCP. Never read another harness's identity.
 *
 * The file names the executable the MCP launcher spawns and the URL signed
 * requests go to, so it must be machine-local: a copy committed to a repo
 * would let any checkout choose both. A tracked file is refused.
 */
export function loadConfig(
  startDir,
  processEnv = process.env,
  readFile = readFileSync,
  isTracked = gitTracks
) {
  const cwd = findRepoRoot(startDir) ?? startDir;
  const path = join(cwd, CONFIG_PATH);
  let config = {};
  try {
    config = JSON.parse(readFile(path, 'utf8'));
    if (isTracked(cwd, CONFIG_PATH)) {
      throw Object.assign(
        new Error(`${CONFIG_PATH} is tracked by git; it must stay untracked (git rm --cached it)`),
        { code: 'TRACKED' }
      );
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    if (
      config.env !== undefined &&
      (!config.env || typeof config.env !== 'object' || Array.isArray(config.env))
    ) {
      throw new Error();
    }
  } catch (error) {
    if (error.code === 'TRACKED') throw error;
    if (error.code !== 'ENOENT') throw new Error('Invalid .codex/cortext.local.json settings');
  }
  const env = { ...processEnv };
  // Never combine a process kid with a settings key, or vice versa.
  const processIdentity = IDENTITY_KEYS.some((key) => processEnv[key] !== undefined);
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (!LOCAL_KEYS.has(key)) continue;
    if (typeof value !== 'string') throw new Error(`Cortext setting ${key} must be a string`);
    if (processIdentity && IDENTITY_KEYS.includes(key)) continue;
    if (env[key] === undefined) env[key] = value;
  }
  if (env.SUBSTRATE_AGENT_KEY_PATH && !isAbsolute(env.SUBSTRATE_AGENT_KEY_PATH)) {
    throw new Error('SUBSTRATE_AGENT_KEY_PATH must be an absolute file path');
  }
  return { cwd, env, mcp: config.mcp ?? null };
}

export function mcpInvocation(config) {
  const { env, mcp } = config;
  if (!env.SUBSTRATE_URL || !env.SUBSTRATE_AGENT_KEY_ID || !env.SUBSTRATE_AGENT_KEY_PATH) {
    throw new Error(
      'Cortext MCP requires SUBSTRATE_URL and a Codex signing identity; run $cortext:substrate-setup'
    );
  }
  if (
    !mcp ||
    typeof mcp.command !== 'string' ||
    !isAbsolute(mcp.command) ||
    !Array.isArray(mcp.args) ||
    mcp.args.some((arg) => typeof arg !== 'string')
  ) {
    throw new Error(
      'Set mcp.command to an absolute installed executable and mcp.args to its arguments'
    );
  }
  return { command: mcp.command, args: mcp.args, cwd: config.cwd, env };
}
