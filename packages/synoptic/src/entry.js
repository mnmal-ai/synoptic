#!/usr/bin/env node
// Executable entry for the SessionStart hook. Reads the Claude Code context
// from stdin (for the cwd → project slug), runs the cold-start, prints markdown.
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentAuth, makeSignedFetch } from './agent-auth.js';
import { runColdStart } from './cold-start.js';
import { listDirsOrNull, readOrNull } from './fs-safe.js';
import { envWithLocalFallback } from './local-env.js';
import { projectSlug, sessionRoot } from './scope.js';
import { renderSessionStart } from './session-start.js';

async function readStdin(timeoutMs = 50) {
  if (process.stdin.isTTY) return '';
  return await new Promise((resolve) => {
    let data = '';
    const t = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

function resolveCwd(stdinRaw) {
  try {
    const ctx = JSON.parse(stdinRaw || '{}');
    return ctx.cwd || ctx.workspace?.cwd || process.cwd();
  } catch {
    return process.cwd();
  }
}

/**
 * The harness's session id.
 *
 * SessionStart hands the hook `{ session_id, transcript_path, cwd,
 * hook_event_name, source }` on stdin, and until now this file read `cwd` and
 * discarded the rest. The id is what lets concurrent sessions sharing one
 * repo-scoped kid tell each other apart; see src/session.js.
 */
function resolveSessionId(stdinRaw) {
  try {
    const ctx = JSON.parse(stdinRaw || '{}');
    return ctx.session_id ?? ctx.sessionId ?? null;
  } catch {
    return null;
  }
}

/**
 * The installed plugin's own directory.
 *
 * Derived from `import.meta.url` rather than `CLAUDE_PLUGIN_ROOT`: the harness
 * expands that variable into the hook's COMMAND STRING, which does not
 * guarantee it in `process.env`. This file is bundled to
 * `<pluginRoot>/hooks/cold-start.mjs`, so its own directory's parent is the
 * root. The env var stays as an override for anyone running the hook by hand.
 */
function resolvePluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return null;
  }
}

/**
 * The plugin cache directory, so the staleness check can compare against the
 * BEST fragment on this machine rather than the one this session was served.
 * Derived from the plugin root, which sits inside it as
 * `<cache>/<version>/`.
 */
function resolveCacheDir(pluginRoot) {
  if (pluginRoot === null) return null;
  const parent = dirname(pluginRoot);
  return basename(parent) === 'cortext' ? parent : null;
}

/** The plugin version that served this session, or null. Never throws. */
function servedPluginVersion(root) {
  if (root === null) return null;
  try {
    return (
      JSON.parse(readOrNull(join(root, '.claude-plugin', 'plugin.json')) ?? 'null')?.version ?? null
    );
  } catch {
    return null;
  }
}

const stdinRaw = await readStdin();
// Agent-identity signing: when SUBSTRATE_AGENT_KEY_PATH +
// SUBSTRATE_AGENT_KEY_ID are configured, every hook read carries the agent JWT —
// read-gated deployments keep their cold-start. Unconfigured = anonymous
// (the supported open mode); misconfigured = anonymous + visible warning.
// The launching shell is not the identity carrier (see local-env.js):
// settings `env` reaches hook processes but never feeds `.mcp.json`
// expansion, so fill gaps repo-locally instead. Process env always wins.
// The repo root, not the directory the session started in: project scope,
// settings and the conventions fragment all live at the root.
const startDir = resolveCwd(stdinRaw);
const cwd = sessionRoot(startDir);
const { env } = envWithLocalFallback(process.env, { targetDir: cwd });
const auth = createAgentAuth(env);
// The shared budget, byte cap and never-throw wrapper. This entry had
// none of them, and the manifest timeout was 5000 SECONDS, so a slow Substrate
// held session start for as long as the slowest serial chain took.
process.stdout.write(
  await renderSessionStart({
    render: () =>
      runColdStart({
        substrateUrl: env.SUBSTRATE_URL,
        namespace: env.SUBSTRATE_NAMESPACE ?? 'cortext',
        projectSlug: projectSlug(cwd, env),
        nowMs: Date.now(),
        fetchImpl: makeSignedFetch(auth.getAuthHeader),
        // The kid from the OVERLAID env, not runColdStart's `process.env` default —
        // otherwise a settings-only identity signs but never finds its own inbox.
        agentKid: env.SUBSTRATE_AGENT_KEY_ID,
        // Local-filesystem facts, so they surface even when Substrate is unreachable.
        cwd,
        pluginRoot: resolvePluginRoot(),
        readFile: readOrNull,
        listDir: listDirsOrNull,
        cacheDir: resolveCacheDir(resolvePluginRoot()),
        sessionId: resolveSessionId(stdinRaw),
        pluginVersion: servedPluginVersion(resolvePluginRoot()),
        harness: 'claude-code',
        hostReport: env.SYNOPTIC_HOST_REPORT !== 'off',
        env,
        authWarning: auth.warning ?? null
      }),
    env,
    authWarning: auth.warning ?? null
  })
);
