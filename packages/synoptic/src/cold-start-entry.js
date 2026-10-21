#!/usr/bin/env node
// SessionStart-hook executable: prints the cold-start document (Concepts /
// Agent Memory / Open Work / Agent Rules / Inbox) for stdout injection as
// session context. Harness-neutral companion to inbox-stop-entry.js and
// inbox-prompt-entry.js: stdin supplies cwd/session_id, env supplies
// SUBSTRATE_URL + identity. Never throws, never blocks session start — without a
// URL it prints the offline note runColdStart renders, and a slow Substrate loses
// a 9s race to the same degrade (renderSessionStart, shared with the Claude
// Code entry).
import { createAgentAuth, makeSignedFetch } from './agent-auth.js';
import { runColdStart } from './cold-start.js';
import { readOrNull } from './fs-safe.js';
import { readHookStdin } from './hook-io.js';
import { entryHarness } from './host-install.js';
import { envWithLocalFallback } from './local-env.js';
import { projectSlug, sessionRoot } from './scope.js';
import { renderSessionStart } from './session-start.js';

try {
  const input = await readHookStdin();
  const startDir = typeof input?.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  // The repo root, not the directory the session started in: project scope,
  // settings and the conventions fragment all live at the root.
  const cwd = sessionRoot(startDir);
  // The launching shell is not the identity carrier: settings `env` reaches
  // hook processes but never feeds `.mcp.json` expansion, so a hook that read
  // only process.env would need the mise `[env]` hammer to function. Fill
  // gaps repo-locally instead. Process env always wins when it is set.
  const { env } = envWithLocalFallback(process.env, { targetDir: cwd });
  const auth = createAgentAuth(env);
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
          cwd,
          pluginRoot: null,
          readFile: readOrNull,
          listDir: null,
          cacheDir: null,
          sessionId: typeof input?.session_id === 'string' ? input.session_id : null,
          // The launcher names its harness, so HostInstall says which one ran.
          harness: entryHarness(env.SYNOPTIC_HARNESS),
          hostReport: env.SYNOPTIC_HOST_REPORT !== 'off',
          env,
          authWarning: auth.warning ?? null
        }),
      env,
      authWarning: auth.warning ?? null
    })
  );
} catch {
  // Any failure = session starts without injected context (the state of a
  // session with no hook at all). Never block session start.
}
