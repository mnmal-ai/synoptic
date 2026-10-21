#!/usr/bin/env node
// Stop-hook executable: blocks the stop once (JSON decision on stdout) when
// unread agent mail exists; silent allow otherwise. See ./inbox-hooks.js.
import { createAgentAuth, makeSignedFetch } from './agent-auth.js';
import { readHookStdin } from './hook-io.js';
import { stopHookDecision } from './inbox-hooks.js';
import { envWithLocalFallback } from './local-env.js';
import { sessionRoot } from './scope.js';

try {
  const input = await readHookStdin();
  const start = typeof input?.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  const { env } = envWithLocalFallback(process.env, { targetDir: sessionRoot(start) });
  const auth = createAgentAuth(env);
  // STDERR, not stdout — this hook's stdout is a JSON decision the
  // harness parses, so a warning prepended there is a parse error rather than a
  // message. The no-throw contract in agent-auth.js promises a configured-and-
  // broken key degrades VISIBLY; without this the inbox simply stops rendering
  // under a read-gated deployment and nothing says why.
  if (auth.warning !== null) process.stderr.write(auth.warning);
  const out = await stopHookDecision({
    input,
    env,
    fetchImpl: makeSignedFetch(auth.getAuthHeader)
  });
  if (out !== null) process.stdout.write(out);
} catch {
  // Any failure = allow the stop. A hook bug must never wedge a session.
}
