// Mid-turn delivery of agent mail for the OpenCode 2.x skin. The
// watcher (runWatcher, shared with the Claude bridge) emits messages; this
// module decides where each one goes:
// - steer into every busy session this plugin served;
// - urgent mail from an allowlisted sender preempts the most recently
//   prompted session (3 per hour, 20 s grace for a tool in flight);
// - with SYNOPTIC_INBOX_WAKE=on and nothing busy, wake that session
//   (6 per hour, 2 per thread).
// Own mail never wakes or preempts. Every host call is injected, so the
// policy is tested with fakes; nothing here throws into OpenCode.

import { createBudget, renderPushRow, urgentNotice } from '../../synoptic/src/inbox-push.js';

/** Marks the bridge's own synthetic messages, so the prompt hook skips them. */
export const PUSH_METADATA = { cortextInbox: 'push' } as const;

const DESCRIPTION = 'cortext inbox: agent mail';
const GRACE_MS = 20_000;
const DELIVERED_CAP = 500;
const HELD_CAP = 50;

export type PushMessage = {
  type: 'message';
  id: string;
  shortId: number;
  subject: string;
  body: string | null;
  inReplyTo: string | null;
  tags: string[] | null;
  from: string;
  instance: string | null;
  createdAt: string;
  fromSelf: boolean;
  urgent: boolean;
};

export type WatchEvent =
  | PushMessage
  | { type: 'status'; state: 'live' | 'reconnecting' | 'disabled'; reason?: string }
  | { type: 'handled'; id: string };

export type HostEvent = { type: string; data?: { sessionID?: string } };

export type SyntheticInput = {
  sessionID: string;
  text: string;
  description: string;
  metadata: typeof PUSH_METADATA;
  delivery: 'steer' | 'queue';
  resume?: boolean;
};

export type BridgeDeps = {
  ns: string;
  wake: boolean;
  synthetic: (input: SyntheticInput) => Promise<unknown>;
  interrupt: (input: { sessionID: string }) => Promise<unknown>;
  now: () => number;
  after: (ms: number, fn: () => void) => () => void;
};

export type InboxBridge = {
  onWatch(ev: WatchEvent): Promise<void>;
  onEvent(ev: HostEvent): void;
  track(sessionID: string): void;
  onPrompt(sessionID: string, metadata?: Record<string, unknown>): void;
  live(): boolean;
  /** True once if this session's last turn end fired a preemption, whose
   *  queued notice already resumes it: the end-of-turn nudge must not too. */
  takeResumed(sessionID: string): boolean;
  /** The host event stream ended: busy and tool state are unknown, so
   *  forget them (mail is held until a turn is seen starting again). */
  streamLost(): void;
  /** Plugin unloading: cancel pending preemptions and ignore later mail. */
  dispose(): void;
  /** A subagent (child) session: never steered, woken or preempted. The
   *  target falls back to the most recently prompted remaining session. */
  exclude(sessionID: string): void;
};

/** urgentNotice's head, with OpenCode's account of an interrupt. The shared
 *  wording describes Claude Code moving a running command to the background. */
function opencodeUrgentNotice(m: PushMessage, interrupted: boolean): string {
  const head = urgentNotice(m, { interrupted: false });
  if (!interrupted) return head;
  return (
    `${head} Your previous turn was interrupted to deliver it, and a tool call that was running ` +
    'may have been cut off before it finished. Check the state of anything you were changing before you continue.'
  );
}

type SessionState = { busy: boolean; toolsInFlight: number; delivered: string[] };
type Pending = { m: PushMessage; target: string; cancel: () => void };

export function createInboxBridge(deps: BridgeDeps): InboxBridge {
  const sessions = new Map<string, SessionState>();
  const pending = new Map<string, Pending>();
  const wakes = createBudget({ perHour: 6, perThread: 2 });
  const preemptions = createBudget({ perHour: 3 });
  // Ids that have already woken or preempted a session. A reconnect snapshot
  // re-sends every unread row, and each must act at most once (loop safety).
  let acted: string[] = [];
  // Mail that reached no session (none was busy). Steered into the next turn
  // that starts, so an idle arrival is not left to the end-of-turn nudge.
  const held = new Map<string, PushMessage>();
  // onWatch calls run one at a time: a snapshot emits rows synchronously, and
  // two copies of one id must not both pass the delivered check mid-await.
  let chain: Promise<void> = Promise.resolve();
  // Prompt recency, newest last; `lastActive` is its tail. Kept as a list so
  // excluding a subagent hands the target back to the session before it.
  let prompts: string[] = [];
  let lastActive: string | null = null;
  const excluded = new Set<string>();
  const forget = (sessionID: string) => {
    sessions.delete(sessionID);
    prompts = prompts.filter((p) => p !== sessionID);
    lastActive = prompts.at(-1) ?? null;
  };
  let isLive = false;
  let disposed = false;
  const resumed = new Set<string>();

  const row = (m: PushMessage) => renderPushRow(m, deps.ns);
  const send = async (input: Omit<SyntheticInput, 'description' | 'metadata'>) => {
    try {
      await deps.synthetic({ ...input, description: DESCRIPTION, metadata: PUSH_METADATA });
      return true;
    } catch {
      return false;
    }
  };

  const serially = (task: () => Promise<void>): Promise<void> => {
    const run = chain.then(task).catch(() => {
      // A delivery fault leaves the mail in the mailbox for the seams.
    });
    chain = run;
    return run;
  };

  async function steerInto(sessionID: string, s: SessionState, m: PushMessage): Promise<boolean> {
    if (s.delivered.includes(m.id)) return true;
    if (!(await send({ sessionID, text: row(m), delivery: 'steer' }))) return false;
    s.delivered = [...s.delivered, m.id].slice(-DELIVERED_CAP);
    return true;
  }

  /** `skip`: a session about to be preempted for this message. Its queued
   *  notice carries the row, so it is not steered into the turn being cut. */
  async function steer(m: PushMessage, skip: string | null = null): Promise<void> {
    let reached = skip !== null;
    for (const [sessionID, s] of sessions) {
      if (sessionID === skip) continue;
      if (s.delivered.includes(m.id)) reached = true;
      else if (s.busy && (await steerInto(sessionID, s, m))) reached = true;
    }
    if (reached) held.delete(m.id);
    else if (held.size < HELD_CAP) held.set(m.id, m);
  }

  async function steerHeld(sessionID: string): Promise<void> {
    const s = sessions.get(sessionID);
    if (s === undefined || !s.busy) return;
    for (const m of [...held.values()]) {
      if (await steerInto(sessionID, s, m)) held.delete(m.id);
    }
  }

  async function preempt(m: PushMessage, target: string): Promise<void> {
    pending.delete(m.id);
    const s = sessions.get(target);
    if (s === undefined || disposed) return;
    let interrupted = false;
    if (s.busy) {
      try {
        await deps.interrupt({ sessionID: target });
        interrupted = true;
      } catch {
        // The turn ended first; the queued notice starts the next one.
      }
    }
    const notice = opencodeUrgentNotice(m, interrupted);
    const text = s.delivered.includes(m.id) ? notice : `${row(m)}\n\n${notice}`;
    if (await send({ sessionID: target, text, delivery: 'queue', resume: true })) {
      s.delivered = [...s.delivered, m.id].slice(-DELIVERED_CAP);
    }
  }

  function firePendingFor(sessionID: string): boolean {
    let fired = false;
    for (const p of [...pending.values()]) {
      if (p.target !== sessionID) continue;
      p.cancel();
      fired = true;
      void preempt(p.m, p.target);
    }
    return fired;
  }

  async function onMessage(m: PushMessage): Promise<void> {
    const target = lastActive;
    const t = target === null ? undefined : sessions.get(target);
    const eligible = !m.fromSelf && target !== null && t !== undefined && !acted.includes(m.id);
    const act = () => {
      acted = [...acted, m.id].slice(-DELIVERED_CAP);
    };
    // Decided before steering: a busy target about to be interrupted must not
    // also see the row mid-turn, or it answers it once on each side of the cut.
    const preempting = eligible && m.urgent && preemptions.take(m, deps.now());
    await steer(m, preempting && t?.busy ? target : null);
    if (!eligible || target === null || t === undefined) return;
    if (preempting) {
      act();
      if (t.busy && t.toolsInFlight > 0) {
        const cancel = deps.after(GRACE_MS, () => {
          if (pending.has(m.id)) void preempt(m, target);
        });
        pending.set(m.id, { m, target, cancel });
        return;
      }
      return preempt(m, target);
    }
    if (!deps.wake) return;
    for (const s of sessions.values()) if (s.busy) return;
    if (t.delivered.includes(m.id) || !wakes.take(m, deps.now())) return;
    act();
    if (await send({ sessionID: target, text: row(m), delivery: 'queue', resume: true })) {
      t.delivered = [...t.delivered, m.id].slice(-DELIVERED_CAP);
    }
  }

  function track(sessionID: string): void {
    if (excluded.has(sessionID)) return;
    if (!sessions.has(sessionID)) {
      sessions.set(sessionID, { busy: false, toolsInFlight: 0, delivered: [] });
    }
  }

  return {
    async onWatch(ev) {
      if (disposed) return;
      try {
        // Status and handled apply at once; messages queue (see `chain`).
        if (ev.type === 'status') isLive = ev.state === 'live';
        else if (ev.type === 'handled') {
          pending.get(ev.id)?.cancel();
          pending.delete(ev.id);
          held.delete(ev.id);
        } else if (ev.type === 'message') await serially(() => onMessage(ev));
      } catch {
        // A delivery fault leaves the mail in the mailbox for the seams.
      }
    },

    onEvent(ev) {
      try {
        const sid = ev.data?.sessionID;
        if (sid === undefined) return;
        if (ev.type === 'session.deleted') {
          forget(sid);
          return;
        }
        const s = sessions.get(sid);
        if (s === undefined) return;
        switch (ev.type) {
          case 'session.execution.started':
            s.busy = true;
            if (held.size > 0) void serially(() => steerHeld(sid));
            break;
          case 'session.execution.succeeded':
          case 'session.execution.failed':
          case 'session.execution.interrupted':
            s.busy = false;
            s.toolsInFlight = 0;
            if (firePendingFor(sid)) resumed.add(sid);
            break;
          case 'session.tool.called':
            s.toolsInFlight += 1;
            break;
          case 'session.tool.success':
          case 'session.tool.failed':
            s.toolsInFlight = Math.max(0, s.toolsInFlight - 1);
            if (s.toolsInFlight === 0) firePendingFor(sid);
            break;
        }
      } catch {
        // Bookkeeping faults must never reach OpenCode's event loop.
      }
    },

    track,

    onPrompt(sessionID, metadata) {
      // Our own synthetic messages (pushes, the end-of-turn nudge) are not prompts.
      if (typeof metadata?.cortextInbox === 'string' || excluded.has(sessionID)) return;
      track(sessionID);
      prompts = [...prompts.filter((p) => p !== sessionID), sessionID].slice(-DELIVERED_CAP);
      lastActive = sessionID;
    },

    live: () => isLive,

    takeResumed(sessionID) {
      return resumed.delete(sessionID);
    },

    streamLost() {
      for (const s of sessions.values()) {
        s.busy = false;
        s.toolsInFlight = 0;
      }
    },

    exclude(sessionID) {
      excluded.add(sessionID);
      forget(sessionID);
    },

    dispose() {
      disposed = true;
      for (const p of pending.values()) p.cancel();
      pending.clear();
      held.clear();
    }
  };
}
