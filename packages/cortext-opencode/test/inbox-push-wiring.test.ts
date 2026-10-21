// setup() runs the shared watcher in-process and routes its events to the
// bridge. runWatcher is mocked: the test captures its arguments and
// emits on its behalf.

import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Emit = (ev: Record<string, unknown>) => void;
type WatcherArgs = {
  env: Record<string, string | undefined>;
  emit: Emit;
  sleep: (ms: number) => Promise<void>;
  fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>;
  fail: (err: Error) => void;
};
const watcher = vi.hoisted(() => ({ calls: [] as WatcherArgs[] }));
vi.mock('../../synoptic/src/inbox-watch.js', () => ({
  runWatcher: (args: WatcherArgs) =>
    new Promise((_resolve, reject) => {
      watcher.calls.push({ ...args, fail: reject });
    })
}));

import plugin from '../src/plugin.js';

type HookEvent = {
  sessionID: string;
  system?: Array<{ type: string; text: string }>;
  metadata?: Record<string, unknown>;
};
type SessionHook = (event: HookEvent) => Promise<void> | void;

async function setup(options: Record<string, unknown> = {}, children: string[] = []) {
  const hooks: Record<string, SessionHook> = {};
  const synthetic = vi.fn(async () => ({}));
  const interrupt = vi.fn(async () => ({}));
  const queue: Array<{ type: string; data: { sessionID: string } }> = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const subscriptions = { count: 0 };
  const ctx = {
    location: { directory: '/tmp/cortext-opencode-test' },
    options,
    session: {
      hook: async (kind: string, cb: SessionHook) => {
        hooks[kind] = cb;
      },
      synthetic,
      interrupt,
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        ...(children.includes(sessionID) ? { parentID: 'main' } : {})
      })
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        subscriptions.count += 1;
        ended = false;
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal.aborted && !ended) {
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
        };
      }
    }
  };
  const cleanup = (await plugin.setup(
    ctx as unknown as Parameters<typeof plugin.setup>[0]
  )) as () => void;
  const host = (type: string, sessionID: string) => {
    queue.push({ type, data: { sessionID } });
    wake?.();
  };
  const endStream = () => {
    ended = true;
    wake?.();
  };
  return { hooks, synthetic, interrupt, cleanup, host, endStream, subscriptions };
}

/** Substrate answering one identity row and one unread message. */
function stubMail(): void {
  vi.stubGlobal('fetch', (async (_url: unknown, init?: { body?: unknown }) => {
    const data: Record<string, unknown> = {};
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    for (const k of Object.keys(body)) {
      if (k === 'cortext/AgentIdentity') data[k] = [{ id: 'me-uuid' }];
      else if (k === 'cortext/AgentMessage')
        data[k] = [
          {
            id: 'm1',
            shortId: 9,
            subject: 'hi',
            body: 'b',
            _metadata: {
              createdBy: { kind: 'agent', id: 'peer@host' },
              createdAt: '2026-10-14T00:00:00Z'
            }
          }
        ];
      else data[k] = [];
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  }) as unknown as typeof fetch);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const KEYS = [
  'SUBSTRATE_URL',
  'SUBSTRATE_AGENT_KEY_ID',
  'SYNOPTIC_INBOX_PUSH',
  'SYNOPTIC_INBOX_WAKE',
  'SYNOPTIC_INBOX_PROMPT_CHECK'
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.SUBSTRATE_URL = 'https://substrate.test:3100';
  watcher.calls.length = 0;
  vi.stubGlobal('fetch', (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: {} })
  })) as unknown as typeof fetch);
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('watcher wiring', () => {
  it('starts one watcher with the options kid winning over env', async () => {
    process.env.SUBSTRATE_AGENT_KEY_ID = 'env@host';
    const { cleanup } = await setup({ kid: 'opts@host' });
    expect(watcher.calls).toHaveLength(1);
    expect(watcher.calls[0]?.env.SUBSTRATE_AGENT_KEY_ID).toBe('opts@host');
    cleanup();
  });

  it('starts no watcher when SYNOPTIC_INBOX_PUSH=off', async () => {
    process.env.SYNOPTIC_INBOX_PUSH = 'off';
    const { cleanup } = await setup();
    expect(watcher.calls).toHaveLength(0);
    cleanup();
  });

  it('steers watcher mail into a busy session', async () => {
    const { hooks, synthetic, host, cleanup } = await setup();
    await hooks.prompt?.({ sessionID: 's1' });
    host('session.execution.started', 's1');
    await tick();
    watcher.calls[0]?.emit({
      type: 'message',
      id: 'm1',
      shortId: 3,
      subject: 'hi',
      body: 'b',
      inReplyTo: null,
      tags: null,
      from: 'peer@host',
      instance: null,
      createdAt: '2026-10-14T00:00:00Z',
      fromSelf: false,
      urgent: false
    });
    await tick();
    expect(synthetic).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: 's1', delivery: 'steer' })
    );
    cleanup();
  });

  it('stops the watcher sleep on dispose', async () => {
    const { cleanup } = await setup();
    const pending = watcher.calls[0]?.sleep(60_000);
    cleanup();
    await expect(pending).rejects.toBeDefined();
  });

  it('marks the watcher disabled when it crashes, and restores the prompt summary', async () => {
    process.env.SUBSTRATE_AGENT_KEY_ID = 'me@host';
    vi.stubGlobal('fetch', (async (_url: unknown, init?: { body?: unknown }) => {
      const data: Record<string, unknown> = {};
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      for (const k of Object.keys(body)) {
        if (k === 'cortext/AgentIdentity') data[k] = [{ id: 'me-uuid' }];
        else if (k === 'cortext/AgentMessage')
          data[k] = [
            {
              id: 'm1',
              shortId: 9,
              subject: 'hi',
              body: 'b',
              _metadata: {
                createdBy: { kind: 'agent', id: 'peer@host' },
                createdAt: '2026-10-14T00:00:00Z'
              }
            }
          ];
        else data[k] = [];
      }
      return { ok: true, status: 200, json: async () => ({ data }) };
    }) as unknown as typeof fetch);
    const { hooks, cleanup } = await setup();
    const summary = async () => {
      await hooks.prompt?.({ sessionID: 's1' });
      const system: Array<{ type: string; text: string }> = [];
      await hooks.context?.({ sessionID: 's1', system });
      return system.some((p) => p.text.startsWith('📬'));
    };
    await summary(); // the first prompt is the cold-start's
    expect(await summary()).toBe(true);
    watcher.calls[0]?.emit({ type: 'status', state: 'live' });
    expect(await summary()).toBe(false);
    watcher.calls[0]?.fail(new Error('connection reset'));
    await tick();
    expect(await summary()).toBe(true);
    cleanup();
  });

  it('restarts a crashed watcher after a backoff, and not after dispose', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { cleanup } = await setup();
      watcher.calls[0]?.fail(new Error('connection reset'));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(watcher.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(watcher.calls).toHaveLength(2);
      cleanup();
      watcher.calls[1]?.fail(new Error('again'));
      await vi.advanceTimersByTimeAsync(600_000);
      expect(watcher.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no abort listener behind once a backoff sleep resolves', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      if (init?.signal) signals.push(init.signal);
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }) as unknown as typeof fetch);
    const { cleanup } = await setup();
    const w = watcher.calls[0];
    await w?.fetchImpl('https://substrate.test:3100/substrate/v1/query', {});
    const signal = signals.at(-1) as AbortSignal;
    expect(signal).toBeDefined();
    // The fake event stream waits on the same signal; count only what the sleeps add.
    const before = getEventListeners(signal, 'abort').length;
    for (let i = 0; i < 12; i++) await w?.sleep(1);
    expect(getEventListeners(signal, 'abort')).toHaveLength(before);
    cleanup();
  });

  it('does not nudge a turn end that an urgent preemption already resumed', async () => {
    process.env.SUBSTRATE_AGENT_KEY_ID = 'me@host';
    stubMail();
    const { hooks, synthetic, host, cleanup } = await setup();
    await hooks.prompt?.({ sessionID: 's1' });
    await hooks.context?.({ sessionID: 's1', system: [] });
    host('session.execution.started', 's1');
    host('session.tool.called', 's1');
    await tick();
    watcher.calls[0]?.emit({
      type: 'message',
      id: 'm1',
      shortId: 9,
      subject: 'hi',
      body: 'b',
      inReplyTo: null,
      tags: ['priority:urgent'],
      from: 'peer@host',
      instance: null,
      createdAt: '2026-10-14T00:00:00Z',
      fromSelf: false,
      urgent: true
    });
    await tick();
    host('session.execution.succeeded', 's1');
    await new Promise((r) => setTimeout(r, 100));
    const kinds = synthetic.mock.calls.map(
      (c) =>
        ((c as unknown[])[0] as { metadata?: { cortextInbox?: string } }).metadata?.cortextInbox
    );
    expect(kinds).toContain('push');
    expect(kinds).not.toContain('stop-nudge');
    cleanup();
  });

  it('resubscribes when the host event stream ends', async () => {
    const { subscriptions, endStream, cleanup } = await setup();
    await tick();
    expect(subscriptions.count).toBe(1);
    endStream();
    await vi.waitFor(() => expect(subscriptions.count).toBe(2), { timeout: 3000 });
    cleanup();
  });

  it('does not borrow the env kid when the options identity sets only a key', async () => {
    process.env.SUBSTRATE_AGENT_KEY_ID = 'env@host';
    const { cleanup } = await setup({ key: '/nonexistent/agent.key' });
    expect(watcher.calls[0]?.env.SUBSTRATE_AGENT_KEY_ID).toBeUndefined();
    cleanup();
  });

  it('keeps subagent sessions out of the push and the end-of-turn nudge', async () => {
    process.env.SUBSTRATE_AGENT_KEY_ID = 'me@host';
    stubMail();
    const { hooks, synthetic, interrupt, host, cleanup } = await setup({}, ['child']);
    await hooks.prompt?.({ sessionID: 'main' });
    await hooks.context?.({ sessionID: 'main', system: [] });
    host('session.execution.started', 'main');
    // The main session's task tool spawns a subagent, which is prompted last.
    await hooks.prompt?.({ sessionID: 'child' });
    await hooks.context?.({ sessionID: 'child', system: [] });
    host('session.execution.started', 'child');
    await tick();
    await tick();
    watcher.calls[0]?.emit({
      type: 'message',
      id: 'm1',
      shortId: 9,
      subject: 'hi',
      body: 'b',
      inReplyTo: null,
      tags: ['priority:urgent'],
      from: 'peer@host',
      instance: null,
      createdAt: '2026-10-14T00:00:00Z',
      fromSelf: false,
      urgent: true
    });
    await tick();
    expect(interrupt).toHaveBeenCalledWith({ sessionID: 'main' });
    host('session.execution.succeeded', 'child');
    await new Promise((r) => setTimeout(r, 100));
    const touched = synthetic.mock.calls.map(
      (c) => ((c as unknown[])[0] as { sessionID: string }).sessionID
    );
    expect(touched).not.toContain('child');
    cleanup();
  });
});
