// The V2 inbox seams: a summary line at each later prompt, and one
// queued synthetic nudge when a turn ends with unread mail. Substrate is stubbed
// at the fetch boundary: the directory answers one identity row and the
// mailbox answers whatever `mail` holds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../src/plugin.js';

type SystemPart = { type: string; text: string };
type HookEvent = {
  sessionID: string;
  system?: SystemPart[];
  metadata?: Record<string, unknown>;
};
type SessionHook = (event: HookEvent) => Promise<void> | void;
type TurnEvent = { type: string; data: { sessionID: string } };

let mail: Array<Record<string, unknown>> = [];

function message(id: string, shortId: number): Record<string, unknown> {
  return {
    id,
    shortId,
    subject: `subject ${shortId}`,
    body: 'body',
    _metadata: { createdBy: { kind: 'agent', id: 'peer@host' }, createdAt: '2026-10-12T00:00:00Z' }
  };
}

function stubSubstrate(): void {
  vi.stubGlobal('fetch', (async (_url: unknown, init?: { body?: unknown }) => {
    const data: Record<string, unknown> = {};
    try {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      for (const k of Object.keys(body)) {
        if (k === 'cortext/AgentIdentity') data[k] = [{ id: 'me-uuid' }];
        else if (k === 'cortext/AgentMessage') data[k] = mail;
        else data[k] = [];
      }
    } catch {
      // Non-frame request.
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  }) as typeof fetch);
}

/** A fake V2 context whose event stream the test pushes into. */
async function setup(): Promise<{
  hooks: Record<string, SessionHook>;
  emit: (ev: TurnEvent) => void;
  synthetic: ReturnType<typeof vi.fn>;
  cleanup: () => void;
}> {
  const hooks: Record<string, SessionHook> = {};
  const queue: TurnEvent[] = [];
  let wake: (() => void) | null = null;
  const synthetic = vi.fn(async () => ({}));
  const ctx = {
    location: { directory: '/tmp/cortext-opencode-test' },
    options: {},
    session: {
      hook: async (kind: string, cb: SessionHook) => {
        hooks[kind] = cb;
      },
      synthetic
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            const ev = queue.shift();
            if (ev !== undefined) {
              yield ev;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          }
        }
      })
    }
  };
  const cleanup = (await plugin.setup(
    ctx as unknown as Parameters<typeof plugin.setup>[0]
  )) as () => void;
  const emit = (ev: TurnEvent) => {
    queue.push(ev);
    wake?.();
  };
  return { hooks, emit, synthetic, cleanup };
}

const ENV_KEYS = [
  'SUBSTRATE_URL',
  'SUBSTRATE_NAMESPACE',
  'SUBSTRATE_AGENT_KEY_ID',
  'SUBSTRATE_AGENT_KEY_PATH',
  'SYNOPTIC_INBOX_PROMPT_CHECK',
  'SYNOPTIC_INBOX_STOP_CHECK',
  'SYNOPTIC_HOST_REPORT',
  'SYNOPTIC_INBOX_PUSH'
];
let savedEnv: Record<string, string | undefined>;
let cleanups: Array<() => void> = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.SUBSTRATE_URL = 'https://substrate.test:3100';
  // These tests are the seams alone; the watcher has its own suite.
  process.env.SYNOPTIC_INBOX_PUSH = 'off';
  process.env.SUBSTRATE_NAMESPACE = 'cortext';
  process.env.SUBSTRATE_AGENT_KEY_ID = 'opencode@host';
  process.env.SYNOPTIC_HOST_REPORT = 'off';
  mail = [];
  stubSubstrate();
});

afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

async function started() {
  const s = await setup();
  cleanups.push(s.cleanup);
  return s;
}

async function dispatch(hooks: Record<string, SessionHook>, sessionID: string) {
  const event = { sessionID, system: [] as SystemPart[] };
  await hooks.context?.(event);
  return event.system;
}

describe('prompt seam', () => {
  it('skips the first prompt, then carries the summary on every dispatch of a later turn', async () => {
    const { hooks } = await started();
    mail = [message('m1', 944)];
    await hooks.prompt?.({ sessionID: 's1' });
    const first = await dispatch(hooks, 's1');
    expect(first.some((p) => p.text.startsWith('📬 Inbox'))).toBe(false);

    await hooks.prompt?.({ sessionID: 's1' });
    for (let step = 0; step < 2; step++) {
      const parts = await dispatch(hooks, 's1');
      const line = parts.find((p) => p.text.startsWith('📬 Inbox'));
      expect(line?.text).toContain('#944 (id m1) from peer@host');
    }
  });

  it('adds nothing when the inbox is empty or the check is off', async () => {
    const { hooks } = await started();
    await hooks.prompt?.({ sessionID: 's1' });
    await hooks.prompt?.({ sessionID: 's1' });
    expect((await dispatch(hooks, 's1')).some((p) => p.text.startsWith('📬'))).toBe(false);

    process.env.SYNOPTIC_INBOX_PROMPT_CHECK = 'off';
    mail = [message('m1', 944)];
    await hooks.prompt?.({ sessionID: 's1' });
    expect((await dispatch(hooks, 's1')).some((p) => p.text.startsWith('📬'))).toBe(false);
  });
});

describe('end-of-turn seam', () => {
  it('queues one resuming synthetic nudge per unread message, in served sessions only', async () => {
    const { hooks, emit, synthetic } = await started();
    mail = [message('m1', 944)];
    await hooks.prompt?.({ sessionID: 's1' });
    await dispatch(hooks, 's1');

    emit({ type: 'session.execution.succeeded', data: { sessionID: 'other' } });
    emit({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
    await vi.waitFor(() => expect(synthetic).toHaveBeenCalledTimes(1));
    expect(synthetic.mock.calls[0]?.[0]).toMatchObject({
      sessionID: 's1',
      delivery: 'queue',
      resume: true
    });
    expect(String(synthetic.mock.calls[0]?.[0]?.text)).toContain('#944');
    expect(String(synthetic.mock.calls[0]?.[0]?.text)).toMatch(
      /^\[Automated .* NOT a message from the user\.\]\n/
    );

    // The turn the nudge started ends with the same mail: no second nudge.
    emit({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(synthetic).toHaveBeenCalledTimes(1);

    // New mail alone does not: the nudge spent this prompt's continuation,
    // and the nudge's own prompt (if OpenCode routes it there) re-arms nothing.
    mail = [message('m1', 944), message('m2', 945)];
    await hooks.prompt?.({ sessionID: 's1', metadata: { cortextInbox: 'stop-nudge' } });
    emit({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(synthetic).toHaveBeenCalledTimes(1);

    // The user's next prompt re-arms it, and the new message nudges.
    await hooks.prompt?.({ sessionID: 's1' });
    emit({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
    await vi.waitFor(() => expect(synthetic).toHaveBeenCalledTimes(2));
  });

  it('a pushed message is not a user prompt and re-arms nothing', async () => {
    const { hooks, emit, synthetic } = await started();
    mail = [message('m1', 944)];
    await hooks.prompt?.({ sessionID: 's1' });
    await dispatch(hooks, 's1');
    emit({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
    await vi.waitFor(() => expect(synthetic).toHaveBeenCalledTimes(1));

    // The inbox push marks its own synthetic messages; one reaching
    // the prompt hook must not spend a fresh continuation.
    mail = [message('m1', 944), message('m2', 945)];
    await hooks.prompt?.({ sessionID: 's1', metadata: { cortextInbox: 'push' } });
    emit({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(synthetic).toHaveBeenCalledTimes(1);
  });

  it('a stream of new mail cannot drive unattended turns', async () => {
    const { hooks, emit, synthetic } = await started();
    await hooks.prompt?.({ sessionID: 's1' });
    await dispatch(hooks, 's1');
    for (let n = 0; n < 5; n++) {
      mail = [message(`m${n}`, 900 + n)];
      emit({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(synthetic).toHaveBeenCalledTimes(1);
  });

  it('does nothing with an empty inbox, on other events, or when switched off', async () => {
    const { hooks, emit, synthetic } = await started();
    await hooks.prompt?.({ sessionID: 's1' });
    await dispatch(hooks, 's1');
    emit({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
    mail = [message('m1', 944)];
    emit({ type: 'session.execution.failed', data: { sessionID: 's1' } });
    process.env.SYNOPTIC_INBOX_STOP_CHECK = 'off';
    emit({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(synthetic).not.toHaveBeenCalled();
  });
});
