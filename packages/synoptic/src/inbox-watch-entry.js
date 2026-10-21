#!/usr/bin/env node
// Inbox push watcher: one SSE subscription on this session's
// unread inbox, NDJSON events on stdout for the cortext hooks module. Signs as
// the session's own kid; never acks, marks read or sends. Warnings go to
// STDERR — stdout is the event stream the bridge parses.
import { createAgentAuth, makeSignedFetch } from './agent-auth.js';
import { runWatcher } from './inbox-watch.js';
import { envWithLocalFallback } from './local-env.js';
import { sessionRoot } from './scope.js';

const i = process.argv.indexOf('--since');
const v = i !== -1 ? process.argv[i + 1] : undefined;
const since =
  v !== undefined && !v.startsWith('--') && !Number.isNaN(Date.parse(v))
    ? v
    : new Date(0).toISOString();
const { env } = envWithLocalFallback(process.env, { targetDir: sessionRoot(process.cwd()) });
const auth = createAgentAuth(env);
if (auth.warning !== null) process.stderr.write(auth.warning);

await runWatcher({
  env,
  since,
  fetchImpl: makeSignedFetch(auth.getAuthHeader),
  emit: (e) => process.stdout.write(`${JSON.stringify(e)}\n`),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms))
}).catch((err) => {
  process.stderr.write(`inbox-watch: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.stdout.write(
    `${JSON.stringify({ type: 'status', state: 'disabled', reason: 'crashed' })}\n`
  );
});
// Exit through the write callback so the final status line has flushed (async pipes).
process.stdout.write('', () => process.exit(0));
