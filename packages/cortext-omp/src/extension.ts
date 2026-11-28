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
// - agent mail is pushed as it arrives (inbox-push.ts): steered into a turn
//   in progress, or with SYNOPTIC_INBOX_WAKE=on, a turn is started in an idle
//   session. SYNOPTIC_INBOX_PUSH=off turns the watcher off.
//
// - `session_before_compact` (every compaction, mid-turn included) saves the
//   steps being compacted away as an ExecutionCheckpoint and replaces OMP's
//   summary with a pointer at it. With no acknowledged write, OMP compacts as
//   it would without us.
//
// Not here yet: the conventions text (about
// 6k tokens, more than a small local model's whole first call), commands and
// tools. Identity and endpoint come from the launching env: SUBSTRATE_URL,
// SUBSTRATE_NAMESPACE, SUBSTRATE_AGENT_KEY_ID and SUBSTRATE_AGENT_KEY_PATH.
// Every handler swallows its own failure: the worst case is a session with no
// injected context, which is OMP without this extension.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentAuth, makeSignedFetch } from '../../synoptic/src/agent-auth.js';
import { autoRecallContext } from '../../synoptic/src/auto-recall.js';
import { runColdStart, truncateToBudget } from '../../synoptic/src/cold-start.js';
import { readOrNull } from '../../synoptic/src/fs-safe.js';
import { inboxStopNudge, promptHookContext } from '../../synoptic/src/inbox-hooks.js';
import { projectSlug, sessionRoot } from '../../synoptic/src/scope.js';
import { parseMaxBytes, SESSION_START_BUDGET_MS } from '../../synoptic/src/session-start.js';
import {
  buildCheckpoint,
  type Entry,
  lastRequest,
  type Message,
  mergeSteps,
  renderPointer,
  type Step,
  saveCheckpoint,
  type TaskRef
} from './checkpoint.js';
import { type SendMessage, startInboxPush } from './inbox-push.js';

/** The slice of OMP's ExtensionAPI this skin uses, typed locally so the
 *  build needs no OMP package (it ships TS source that imports Bun). */
export type OmpContext = { cwd: string; sessionManager: { getSessionId(): string } };
type BeforeAgentStart = { reason: 'prompt' | 'revive'; prompt?: string; systemPrompt: string[] };
type SessionStop = { stop_hook_active: boolean };
type StopResult = { continue: true; additionalContext: string };
type BeforeCompact = {
  preparation: {
    firstKeptEntryId: string;
    tokensBefore: number;
    messagesToSummarize: Message[];
    turnPrefixMessages: Message[];
  };
  branchEntries: Entry[];
};
type CompactResult = {
  compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number };
};
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
  on(
    event: 'session_before_compact',
    handler: (event: BeforeCompact, ctx: OmpContext) => Promise<CompactResult | undefined>
  ): void;
  on(event: 'session_shutdown', handler: () => Promise<void> | void): void;
  sendMessage?: SendMessage;
  getActiveTools?: () => string[];
};

/** An inbox read at a prompt or a stop loses its line, never the turn. */
const INBOX_TIMEOUT_MS = 3000;

/** Under OMP's 30 s handler timeout, with room for the fallback to start. */
const SAVE_TIMEOUT_MS = 20_000;

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

/**
 * Leads the cold-start: small models abandon a tool after one rejected call.
 * `act` is named only when the session has it (OMP calls it `mcp__substrate_act`),
 * so a session without the tool is never told to use it.
 */
export function substrateAccessLine(toolNames: readonly unknown[]): string {
  const act = toolNames.some((n) => typeof n === 'string' && /substrate.*_act$/.test(n));
  return (
    `Substrate access: use only the substrate MCP tools (${act ? 'act, ' : ''}query, mutate, recall, schema, run). ` +
    (act
      ? 'For context-store writes and simple lookups use act first, with a short sketch: ' +
        '`close Todo #12`, `create Todo title="…" area=x priority=high project=<repo>`, ' +
        "`find Todo status=open fields=title`. `? Todo` lists a type's actions. "
      : '') +
    'When a call is rejected, read the error, fix the payload and call the same tool again. ' +
    'Never import the Substrate SDK, read a key file or hand-sign HTTP requests.\n\n'
  );
}

/** The session's tool names, or none when OMP does not say. */
function toolNames(pi: OmpApi): readonly unknown[] {
  try {
    const names = pi.getActiveTools?.();
    return Array.isArray(names) ? names : [];
  } catch {
    return [];
  }
}

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
  sessionId: string,
  tools: readonly unknown[]
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
    // readFile feeds only Claude Code checks (the .claude/ fragment and
    // CLAUDE.md imports), which are noise to an OMP session.
    readFile: null,
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
    (auth.warning ?? '') + substrateAccessLine(tools) + doc,
    parseMaxBytes(env.SYNOPTIC_COLD_START_MAX_BYTES)
  );
}

export default function cortext(pi: OmpApi, env: NodeJS.ProcessEnv = process.env): void {
  // A promise per session, so overlapping preparations share one render.
  const renders = new Map<string, Promise<string>>();
  const nudged = new Map<string, Set<string>>();
  // Memory rows already shown by the automatic recall, per session.
  const recalled = new Map<string, Set<string>>();
  // shortcut: the session's Task lives in memory, so a restarted OMP opens a new Task; persist it in the session if that proves noisy.
  const tasks = new Map<string, TaskRef>();
  // Every step compacted so far, per session, so each pointer carries them all.
  const history = new Map<string, Step[]>();
  const compactOn = env.SYNOPTIC_OMP_COMPACT !== 'off';

  let stopPush = () => {};
  try {
    const send = pi.sendMessage?.bind(pi);
    if (send) stopPush = startInboxPush(send, access(env));
  } catch {
    // No push: the prompt summary and the stop check still surface mail.
  }
  pi.on('session_shutdown', () => stopPush());

  pi.on('before_agent_start', async (event, ctx) => {
    try {
      // A revived subagent's result is discarded.
      if (event.reason !== 'prompt') return undefined;
      const id = ctx.sessionManager.getSessionId();
      let doc = renders.get(id);
      const later = doc !== undefined;
      if (doc === undefined) {
        doc = bounded(
          () => renderColdStart(env, ctx.cwd, id, toolNames(pi)),
          SESSION_START_BUDGET_MS,
          offlineNote(env)
        );
        renders.set(id, doc);
      }
      const parts = [await doc];
      if (later)
        parts.push(await bounded(() => promptHookContext(access(env)), INBOX_TIMEOUT_MS, ''));
      const seen = recalled.get(id) ?? new Set<string>();
      recalled.set(id, seen);
      parts.push(
        await autoRecallContext({
          env,
          prompt: event.prompt,
          project: projectSlug(sessionRoot(ctx.cwd), env),
          fetchImpl: access(env).fetchImpl,
          seen
        })
      );
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

  pi.on('session_before_compact', async (event, ctx) => {
    try {
      if (!compactOn || !env.SUBSTRATE_URL) return undefined;
      const { preparation } = event;
      const cp = buildCheckpoint([
        ...preparation.messagesToSummarize,
        ...preparation.turnPrefixMessages
      ]);
      if (cp === null) return undefined;
      const id = ctx.sessionManager.getSessionId();
      const request = lastRequest(event.branchEntries);
      // Appended whether or not this save lands: the steps happened either way.
      const all = mergeSteps(history.get(id) ?? [], cp.steps);
      history.set(id, all);
      const namespace = env.SUBSTRATE_NAMESPACE ?? 'cortext';
      const saved = await bounded(
        () =>
          saveCheckpoint(
            {
              substrateUrl: env.SUBSTRATE_URL as string,
              namespace,
              project: projectSlug(sessionRoot(ctx.cwd), env) ?? null,
              fetchImpl: access(env).fetchImpl
            },
            tasks.get(id) ?? null,
            cp,
            // Not the request: a Task title is readable by every agent in the namespace.
            `OMP session ${id.slice(0, 8)}`
          ),
        SAVE_TIMEOUT_MS,
        null
      );
      if (saved === null) return undefined;
      tasks.set(id, saved.task);
      return {
        compaction: {
          summary: renderPointer(saved.task, saved.revision, request, all, cp.note),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore
        }
      };
    } catch {
      return undefined;
    }
  });
}
