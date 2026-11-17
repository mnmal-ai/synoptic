// Cortext — the OMP (oh-my-pi) skin for the cortext coordination capability.
//
// OMP loads this module as an extension (`"omp": { "extensions": [...] }` in
// package.json, or `omp -e <dir>`) and calls the default export with its
// ExtensionAPI. Two seams, the same ones the other skins have:
// - `before_agent_start` appends the synoptic cold-start to the system prompt.
//   OMP hands each preparation the BASE prompt and takes the returned array as
//   the replacement, chaining extensions in order, so appending on every
//   prompt never accumulates. Later prompts also carry the one-line inbox
//   summary; the first does not, because the cold-start renders ## Inbox.
// - `session_stop` (OMP's Stop hook, main agent only) continues the turn once
//   with the unread-mail reason. `stop_hook_active` bounds it to one
//   continuation per user prompt, and each message id nudges only once.
//
// Not here yet: the push watcher (mid-turn mail), the conventions text (about
// 6k tokens, more than a small local model's whole first call), commands and
// tools. Identity and endpoint come from the launching env: SUBSTRATE_URL,
// SUBSTRATE_NAMESPACE, SUBSTRATE_AGENT_KEY_ID and SUBSTRATE_AGENT_KEY_PATH.
// Every handler swallows its own failure: the worst case is a session with no
// injected context, which is OMP without this extension.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentAuth, makeSignedFetch } from '../../synoptic/src/agent-auth.js';
import { runColdStart, truncateToBudget } from '../../synoptic/src/cold-start.js';
import { readOrNull } from '../../synoptic/src/fs-safe.js';
import { inboxStopNudge, promptHookContext } from '../../synoptic/src/inbox-hooks.js';
import { projectSlug, sessionRoot } from '../../synoptic/src/scope.js';
import { parseMaxBytes, SESSION_START_BUDGET_MS } from '../../synoptic/src/session-start.js';

/** The slice of OMP's ExtensionAPI this skin uses, typed locally so the
 *  build needs no OMP package (it ships TS source that imports Bun). */
export type OmpContext = { cwd: string; sessionManager: { getSessionId(): string } };
type BeforeAgentStart = { reason: 'prompt' | 'revive'; systemPrompt: string[] };
type SessionStop = { stop_hook_active: boolean };
type StopResult = { continue: true; additionalContext: string };
export type OmpApi = {
  on(
    event: 'before_agent_start',
    handler: (
      event: BeforeAgentStart,
      ctx: OmpContext
    ) => Promise<{ systemPrompt: string[] } | undefined>
  ): void;
  on(
    event: 'session_stop',
    handler: (event: SessionStop, ctx: OmpContext) => Promise<StopResult | undefined>
  ): void;
};

/** An inbox read at a prompt or a stop loses its line, never the turn. */
const INBOX_TIMEOUT_MS = 3000;

const NUDGE_HEADER =
  '[Automated end-of-turn check by the cortext extension. This is NOT a message from the user.]';

/** Recorded in HostInstall. dist/extension.js sits one level below package.json. */
const OWN_VERSION: string | null = (() => {
  try {
    const raw = readOrNull(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
    return raw === null ? null : ((JSON.parse(raw) as { version?: string }).version ?? null);
  } catch {
    return null;
  }
})();

function offlineNote(env: NodeJS.ProcessEnv): string {
  if (!env.SUBSTRATE_URL) return '<!-- synoptic cold-start skipped: SUBSTRATE_URL not set -->\n';
  return '<!-- synoptic cold-start unavailable (timeout or unreachable Substrate) -->\n';
}

/** `work`, or `fallback` when it fails or outlasts `ms`. Never rejects. */
function bounded<T>(work: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  const run = Promise.resolve()
    .then(work)
    .catch(() => fallback);
  return Promise.race([run, gate]).finally(() => clearTimeout(timer));
}

function access(env: NodeJS.ProcessEnv) {
  const auth = createAgentAuth(env, undefined);
  return { env, auth, fetchImpl: makeSignedFetch(auth.getAuthHeader) as typeof fetch };
}

async function renderColdStart(
  env: NodeJS.ProcessEnv,
  cwd: string,
  sessionId: string
): Promise<string> {
  const { auth, fetchImpl } = access(env);
  // The repo root, not the directory OMP started in: project scope lives there.
  const root = sessionRoot(cwd);
  const doc = await runColdStart({
    substrateUrl: env.SUBSTRATE_URL,
    namespace: env.SUBSTRATE_NAMESPACE ?? 'cortext',
    projectSlug: projectSlug(root, env),
    nowMs: Date.now(),
    fetchImpl,
    agentKid: env.SUBSTRATE_AGENT_KEY_ID ?? null,
    cwd: root,
    pluginRoot: null,
    readFile: readOrNull,
    listDir: null,
    cacheDir: null,
    sessionId,
    pluginVersion: OWN_VERSION,
    harness: 'omp',
    tasks: true,
    hostReport: env.SYNOPTIC_HOST_REPORT !== 'off',
    env,
    authWarning: auth.warning ?? null
  });
  // It rides in the system prompt of every request, so the byte cap matters.
  return truncateToBudget(
    (auth.warning ?? '') + doc,
    parseMaxBytes(env.SYNOPTIC_COLD_START_MAX_BYTES)
  );
}

export default function cortext(pi: OmpApi, env: NodeJS.ProcessEnv = process.env): void {
  // A promise per session, so overlapping preparations share one render.
  const renders = new Map<string, Promise<string>>();
  const nudged = new Map<string, Set<string>>();

  pi.on('before_agent_start', async (event, ctx) => {
    try {
      // A revived subagent's result is discarded.
      if (event.reason !== 'prompt') return undefined;
      const id = ctx.sessionManager.getSessionId();
      let doc = renders.get(id);
      const later = doc !== undefined;
      if (doc === undefined) {
        doc = bounded(
          () => renderColdStart(env, ctx.cwd, id),
          SESSION_START_BUDGET_MS,
          offlineNote(env)
        );
        renders.set(id, doc);
      }
      const parts = [await doc];
      if (later)
        parts.push(await bounded(() => promptHookContext(access(env)), INBOX_TIMEOUT_MS, ''));
      const add = parts.filter((p) => p.length > 0);
      return add.length > 0 ? { systemPrompt: [...event.systemPrompt, ...add] } : undefined;
    } catch {
      return undefined;
    }
  });

  pi.on('session_stop', async (event, ctx) => {
    try {
      if (event.stop_hook_active) return undefined;
      const nudge = await bounded(() => inboxStopNudge(access(env)), INBOX_TIMEOUT_MS, null);
      if (nudge === null) return undefined;
      const id = ctx.sessionManager.getSessionId();
      const done = nudged.get(id) ?? new Set<string>();
      if (nudge.ids.every((m: string) => done.has(m))) return undefined;
      for (const m of nudge.ids) done.add(m);
      nudged.set(id, done);
      return { continue: true, additionalContext: `${NUDGE_HEADER}\n${nudge.reason}` };
    } catch {
      return undefined;
    }
  });
}
