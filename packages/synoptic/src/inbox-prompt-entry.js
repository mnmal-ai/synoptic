#!/usr/bin/env node
// UserPromptSubmit executable: stdout (exit 0) is injected as context — one
// compact line per unread message, nothing when the inbox is clear. See
// ./inbox-hooks.js.
import { createAgentAuth, makeSignedFetch } from './agent-auth.js';
import { promptHookContext } from './inbox-hooks.js';
import { envWithLocalFallback } from './local-env.js';
import { sessionRoot } from './scope.js';

try {
  const { env } = envWithLocalFallback(process.env, { targetDir: sessionRoot(process.cwd()) });
  const auth = createAgentAuth(env);
  // STDERR, not stdout. Stdout here is injected as context on EVERY
  // prompt submit, so the cold-start's visible-comment treatment would repeat
  // the same warning into every turn of the session. Stderr says it once per
  // fire, where a harness surfaces it without spending context.
  if (auth.warning !== null) process.stderr.write(auth.warning);
  const out = await promptHookContext({
    env,
    fetchImpl: makeSignedFetch(auth.getAuthHeader)
  });
  if (out !== '') process.stdout.write(out);
} catch {
  // Any failure = no context. Never block the prompt.
}
