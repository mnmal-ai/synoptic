import type { EngineInterface, Register } from 'claude-code';
import { update } from 'claude-code';
import {
  createBudget,
  laterCursor,
  lineSplitter,
  renderPushRow,
  urgentNotice
} from '../../synoptic/src/inbox-push.js';
import type { InboxMessage, WatchEvent } from '../types';

const DELIVERED = { plugin: 'cortext', key: 'inboxDelivered' } as const;
const CURSOR = { plugin: 'cortext', key: 'inboxCursor' } as const;
const PROMPT_ORIG = { plugin: 'cortext', key: 'inboxPromptCheckOrig' } as const;
const WAKE = 'New agent mail is above. Read it before continuing.';
const GRACE_MS = 20_000;
const RESPAWN_MS = 5_000;
const RESPAWN_MAX_MS = 300_000;
const SKEW_MS = 60_000;

// What the hooks share. Module variables reset on every reload; what must survive one lives in $.state.
type Bridge = {
  turnId: string | undefined;
  interactive: boolean;
  waking: boolean;
  wakeOn: boolean; // from the watcher's `live` line (D1: off by default)
  toolsInFlight: number;
  failedSpawns: number; // consecutive watcher exits with no `live`, for the respawn backoff
  late: InboxMessage[]; // appended since the latest main-thread step began
  wakes: ReturnType<typeof createBudget>;
  preemptions: ReturnType<typeof createBudget>;
};

// Top-level declarations, not closures in register: `claude plugin validate` follows $ only
// into a function declared at the top of the file.
function wake(b: Bridge, $: EngineInterface): void {
  if (b.waking) return;
  b.waking = true;
  // Never awaited: submit resolves when the next turn starts, which needs this one to end.
  // A refused or dropped submit (the session ending, the module unloading) has nothing to retry,
  // and must not surface as an unhandled rejection.
  $.prompt
    .submit({ text: WAKE })
    .catch(() => {})
    .finally(() => {
      b.waking = false;
    });
}

async function preempt(b: Bridge, $: EngineInterface, m: InboxMessage): Promise<void> {
  let interrupted = false;
  if (b.turnId !== undefined) {
    try {
      await $.turn.abort({ turnId: b.turnId });
      interrupted = true;
    } catch {
      // The turn ended first. The notice below starts the next one.
    }
  }
  $.prompt.submit({ text: urgentNotice(m, { interrupted }) }).catch(() => {}); // as in wake()
}

async function deliver(b: Bridge, $: EngineInterface, m: InboxMessage): Promise<void> {
  const { value: ids = [] } = await $.state.get(DELIVERED);
  if (ids.includes(m.id)) return;
  await $.session.append({
    message: { type: 'user', content: [{ type: 'text', text: renderPushRow(m) }] }
  });
  await update($, DELIVERED, (prev) => [...(prev ?? []), m.id].slice(-500));
  await update($, CURSOR, (prev) => laterCursor(prev, m.createdAt)); // never moves back
  if (m.fromSelf || !b.interactive) return;
  const now = await $.clock.now();
  if (m.urgent && b.preemptions.take(m, now)) {
    if (b.turnId === undefined || b.toolsInFlight === 0) return preempt(b, $, m);
    // A tool call is in flight: give it the grace period, unless the row lands or the mail is handled first.
    b.late.push(m);
    const pending = b.turnId;
    $.clock.after(GRACE_MS, () => {
      if (b.turnId === pending && b.late.some((x) => x.id === m.id)) void preempt(b, $, m);
    });
    return;
  }
  if (b.turnId !== undefined) b.late.push(m);
  // D1 budgets wakes, not messages: mail that rides a wake already pending spends nothing.
  else if (b.wakeOn && !b.waking && b.wakes.take(m, now)) wake(b, $);
}

/**
 * SYNOPTIC_INBOX_PROMPT_CHECK as the session first found it. A hot reload re-runs session.start
 * while the old watcher has set it 'off', and the old module cannot restore it after unload, so
 * the first reading is kept in $.state (which survives a reload) and written once (ifVersion 0).
 * $.state cannot hold undefined, so null stands for unset.
 */
async function originalPromptCheck($: EngineInterface): Promise<string | undefined> {
  const held = await $.state.get(PROMPT_ORIG);
  if (held.version > 0) return held.value ?? undefined;
  const now = await $.env.get('SYNOPTIC_INBOX_PROMPT_CHECK');
  await $.state.set(PROMPT_ORIG, now ?? null, { ifVersion: 0 });
  return now;
}

export const register: Register = (on) => {
  const b: Bridge = {
    turnId: undefined,
    interactive: false,
    waking: false,
    wakeOn: false,
    toolsInFlight: 0,
    failedSpawns: 0,
    late: [],
    wakes: createBudget({ perHour: 6, perThread: 2 }), // D1
    preemptions: createBudget({ perHour: 3 }) // D4
  };

  on('session.start', async ($, e, next) => {
    const started = await next(e);
    b.interactive = e.isInteractive;
    const bootAt = await $.clock.now();
    const promptCheck = await originalPromptCheck($); // restored when the watcher drops

    const run = async (): Promise<void> => {
      const { value: cursor } = await $.state.get(CURSOR);
      const since = cursor ?? new Date(bootAt - SKEW_MS).toISOString(); // skip what cold-start rendered
      const split = lineSplitter();
      let disabled = false;
      let wentLive = false;
      try {
        const watcher = $.process.spawn({
          argv: ['node', `${$.plugin.root}/hooks/inbox-watch.mjs`, '--since', since],
          cwd: e.cwd
        });
        for await (const piece of watcher) {
          if (piece.stream === 'stderr') {
            $.ui.log(piece.text, { to: 'debug' });
            continue;
          }
          for (const ev of split(piece.text) as WatchEvent[]) {
            if (ev.type === 'message') await deliver(b, $, ev);
            else if (ev.type === 'handled') b.late = b.late.filter((x) => x.id !== ev.id);
            else if (ev.type !== 'status')
              continue; // an unknown line changes nothing
            else if (ev.state === 'disabled') {
              // No identity, PUSH off, bad credential, a crash: stay off, no respawn. It can follow
              // `live`, so the prompt seam is restored below before the run ends.
              disabled = true;
              break;
            } else {
              if (ev.state === 'live') {
                wentLive = true;
                b.failedSpawns = 0;
              }
              if (ev.config !== undefined) b.wakeOn = ev.config.wake;
              // D2, Q3 measured: a module's $.env.set IS visible to a later settings
              // command hook, so the UserPromptSubmit seam stands down while live.
              await $.env.set(
                'SYNOPTIC_INBOX_PROMPT_CHECK',
                ev.state === 'live' ? 'off' : promptCheck
              );
            }
          }
          if (disabled) break;
        }
      } catch (err) {
        $.ui.log(`inbox watcher: ${String(err)}`, { to: 'debug' });
      }
      await $.env.set('SYNOPTIC_INBOX_PROMPT_CHECK', promptCheck);
      if (disabled) return;
      // A watcher that exits without ever going live (a spawn failure, a crash at boot) backs
      // off 5 s × 2^n up to 5 min; one that went live respawns in 5 s.
      const delay = Math.min(RESPAWN_MAX_MS, RESPAWN_MS * 2 ** b.failedSpawns);
      if (!wentLive) b.failedSpawns++;
      $.clock.after(delay, () => void run()); // unload drops the timer
    };
    void run().catch((err) => $.ui.log(`inbox watcher: ${String(err)}`, { to: 'debug' })); // outlives this dispatch
    return started;
  });

  on('tool.call', async (_$, e, next) => {
    if (e.agentId !== undefined) return next(e); // a subagent's tools run inside the main thread's Agent call
    b.toolsInFlight++;
    try {
      return await next(e);
    } finally {
      b.toolsInFlight--;
    }
  });

  on('turn.start', (_$, e, next) => {
    b.turnId = e.turnId; // main thread only: a subagent's run raises no turn.start
    return next(e);
  });

  on('turn.step', async function* (_$, e, next) {
    if (e.agentId === undefined) b.late = []; // rows appended so far ride this request (approximate, spec §5)
    return yield* next(e);
  });

  on('turn.complete', async ($, e, next) => {
    // A subagent's run raises turn.complete too (TurnCompleteFields.agentId), mid main turn:
    // it must not clear the main turn's id or settle the main turn's late rows.
    if (e.agentId !== undefined) return next(e);
    const done = await next(e);
    b.turnId = undefined;
    const now = await $.clock.now();
    // Urgent rows that landed late are owed a turn whatever the wake budget says. Such a row
    // forces a wake past both budgets (D1's wakes and D4's preemptions, which it may have
    // missed); accepted, because only senders on the SYNOPTIC_INBOX_URGENT_FROM allowlist can
    // mark mail urgent (D4).
    if (
      b.interactive &&
      // A pending wake absorbs an urgent late row's notice too: its turn reads the appended row.
      !b.waking &&
      e.reason === 'answer' &&
      b.late.some((m) => m.urgent || (b.wakeOn && b.wakes.take(m, now)))
    ) {
      wake(b, $);
    }
    b.late = [];
    return done;
  });
};
