// Agent mail pushed into a running OMP session. The shared watcher
// (runWatcher, also behind the Claude and OpenCode bridges) emits each new
// unread message; this module hands it to OMP's sendMessage, which steers it
// into a turn in progress, or, with SYNOPTIC_INBOX_WAKE=on, starts a turn in
// an idle session. Without wake an idle session gets the message appended and
// reads it on its next turn. Own mail and held mail (another server's, not
// allowlisted) are never pushed. Nothing here throws
// into OMP.

import { createBudget, readInboxKnobs, renderPushRow } from '../../synoptic/src/inbox-push.js';
import { runWatcher as sharedWatcher } from '../../synoptic/src/inbox-watch.js';

export const INBOX_CUSTOM_TYPE = 'cortext-inbox';

/** One message as runWatcher emits it (synoptic toWatchMessage). */
type WatchMessage = {
  type: 'message';
  id: string;
  shortId: number;
  inReplyTo: string | null;
  fromSelf: boolean;
  held: boolean;
  createdAt: string;
  [k: string]: unknown;
};
type WatchEvent = WatchMessage | { type: 'status' | 'handled'; [k: string]: unknown };

export type SendMessage = (
  message: { customType: string; content: string; display: boolean },
  options?: { triggerTurn?: boolean }
) => void;

type Deps = {
  runWatcher: typeof sharedWatcher;
  now: () => number;
};

const DELIVERED_CAP = 500;
const RESPAWN_MS = 5_000;
const RESPAWN_MAX_MS = 300_000;

function abortableSleep(signal: AbortSignal) {
  return (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Starts the watcher unless push is off or there is no identity. Returns the stop function. */
export function startInboxPush(
  send: SendMessage,
  access: { env: NodeJS.ProcessEnv; fetchImpl: typeof fetch },
  deps: Deps = { runWatcher: sharedWatcher, now: Date.now }
): () => void {
  const { env } = access;
  const knobs = readInboxKnobs(env);
  if (!knobs.push || !env.SUBSTRATE_URL || !env.SUBSTRATE_AGENT_KEY_ID) return () => {};
  const ns = env.SUBSTRATE_NAMESPACE ?? 'cortext';
  // Same caps as the OpenCode bridge: a chatty peer cannot drive turns unattended.
  const wakes = createBudget({ perHour: 6, perThread: 2 });
  const delivered = new Set<string>();
  const ctl = new AbortController();
  const { signal } = ctl;
  const sleep = abortableSleep(signal);
  const fetchImpl = ((url: string, init: RequestInit = {}) =>
    access.fetchImpl(url, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal
    })) as typeof fetch;

  const onEvent = (ev: WatchEvent): void => {
    if (signal.aborted || ev.type !== 'message') return;
    const m = ev as WatchMessage;
    // A held message (another server's, not allowlisted) is left for the prompt and stop checks.
    if (m.fromSelf || m.held || delivered.has(m.id)) return;
    delivered.add(m.id);
    if (delivered.size > DELIVERED_CAP) delivered.delete(delivered.values().next().value as string);
    const triggerTurn = knobs.wake && wakes.take(m, deps.now());
    try {
      send(
        { customType: INBOX_CUSTOM_TYPE, content: renderPushRow(m, ns), display: true },
        { triggerTurn }
      );
    } catch {
      // OMP refused the send; the prompt hook and the stop check still surface the mail.
    }
  };

  // Fixed once, so a respawned watcher still delivers mail that arrived while it was down.
  const since = new Date(deps.now()).toISOString();
  let crashes = 0;
  const run = (): void => {
    let wentLive = false;
    Promise.resolve()
      .then(() =>
        deps.runWatcher({
          env,
          fetchImpl,
          since,
          namespace: ns,
          signal,
          sleep,
          emit: (ev: WatchEvent) => {
            if (ev.type === 'status' && ev.state === 'live') wentLive = true;
            onEvent(ev);
          }
        })
      )
      .then(
        () => {
          // Returned on its own after reporting `disabled`: nothing to restart.
        },
        () => {
          if (signal.aborted) return;
          crashes = wentLive ? 1 : crashes + 1;
          sleep(Math.min(RESPAWN_MAX_MS, RESPAWN_MS * 2 ** (crashes - 1))).then(run, () => {});
        }
      );
  };
  run();
  return () => ctl.abort();
}
