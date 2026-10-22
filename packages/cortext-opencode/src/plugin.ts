// Cortext — the OpenCode skin for the cortext coordination capability.
//
// Claude Code delivers the synoptic cold-start through a SessionStart hook.
// OpenCode 1.x has no session-start injection point; the nearest equivalents
// are the `session.created` bus event (notification-only) and
// `experimental.chat.system.transform` (runs before every model dispatch and
// CAN append to the system prompt). OpenCode 2.x replaces that whole surface:
// plugins default-export `Plugin.define({ id, setup })` from
// `@opencode/plugin` and register `ctx.session.hook("context" | "prompt" |
// "compaction")` instead of returning a string-keyed hooks map (V1
// implementations do not run in V2).
//
// So this skin ships BOTH entrypoints from one default export (the documented
// dual-support shape — V1 calls `server()`, V2 calls `setup()`):
// - V2 (primary): prewarms on the `prompt` hook and injects once per session
//   via the `context` hook, pushing `{ type: "text", text: doc }` onto
//   `event.system` (V2 system parts are objects, not strings). Compaction
//   drops the cached render so the next dispatch rebuilds it.
// - V1 (compat, OpenCode >=1.18.29 object entrypoints): the original
//   `session.created` prewarm + `experimental.chat.system.transform` inject.
//
// Both entrypoints share one store: the injected document is the same
// `runColdStart` render the Claude hook prints — Concepts, Agent Memory,
// Open Work, Agent Rules, Inbox — so the two skins read the same store the
// same way.
//
// Design constraints, all deliberate:
// - Never throw, never break dispatch. Every handler is wrapped; the worst
//   case is a session with no injected context, which is exactly the state
//   of an OpenCode session without this plugin.
// - Zero runtime deps. The synoptic host is bundled in (tsdown alwaysBundle),
//   the `@opencode-ai/plugin` import is type-only and `@opencode/plugin`'s
//   `define` is an identity function tsdown inlines. What the consumer
//   installs is one self-contained file.
// - Env-driven, like the Claude hooks: SUBSTRATE_URL, SUBSTRATE_NAMESPACE (default
//   `cortext`), SYNOPTIC_PROJECT_SCOPE=all (cross-project), SUBSTRATE_AGENT_*
//   signing. Unconfigured reads degrade to the offline
//   note `runColdStart` renders — never an exception.
// - V2 identity also comes from plugin config: an object plugin entry
//   `{ package, options: { kid, key } }` in opencode.json(c) delivers
//   `ctx.options`, which wins over the SUBSTRATE_AGENT_* env pair — the
//   per-project identity a shared process env cannot carry. Absent
//   options fall back to env, so anonymous mode and existing setups
//   keep working.
//
// Inbox seams (V2 only), the same two the Claude and Codex skins have:
// - Each later prompt re-reads unread mail and every dispatch of that turn
//   carries the same one-line summary as UserPromptSubmit. The first prompt
//   is skipped, because the cold-start already renders ## Inbox.
// - When a turn succeeds with unread mail, one synthetic queued message with
//   the Stop hook's reason resumes the session. At most once per user prompt,
//   the same bound as Claude's `stop_hook_active` (one continuation per stop
//   chain), so mail alone can never keep a session working unattended. Each
//   message id also nudges only once.
// SYNOPTIC_INBOX_PROMPT_CHECK / SYNOPTIC_INBOX_STOP_CHECK = 'off' disable them.
//
// Inbox push (V2 only): the shared SSE watcher runs in-process and
// `inbox-bridge.ts` steers new mail into every busy session, preempts the
// most recently prompted one for allowlisted urgent mail
// (SYNOPTIC_INBOX_URGENT_FROM), and wakes it when idle only with
// SYNOPTIC_INBOX_WAKE=on. SYNOPTIC_INBOX_PUSH=off disables it. While the watcher
// is live the per-prompt summary is skipped (D2); the end-of-turn nudge stays.
//
// Known gaps vs the Claude skin (README tracks these):
// - V1 has no inbox seams and no push.
// - No conventions-fragment drift check: `fragmentDriftWarning` reads the
//   `.claude/` install path, which does not exist for OpenCode consumers.
//   Body-sync between the two skins' copies is enforced at build time by
//   `test/instructions-sync.test.ts` instead.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Deep import: the `@opencode/plugin` root barrel re-exports the schema
// packages (effect, @opencode/schema) and tsdown's alwaysBundle would inline
// all of them (~500kB). `define` itself is dependency-free (identity), so
// import it — and the Context type — from its own module to keep the shipped
// artifact at zero runtime deps.
import {
  define as definePlugin,
  type Context as PluginContext
} from '@opencode/plugin/promise/plugin';
import type { Plugin as V1Plugin } from '@opencode-ai/plugin';
import { createAgentAuth, makeSignedFetch } from '../../synoptic/src/agent-auth.js';
import { runColdStart, truncateToBudget } from '../../synoptic/src/cold-start.js';
import { readOrNull } from '../../synoptic/src/fs-safe.js';
import { inboxStopNudge, promptHookContext } from '../../synoptic/src/inbox-hooks.js';
import { readInboxKnobs } from '../../synoptic/src/inbox-push.js';
import { runWatcher } from '../../synoptic/src/inbox-watch.js';
import { projectSlug, sessionRoot } from '../../synoptic/src/scope.js';
import { parseMaxBytes, SESSION_START_BUDGET_MS } from '../../synoptic/src/session-start.js';
import { createInboxBridge, type InboxBridge, type WatchEvent } from './inbox-bridge.js';

/** Stable plugin id: storage scope + status/diagnostics label. */
export const PLUGIN_ID = 'cortext';

/** Upper bound for one inbox read at a prompt; a slow Substrate loses the line,
 *  never the dispatch. */
const INBOX_TIMEOUT_MS = 3000;

/** Upper bound for one cold-start render before degrading to a pointer. The
 *  same 9s budget the Claude and neutral entries use (SESSION_START_BUDGET_MS);
 *  the transform runs lazily on first dispatch. */
const COLD_START_TIMEOUT_MS = SESSION_START_BUDGET_MS;

/** Left in the compaction transcript so the summary records where live store
 *  state lives instead of trusting the snapshot. */
const COMPACTION_POINTER =
  'Synoptic cold-start rule index (binding and always-on AgentRules, plus pointers) is injected at the next dispatch; query the store rather than trusting this summary for store state.';

/** This skin's own version, recorded in HostInstall. `dist/plugin.js` sits one
 *  level below `package.json`, both in the source tree and in an npm install. */
const OWN_VERSION: string | null = (() => {
  try {
    const raw = readOrNull(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
    return raw === null ? null : ((JSON.parse(raw) as { version?: string }).version ?? null);
  } catch {
    return null;
  }
})();

/** The conventions this package ships, read once. Same location rule as
 *  OWN_VERSION: `instructions/` sits beside `dist/`. */
const PACKAGE_CONVENTIONS: string | null = readOrNull(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'instructions', 'substrate-conventions.md')
);

/**
 * The conventions text to inject for a repo, or '' when OpenCode already
 * loads the current text itself.
 *
 * The plugin ships the conventions itself, as the Codex skin does, so a repo
 * never runs on a hand-copied file nothing refreshes. A copy
 * that still matches is left to OpenCode to load; a stale one is named, and
 * the current text is injected beside it.
 */
export function conventionsFor(directory: string): string {
  if (PACKAGE_CONVENTIONS === null) return '';
  const root = sessionRoot(directory);
  const copy = readOrNull(join(root, '.opencode', 'substrate-conventions.md'));
  if (copy === PACKAGE_CONVENTIONS) return '';
  if (copy === null) return PACKAGE_CONVENTIONS;
  return (
    '<!-- .opencode/substrate-conventions.md is an older copy of these conventions; the cortext ' +
    'plugin injects the current text below. Delete that file and its "instructions" entry ' +
    'so the session stops loading both. -->\n' +
    PACKAGE_CONVENTIONS
  );
}

/** Plugin-option overrides for the connection, for a launch (a GUI, say)
 *  whose process env carries none. */
type Connection = { url?: string; ns?: string };

function connectionEnv(connection: Connection): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(connection.url ? { SUBSTRATE_URL: connection.url } : {}),
    ...(connection.ns ? { SUBSTRATE_NAMESPACE: connection.ns } : {})
  };
}

function offlineNote(env: NodeJS.ProcessEnv): string {
  if (!env.SUBSTRATE_URL) return '<!-- synoptic cold-start skipped: SUBSTRATE_URL not set -->\n';
  return '<!-- synoptic cold-start unavailable (timeout or unreachable Substrate) -->\n';
}

async function renderColdStart(opts: {
  substrateUrl: string | undefined;
  namespace: string;
  projectSlug: string | null;
  cwd: string;
  sessionId: string | null;
  env: NodeJS.ProcessEnv;
  identity: { kid?: string | null; key?: string | null };
}): Promise<string> {
  const auth = createAgentAuth(opts.env, opts.identity);
  const doc = await runColdStart({
    substrateUrl: opts.substrateUrl,
    namespace: opts.namespace,
    projectSlug: opts.projectSlug,
    nowMs: Date.now(),
    fetchImpl: makeSignedFetch(auth.getAuthHeader),
    // The kid this session signs with, so the inbox and HostInstall see the
    // identity configured in the plugin options as well as one from env.
    agentKid: opts.identity.kid ?? opts.env.SUBSTRATE_AGENT_KEY_ID,
    cwd: opts.cwd,
    pluginRoot: null,
    readFile: readOrNull,
    listDir: null,
    cacheDir: null,
    sessionId: opts.sessionId,
    pluginVersion: OWN_VERSION,
    harness: 'opencode',
    hostReport: opts.env.SYNOPTIC_HOST_REPORT !== 'off',
    // An identity set in the plugin options counts as set, as it does for
    // signing; the snapshot records only whether each key is present.
    env: {
      ...opts.env,
      ...(opts.identity.kid ? { SUBSTRATE_AGENT_KEY_ID: opts.identity.kid } : {}),
      ...(opts.identity.key ? { SUBSTRATE_AGENT_KEY_PATH: opts.identity.key } : {})
    },
    authWarning: auth.warning ?? null
  });
  // SYNOPTIC_COLD_START_MAX_BYTES applies here as in every other skin.
  // It matters more here: this text rides in the system prompt of every
  // dispatch, not once at session start.
  return truncateToBudget(
    (auth.warning ?? '') + doc,
    parseMaxBytes(opts.env.SYNOPTIC_COLD_START_MAX_BYTES)
  );
}

function withTimeout(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Per-session render cache. A promise (not the string) so concurrent
 *  dispatches share one render instead of stampeding Substrate. */
function createStore(
  directory: string,
  identity: { kid?: string | null; key?: string | null } = {},
  connection: Connection = {}
): {
  prewarm: (sessionId: string | null) => void;
  getOrRender: (sessionId: string | null | undefined) => Promise<string>;
  invalidate: (sessionId: string) => void;
} {
  const renders = new Map<string, Promise<string>>();

  function sessionKey(sessionId: string | null | undefined): string {
    return sessionId ?? `dir:${directory}`;
  }

  function coldStart(sessionId: string | null): Promise<string> {
    const env = connectionEnv(connection);
    const url = env.SUBSTRATE_URL;
    const namespace = env.SUBSTRATE_NAMESPACE ?? 'cortext';
    // The repo root, not the directory the session started in: project
    // scope and the conventions fragment live at the root.
    const root = sessionRoot(directory);
    const slug = projectSlug(root, env);
    const gate = withTimeout(COLD_START_TIMEOUT_MS);
    return Promise.race([
      renderColdStart({
        substrateUrl: url,
        namespace,
        projectSlug: slug,
        cwd: root,
        sessionId,
        env,
        identity
      }),
      gate.promise.then(() => offlineNote(env))
    ])
      .then(
        (doc) => {
          gate.cancel();
          return doc;
        },
        () => {
          gate.cancel();
          return offlineNote(env);
        }
      )
      .catch(() => offlineNote(env));
  }

  function prewarm(sessionId: string | null): void {
    try {
      const key = sessionKey(sessionId);
      if (!renders.has(key)) renders.set(key, coldStart(sessionId));
    } catch {
      // Prewarm is best-effort; the transform recomputes on a miss.
    }
  }

  function getOrRender(sessionId: string | null | undefined): Promise<string> {
    const key = sessionKey(sessionId);
    let pending = renders.get(key);
    if (pending === undefined) {
      pending = coldStart(sessionId ?? null);
      renders.set(key, pending);
    }
    return pending;
  }

  function invalidate(sessionId: string): void {
    renders.delete(sessionKey(sessionId));
  }

  return { prewarm, getOrRender, invalidate };
}

type Identity = { kid?: string | null; key?: string | null };

/** Heads the nudge. OpenCode shows a synthetic message as a conversation
 *  turn, and a model can read the bare reason as the user asking. */
const NUDGE_HEADER =
  '[Automated end-of-turn check by the cortext plugin. This is NOT a message from the user.]';

/** Marks the nudge, so a prompt hook that sees it does not re-arm the seam. */
const NUDGE_METADATA = { cortextInbox: 'stop-nudge' } as const;

/** The slice of `ctx.session.synthetic` the end-of-turn nudge uses. */
type Synthetic = (input: {
  sessionID: string;
  text: string;
  description: string;
  metadata: typeof NUDGE_METADATA;
  delivery: 'queue';
  resume: boolean;
}) => Promise<unknown>;

/** The env and signed fetch the inbox reads with: the options identity wins
 *  over the env pair, exactly as for the cold-start. */
function inboxAccess(
  identity: Identity,
  connection: Connection
): {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
} {
  const base = connectionEnv(connection);
  const auth = createAgentAuth(base, identity);
  // All or nothing: once the options name either half, the env kid
  // is never borrowed, or a key-only entry would read and push as env's kid.
  const { SUBSTRATE_AGENT_KEY_ID: envKid, ...rest } = base;
  const kid = identity.kid || identity.key ? identity.kid : envKid;
  return {
    env: { ...rest, ...(kid ? { SUBSTRATE_AGENT_KEY_ID: kid } : {}) },
    fetchImpl: makeSignedFetch(auth.getAuthHeader) as typeof fetch
  };
}

/** The prompt and end-of-turn inbox seams. Never throws. */
function createInboxSeams(
  identity: Identity,
  connection: Connection = {},
  pushLive: () => boolean = () => false
): {
  onPrompt: (sessionID: string, metadata?: Record<string, unknown>) => void;
  noteFor: (sessionID: string) => Promise<string>;
  seen: (sessionID: string) => void;
  onTurnEnd: (sessionID: string, synthetic: Synthetic) => Promise<void>;
} {
  const prompted = new Set<string>();
  const sessions = new Set<string>();
  const notes = new Map<string, Promise<string>>();
  const nudged = new Map<string, Set<string>>();
  // Sessions whose user has prompted since the last nudge. Only these may be
  // nudged: the security bound on unattended turns.
  const armed = new Set<string>();

  function onPrompt(sessionID: string, metadata?: Record<string, unknown>): void {
    try {
      // Our own synthetic messages (the end-of-turn nudge, pushed mail) are not prompts.
      if (typeof metadata?.cortextInbox === 'string') return;
      armed.add(sessionID);
      // The first prompt's mail is in the cold-start's ## Inbox already.
      if (!prompted.has(sessionID)) {
        prompted.add(sessionID);
        return;
      }
      // D2: while the watcher is live it delivers these rows itself. Drop the
      // previous turn's line too, or the context hook would inject it again.
      if (pushLive()) {
        notes.delete(sessionID);
        return;
      }
      const gate = withTimeout(INBOX_TIMEOUT_MS);
      notes.set(
        sessionID,
        Promise.race([
          promptHookContext(inboxAccess(identity, connection)),
          gate.promise.then(() => '')
        ])
          .then((note) => {
            gate.cancel();
            return note;
          })
          .catch(() => '')
      );
    } catch {
      // The prompt proceeds without an inbox line.
    }
  }

  async function noteFor(sessionID: string): Promise<string> {
    try {
      return (await notes.get(sessionID)) ?? '';
    } catch {
      return '';
    }
  }

  async function onTurnEnd(sessionID: string, synthetic: Synthetic): Promise<void> {
    try {
      if (!sessions.has(sessionID) || !armed.has(sessionID)) return;
      const nudge = await inboxStopNudge(inboxAccess(identity, connection));
      if (nudge === null) return;
      const done = nudged.get(sessionID) ?? new Set<string>();
      if (nudge.ids.every((id) => done.has(id))) return;
      if (!armed.delete(sessionID)) return;
      for (const id of nudge.ids) done.add(id);
      nudged.set(sessionID, done);
      await synthetic({
        sessionID,
        text: `${NUDGE_HEADER}\n${nudge.reason}`,
        description: 'cortext inbox: unread agent mail',
        metadata: NUDGE_METADATA,
        delivery: 'queue',
        resume: true
      });
    } catch {
      // A failed nudge leaves the session idle, which is where it already is.
    }
  }

  return { onPrompt, noteFor, seen: (id) => sessions.add(id), onTurnEnd };
}

/** V1 entrypoint (OpenCode 1.x object-entrypoint shape). */
export const CortextPlugin: V1Plugin = async ({ directory }) => {
  const store = createStore(directory);
  const conventions = conventionsFor(directory);

  function prewarm(sessionId: string | null): void {
    store.prewarm(sessionId);
  }

  return {
    event: async ({ event }) => {
      try {
        if (event.type !== 'session.created') return;
        const info = event.properties.info;
        prewarm(info.id);
      } catch {
        // Bus notifications must never break the session.
      }
    },

    'chat.message': async (input) => {
      prewarm(input.sessionID ?? null);
    },

    'experimental.chat.system.transform': async (input, output) => {
      try {
        const doc = await store.getOrRender(input.sessionID ?? null);
        if (doc.length > 0) output.system.push(doc);
        if (conventions.length > 0) output.system.push(conventions);
      } catch {
        // Dispatch proceeds without injected context.
      }
    },

    'experimental.session.compacting': async (input, output) => {
      try {
        // Post-compaction state may have moved (new rows, newly stale
        // anchor): drop the cached render so the next dispatch rebuilds it,
        // and leave a pointer so the summary records where context lives.
        store.invalidate(input.sessionID);
        output.context.push(COMPACTION_POINTER);
      } catch {
        // Compaction proceeds regardless.
      }
    }
  };
};

/** Restart backoff for a watcher that crashed: 5 s doubling to 5 min, as
 *  the Claude bridge respawns its watcher child. */
const WATCHER_RESPAWN_MS = 5_000;
const WATCHER_RESPAWN_MAX_MS = 300_000;

/** Resubscribe backoff for a host event stream that ended: 1 s doubling to 1 min. */
const EVENT_RESUBSCRIBE_MS = 1_000;
const EVENT_RESUBSCRIBE_MAX_MS = 60_000;

/** A sleep that rejects when `signal` aborts, and leaves no listener behind
 *  when it resolves (one backoff per reconnect, for the life of the process). */
function abortableSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal.reason);
      };
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Runs the shared SSE watcher in-process until `signal` aborts. runWatcher
 *  takes no signal, so its sleep and fetch are made abortable instead: an
 *  aborted sleep rejects and ends the loop. A watcher that rejects for any
 *  other reason (a mid-stream network error escapes it) is reported
 *  `disabled`, so the prompt summary comes back, and restarted after a
 *  backoff. Never throws. */
function startWatcher(
  access: { env: NodeJS.ProcessEnv; fetchImpl: typeof fetch },
  bridge: InboxBridge,
  signal: AbortSignal
): void {
  const fetchImpl = ((url: string, init: RequestInit = {}) =>
    access.fetchImpl(url, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal
    })) as typeof fetch;
  const sleep = abortableSleep(signal);
  let crashes = 0;
  const run = (): void => {
    let wentLive = false;
    let watcher: Promise<unknown>;
    try {
      watcher = Promise.resolve(
        runWatcher({
          env: access.env,
          fetchImpl,
          since: new Date().toISOString(),
          namespace: access.env.SUBSTRATE_NAMESPACE ?? 'cortext',
          emit: (ev: WatchEvent) => {
            if (signal.aborted) return;
            if (ev.type === 'status' && ev.state === 'live') wentLive = true;
            void bridge.onWatch(ev);
          },
          sleep
        })
      );
    } catch (err) {
      watcher = Promise.reject(err);
    }
    watcher.then(
      () => {
        // Resolved: runWatcher returned after emitting `disabled` itself.
      },
      () => {
        if (signal.aborted) return;
        void bridge.onWatch({ type: 'status', state: 'disabled', reason: 'crashed' });
        crashes = wentLive ? 1 : crashes + 1;
        const delay = Math.min(WATCHER_RESPAWN_MAX_MS, WATCHER_RESPAWN_MS * 2 ** (crashes - 1));
        sleep(delay).then(run, () => {
          // Disposed during the backoff.
        });
      }
    );
  };
  run();
}

/** V2 setup (OpenCode 2.x): prompt prewarms, context injects, compaction
 *  invalidates. Never throws; the worst case is a dispatch with no injected
 *  context. Identity: an object plugin entry `{ package, options: { kid,
 *  key } }` in opencode.json(c) delivers its options via `ctx.options`,
 *  winning over the SUBSTRATE_AGENT_* env pair; absent options fall back to
 *  env (anonymous when neither is set, visible warning when partial). */
async function setup(ctx: PluginContext): Promise<() => void> {
  const options = ctx.options ?? {};
  const identity = { kid: options.kid, key: options.key };
  const connection: Connection = {
    ...(typeof options.url === 'string' && options.url !== '' ? { url: options.url } : {}),
    ...(typeof options.ns === 'string' && options.ns !== '' ? { ns: options.ns } : {})
  };
  const store = createStore(ctx.location.directory, identity, connection);
  // The push is optional: if it cannot be built, the seams run without it.
  let push: {
    bridge: InboxBridge;
    access: ReturnType<typeof inboxAccess>;
    enabled: boolean;
  } | null = null;
  try {
    const knobs = readInboxKnobs(process.env);
    const access = inboxAccess(identity, connection);
    const bridge = createInboxBridge({
      ns: access.env.SUBSTRATE_NAMESPACE ?? 'cortext',
      wake: knobs.wake,
      synthetic: (input) => ctx.session.synthetic(input),
      interrupt: (input) => ctx.session.interrupt(input),
      now: Date.now,
      after: (ms, fn) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      }
    });
    push = { bridge, access, enabled: knobs.push };
  } catch {
    push = null;
  }
  const bridge = push?.bridge ?? null;
  const inbox = createInboxSeams(identity, connection, () => bridge?.live() ?? false);

  // Subagent (child) sessions also pass through the prompt and context hooks.
  // Mail is for the session the user is driving, as in the Claude bridge, so
  // children are kept out of the push and the end-of-turn nudge. Classified
  // once per session; a failed lookup counts as a top-level session.
  const children = new Map<string, Promise<boolean>>();
  const isChild = (sessionID: string): Promise<boolean> => {
    let known = children.get(sessionID);
    if (known === undefined) {
      known = Promise.resolve()
        .then(() => ctx.session.get({ sessionID }))
        .then(
          (info) => Boolean((info as { parentID?: unknown } | undefined)?.parentID),
          () => false
        );
      children.set(sessionID, known);
      void known.then((child) => {
        if (child) bridge?.exclude(sessionID);
      });
    }
    return known;
  };
  const conventions = conventionsFor(ctx.location.directory);

  await ctx.session.hook('prompt', (event) => {
    try {
      store.prewarm(event.sessionID);
      void isChild(event.sessionID);
      inbox.onPrompt(event.sessionID, event.metadata);
      bridge?.onPrompt(event.sessionID, event.metadata);
    } catch {
      // Admission proceeds; context recomputes on a miss.
    }
  });

  await ctx.session.hook('context', async (event) => {
    try {
      inbox.seen(event.sessionID);
      bridge?.track(event.sessionID);
      const doc = await store.getOrRender(event.sessionID);
      if (doc.length > 0) event.system.push({ type: 'text', text: doc });
      const note = (await isChild(event.sessionID)) ? '' : await inbox.noteFor(event.sessionID);
      if (note.length > 0) event.system.push({ type: 'text', text: note });
      // Conventions are their own part, outside the byte cap, which bounds
      // the volatile cold-start and must never cut the rules of the road.
      if (conventions.length > 0) event.system.push({ type: 'text', text: conventions });
    } catch {
      // Dispatch proceeds without injected context.
    }
  });

  await ctx.session.hook('compaction', (event) => {
    try {
      // Post-compaction state may have moved: drop the cached render so the
      // next dispatch rebuilds it, and leave a pointer so the summary
      // records where context lives.
      store.invalidate(event.sessionID);
      event.system.push({ type: 'text', text: COMPACTION_POINTER });
    } catch {
      // Compaction proceeds regardless.
    }
  });

  // End of turn: OpenCode has no Stop hook, so watch the event stream for a
  // turn that succeeded in a session this plugin served.
  const abort = new AbortController();
  if (push?.enabled) startWatcher(push.access, push.bridge, abort.signal);
  // The stream can end or fail without the plugin unloading. Busy state is
  // then unknown, so the bridge forgets it, and the stream is resubscribed.
  const sleep = abortableSleep(abort.signal);
  void (async () => {
    for (let failures = 0; !abort.signal.aborted; failures += 1) {
      try {
        for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
          failures = 0;
          bridge?.onEvent(ev as { type: string; data?: { sessionID?: string } });
          if (ev.type !== 'session.execution.succeeded') continue;
          // An urgent notice queued at this turn end already resumes it.
          if (bridge?.takeResumed(ev.data.sessionID)) continue;
          const ended = ev.data.sessionID;
          void isChild(ended).then((child) => {
            if (!child) void inbox.onTurnEnd(ended, (input) => ctx.session.synthetic(input));
          });
        }
      } catch {
        // Resubscribed below; the prompt and cold-start seams work meanwhile.
      }
      if (abort.signal.aborted) return;
      bridge?.streamLost();
      try {
        await sleep(Math.min(EVENT_RESUBSCRIBE_MAX_MS, EVENT_RESUBSCRIBE_MS * 2 ** failures));
      } catch {
        return; // Disposed during the backoff.
      }
    }
  })();
  return () => {
    abort.abort();
    bridge?.dispose();
  };
}

// Dual entrypoint: V2 calls setup(), V1 (>=1.18.29) calls server(). The APIs
// remain separate; this shape does not translate hooks automatically — both
// sides above share only the render store.
export default {
  ...definePlugin({ id: PLUGIN_ID, setup }),
  server: CortextPlugin
};
