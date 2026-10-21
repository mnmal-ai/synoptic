// Delivery policy of the OpenCode inbox push. Host calls are recorded
// fakes; the clock is a counter and timers fire only when the test says.

import { describe, expect, it } from 'vitest';
import {
  type BridgeDeps,
  createInboxBridge,
  type PushMessage,
  type SyntheticInput
} from '../src/inbox-bridge.js';

function msg(id: string, extra: Partial<PushMessage> = {}): PushMessage {
  return {
    type: 'message',
    id,
    shortId: 7,
    subject: `subject ${id}`,
    body: 'body',
    inReplyTo: null,
    tags: null,
    from: 'peer@host',
    instance: null,
    createdAt: '2026-10-14T00:00:00Z',
    fromSelf: false,
    urgent: false,
    ...extra
  };
}

function harness(opts: { wake?: boolean; failSynthetic?: boolean } = {}) {
  const synthetic: SyntheticInput[] = [];
  const interrupts: string[] = [];
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  let clock = 1_000_000;
  let failNext = opts.failSynthetic ?? false;
  const deps: BridgeDeps = {
    ns: 'cortext',
    wake: opts.wake ?? false,
    synthetic: async (input) => {
      if (failNext) {
        failNext = false;
        throw new Error('synthetic refused');
      }
      synthetic.push(input);
      return {};
    },
    interrupt: async ({ sessionID }) => {
      interrupts.push(sessionID);
      return {};
    },
    now: () => clock,
    after: (ms, fn) => {
      const t = { at: clock + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    }
  };
  const bridge = createInboxBridge(deps);
  const advance = (ms: number) => {
    clock += ms;
    for (const t of timers)
      if (t.live && t.at <= clock) {
        t.live = false;
        t.fn();
      }
  };
  const start = (sid: string) => {
    bridge.track(sid);
    bridge.onPrompt(sid);
    bridge.onEvent({ type: 'session.execution.started', data: { sessionID: sid } });
  };
  const end = (sid: string) =>
    bridge.onEvent({ type: 'session.execution.succeeded', data: { sessionID: sid } });
  return { bridge, synthetic, interrupts, advance, start, end };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('steer', () => {
  it('steers into every busy tracked session and none of the idle ones', async () => {
    const h = harness();
    h.start('a');
    h.start('b');
    h.bridge.track('idle');
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic.map((s) => [s.sessionID, s.delivery])).toEqual([
      ['a', 'steer'],
      ['b', 'steer']
    ]);
    expect(h.synthetic[0]?.text).toContain('new mail #7');
    expect(h.synthetic[0]?.metadata).toEqual({ cortextInbox: 'push' });
  });

  it('ignores sessions it never served', async () => {
    const h = harness();
    h.bridge.onEvent({ type: 'session.execution.started', data: { sessionID: 'stranger' } });
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic).toEqual([]);
  });

  it('steers a message once per session across a re-sent snapshot', async () => {
    const h = harness();
    h.start('a');
    await h.bridge.onWatch(msg('m1'));
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic).toHaveLength(1);
  });

  it('retries a steer that failed instead of recording it', async () => {
    const h = harness({ failSynthetic: true });
    h.start('a');
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic).toEqual([]);
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic).toHaveLength(1);
  });

  it('stops tracking a deleted session', async () => {
    const h = harness();
    h.start('a');
    h.bridge.onEvent({ type: 'session.deleted', data: { sessionID: 'a' } });
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic).toEqual([]);
  });
});

describe('wake', () => {
  it('does not wake when SYNOPTIC_INBOX_WAKE is off', async () => {
    const h = harness();
    h.start('a');
    h.end('a');
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic).toEqual([]);
  });

  it('wakes only the most recently prompted session, only when nothing is busy', async () => {
    const h = harness({ wake: true });
    h.start('a');
    h.end('a');
    h.start('b');
    h.end('b');
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic.map((s) => [s.sessionID, s.delivery, s.resume])).toEqual([
      ['b', 'queue', true]
    ]);
  });

  it('does not wake while any session is busy (it steers instead)', async () => {
    const h = harness({ wake: true });
    h.start('a');
    h.end('a');
    h.start('b');
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic.map((s) => s.delivery)).toEqual(['steer']);
  });

  it('never wakes for own mail', async () => {
    const h = harness({ wake: true });
    h.start('a');
    h.end('a');
    await h.bridge.onWatch(msg('m1', { fromSelf: true }));
    expect(h.synthetic).toEqual([]);
  });

  it('stops after two wakes on one thread', async () => {
    const h = harness({ wake: true });
    h.start('a');
    h.end('a');
    for (const id of ['m1', 'm2', 'm3']) await h.bridge.onWatch(msg(id, { inReplyTo: 'root' }));
    expect(h.synthetic).toHaveLength(2);
  });

  it('ignores its own synthetic prompts when choosing the target', async () => {
    const h = harness({ wake: true });
    h.start('a');
    h.end('a');
    h.start('b');
    h.end('b');
    h.bridge.onPrompt('a', { cortextInbox: 'push' });
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic[0]?.sessionID).toBe('b');
  });
});

describe('urgent', () => {
  it('queues the row and notice into an idle target without interrupting', async () => {
    const h = harness();
    h.start('a');
    h.end('a');
    await h.bridge.onWatch(msg('m1', { urgent: true }));
    expect(h.interrupts).toEqual([]);
    expect(h.synthetic).toHaveLength(1);
    expect(h.synthetic[0]?.delivery).toBe('queue');
    expect(h.synthetic[0]?.resume).toBe(true);
    expect(h.synthetic[0]?.text).toContain('new mail #7');
    expect(h.synthetic[0]?.text).toContain('Urgent agent mail #7');
  });

  it('interrupts a busy target with no tool in flight', async () => {
    const h = harness();
    h.start('a');
    await h.bridge.onWatch(msg('m1', { urgent: true }));
    expect(h.interrupts).toEqual(['a']);
    // Not steered into the turn being interrupted: the model would answer it
    // once before the interrupt lands ("not interrupted") and once after.
    expect(h.synthetic.filter((s) => s.delivery === 'steer')).toEqual([]);
    const notice = h.synthetic.find((s) => s.delivery === 'queue');
    expect(notice?.text).toContain('new mail #7');
    expect(notice?.text).toContain('interrupted to deliver it');
  });

  it('still steers urgent mail into other busy sessions', async () => {
    const h = harness();
    h.start('b');
    h.start('a');
    await h.bridge.onWatch(msg('m1', { urgent: true }));
    expect(h.interrupts).toEqual(['a']);
    expect(h.synthetic.filter((s) => s.delivery === 'steer').map((s) => s.sessionID)).toEqual([
      'b'
    ]);
  });

  it('does not steer the urgent target while its grace period runs, nor after', async () => {
    const h = harness();
    h.start('a');
    h.bridge.onEvent({ type: 'session.tool.called', data: { sessionID: 'a' } });
    await h.bridge.onWatch(msg('m1', { urgent: true }));
    expect(h.synthetic).toEqual([]);
    h.bridge.onEvent({ type: 'session.tool.success', data: { sessionID: 'a' } });
    await flush();
    h.bridge.onEvent({ type: 'session.execution.interrupted', data: { sessionID: 'a' } });
    h.bridge.onEvent({ type: 'session.execution.started', data: { sessionID: 'a' } });
    await flush();
    expect(h.synthetic.map((s) => s.delivery)).toEqual(['queue']);
    expect(h.synthetic[0]?.text).toContain('new mail #7');
  });

  it('steers urgent mail normally once the preemption budget is spent', async () => {
    const h = harness();
    h.start('a');
    for (const id of ['u1', 'u2', 'u3']) await h.bridge.onWatch(msg(id, { urgent: true }));
    h.bridge.onEvent({ type: 'session.execution.started', data: { sessionID: 'a' } });
    await h.bridge.onWatch(msg('u4', { urgent: true }));
    expect(h.interrupts).toHaveLength(3);
    expect(h.synthetic.filter((s) => s.delivery === 'steer')).toHaveLength(1);
  });

  it('waits for a tool in flight, then preempts when it finishes', async () => {
    const h = harness();
    h.start('a');
    h.bridge.onEvent({ type: 'session.tool.called', data: { sessionID: 'a' } });
    await h.bridge.onWatch(msg('m1', { urgent: true }));
    expect(h.interrupts).toEqual([]);
    h.bridge.onEvent({ type: 'session.tool.success', data: { sessionID: 'a' } });
    await flush();
    expect(h.interrupts).toEqual(['a']);
  });

  it('preempts when the 20 s grace period expires', async () => {
    const h = harness();
    h.start('a');
    h.bridge.onEvent({ type: 'session.tool.called', data: { sessionID: 'a' } });
    await h.bridge.onWatch(msg('m1', { urgent: true }));
    h.advance(19_999);
    await flush();
    expect(h.interrupts).toEqual([]);
    h.advance(1);
    await flush();
    expect(h.interrupts).toEqual(['a']);
  });

  it('cancels a pending preemption when the mail is handled first', async () => {
    const h = harness();
    h.start('a');
    h.bridge.onEvent({ type: 'session.tool.called', data: { sessionID: 'a' } });
    await h.bridge.onWatch(msg('m1', { urgent: true }));
    await h.bridge.onWatch({ type: 'handled', id: 'm1' });
    h.advance(20_000);
    await flush();
    expect(h.interrupts).toEqual([]);
  });

  it('delivers as normal mail once the preemption budget is spent', async () => {
    const h = harness();
    h.start('a');
    h.end('a');
    for (const id of ['u1', 'u2', 'u3', 'u4']) await h.bridge.onWatch(msg(id, { urgent: true }));
    expect(h.synthetic).toHaveLength(3);
  });

  it('never preempts for own mail even when flagged urgent', async () => {
    const h = harness();
    h.start('a');
    await h.bridge.onWatch(msg('m1', { urgent: true, fromSelf: true }));
    expect(h.interrupts).toEqual([]);
  });
});

describe('review fixes', () => {
  it('preempts an urgent message once, even when a reconnect re-sends it', async () => {
    const h = harness();
    h.start('a');
    await h.bridge.onWatch(msg('u1', { urgent: true }));
    await h.bridge.onWatch(msg('u1', { urgent: true }));
    expect(h.interrupts).toEqual(['a']);
    expect(h.synthetic.filter((s) => s.delivery === 'queue')).toHaveLength(1);
  });

  it('wakes for a message once, even when a reconnect re-sends it', async () => {
    const h = harness({ wake: true });
    h.start('a');
    h.end('a');
    await h.bridge.onWatch(msg('m1'));
    // The woken turn ends without the mail being handled; the snapshot replays it.
    h.bridge.onEvent({ type: 'session.execution.started', data: { sessionID: 'a' } });
    h.end('a');
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic.filter((s) => s.resume === true)).toHaveLength(1);
  });

  it('steers once when the same message arrives twice before the first send settles', async () => {
    const sent: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const bridge = createInboxBridge({
      ns: 'cortext',
      wake: false,
      synthetic: async (input) => {
        await gate;
        sent.push(input.sessionID);
        return {};
      },
      interrupt: async () => ({}),
      now: () => 0,
      after: () => () => {}
    });
    bridge.track('a');
    bridge.onPrompt('a');
    bridge.onEvent({ type: 'session.execution.started', data: { sessionID: 'a' } });
    const first = bridge.onWatch(msg('m1'));
    const second = bridge.onWatch(msg('m1'));
    release();
    await Promise.all([first, second]);
    expect(sent).toEqual(['a']);
  });

  it('holds mail that reached no session and steers it into the next turn', async () => {
    const h = harness();
    h.bridge.track('a');
    h.bridge.onPrompt('a');
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic).toEqual([]);
    h.bridge.onEvent({ type: 'session.execution.started', data: { sessionID: 'a' } });
    await flush();
    expect(h.synthetic.map((s) => [s.sessionID, s.delivery])).toEqual([['a', 'steer']]);
    // Steered once; a later turn does not repeat it.
    h.end('a');
    h.bridge.onEvent({ type: 'session.execution.started', data: { sessionID: 'a' } });
    await flush();
    expect(h.synthetic).toHaveLength(1);
  });

  it('drops held mail once it is handled', async () => {
    const h = harness();
    h.bridge.track('a');
    await h.bridge.onWatch(msg('m1'));
    await h.bridge.onWatch({ type: 'handled', id: 'm1' });
    h.bridge.onEvent({ type: 'session.execution.started', data: { sessionID: 'a' } });
    await flush();
    expect(h.synthetic).toEqual([]);
  });
});

describe('deferred minors', () => {
  it('dispose cancels a pending preemption', async () => {
    const h = harness();
    h.start('a');
    h.bridge.onEvent({ type: 'session.tool.called', data: { sessionID: 'a' } });
    await h.bridge.onWatch(msg('u1', { urgent: true }));
    h.bridge.dispose();
    h.advance(20_000);
    await flush();
    expect(h.interrupts).toEqual([]);
  });

  it('ignores messages after dispose', async () => {
    const h = harness();
    h.start('a');
    h.bridge.dispose();
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic).toEqual([]);
  });

  it('claims a turn end that fired a preemption, once', async () => {
    const h = harness();
    h.start('a');
    h.bridge.onEvent({ type: 'session.tool.called', data: { sessionID: 'a' } });
    await h.bridge.onWatch(msg('u1', { urgent: true }));
    h.end('a');
    expect(h.bridge.takeResumed('a')).toBe(true);
    expect(h.bridge.takeResumed('a')).toBe(false);
  });

  it('does not claim an ordinary turn end', () => {
    const h = harness();
    h.start('a');
    h.end('a');
    expect(h.bridge.takeResumed('a')).toBe(false);
  });

  it('forgets busy state when the event stream is lost', async () => {
    const h = harness();
    h.start('a');
    h.bridge.streamLost();
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic).toEqual([]);
    // Held, and steered once a turn is seen starting again.
    h.bridge.onEvent({ type: 'session.execution.started', data: { sessionID: 'a' } });
    await flush();
    expect(h.synthetic.map((s) => s.delivery)).toEqual(['steer']);
  });

  it('words the interrupted notice for OpenCode, not Claude', async () => {
    const h = harness();
    h.start('a');
    await h.bridge.onWatch(msg('u1', { urgent: true }));
    const notice = h.synthetic.find((s) => s.delivery === 'queue')?.text ?? '';
    expect(notice).toContain('Urgent agent mail #7');
    expect(notice).toContain('interrupted to deliver it');
    expect(notice).not.toContain('moved to the background');
  });
});

describe('subagent sessions', () => {
  it('exclude() stops steering into a session', async () => {
    const h = harness();
    h.start('main');
    h.start('child');
    h.bridge.exclude('child');
    await h.bridge.onWatch(msg('m1'));
    expect(h.synthetic.map((s) => s.sessionID)).toEqual(['main']);
  });

  it('exclude() hands the urgent and wake target back to the previous session', async () => {
    const h = harness();
    h.start('main');
    h.start('child'); // a subagent's prompt makes it the most recent
    h.bridge.exclude('child');
    await h.bridge.onWatch(msg('u1', { urgent: true }));
    expect(h.interrupts).toEqual(['main']);
  });

  it('ignores later prompts and events from an excluded session', async () => {
    const h = harness({ wake: true });
    h.start('main');
    h.end('main');
    h.bridge.exclude('child');
    h.bridge.onPrompt('child');
    h.bridge.onEvent({ type: 'session.execution.started', data: { sessionID: 'child' } });
    await h.bridge.onWatch(msg('m1'));
    // Nothing busy that counts, so main is woken; the child is never touched.
    expect(h.synthetic.map((s) => [s.sessionID, s.delivery])).toEqual([['main', 'queue']]);
  });
});

describe('status', () => {
  it('reports live only while the watcher says so', async () => {
    const h = harness();
    expect(h.bridge.live()).toBe(false);
    await h.bridge.onWatch({ type: 'status', state: 'live' });
    expect(h.bridge.live()).toBe(true);
    await h.bridge.onWatch({ type: 'status', state: 'reconnecting', reason: 'x' });
    expect(h.bridge.live()).toBe(false);
  });
});
