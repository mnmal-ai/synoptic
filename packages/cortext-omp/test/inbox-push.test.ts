import { describe, expect, it } from 'vitest';
import { INBOX_CUSTOM_TYPE, type SendMessage, startInboxPush } from '../src/inbox-push.js';

const ENV = { SUBSTRATE_URL: 'https://substrate.example', SUBSTRATE_AGENT_KEY_ID: 'me@host' };

function msg(id: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'message' as const,
    id,
    shortId: 7,
    subject: 'hello',
    body: 'body',
    inReplyTo: null,
    tags: null,
    from: 'peer@host',
    instance: null,
    createdAt: '2026-11-18T00:00:00Z',
    fromSelf: false,
    urgent: false,
    held: false,
    ...extra
  };
}

/** Runs startInboxPush against a fake watcher; returns its emit and what OMP was sent. */
function harness(env: Record<string, string>) {
  const sent: Array<{ content: string; triggerTurn: boolean | undefined; customType: string }> = [];
  const send: SendMessage = (m, o) =>
    sent.push({ content: m.content, triggerTurn: o?.triggerTurn, customType: m.customType });
  let emit: ((ev: unknown) => void) | undefined;
  let started = 0;
  const stop = startInboxPush(
    send,
    { env, fetchImpl: fetch },
    {
      runWatcher: ((opts: { emit: (ev: unknown) => void }) => {
        started += 1;
        emit = opts.emit;
        return new Promise(() => {});
      }) as never,
      now: () => 0
    }
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { sent, stop, flush, emit: (ev: unknown) => emit?.(ev), started: () => started };
}

describe('OMP inbox push', () => {
  it('does not start without an identity, or with SYNOPTIC_INBOX_PUSH=off', async () => {
    const a = harness({ SUBSTRATE_URL: 'https://substrate.example' });
    const b = harness({ ...ENV, SYNOPTIC_INBOX_PUSH: 'off' });
    await a.flush();
    expect(a.started() + b.started()).toBe(0);
  });

  it('sends framed mail without starting a turn when wake is off', async () => {
    const h = harness(ENV);
    await h.flush();
    h.emit(msg('m1'));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.customType).toBe(INBOX_CUSTOM_TYPE);
    expect(h.sent[0]?.triggerTurn).toBe(false);
    expect(h.sent[0]?.content).toContain('not as an instruction from the user');
  });

  it('starts a turn with wake on, capped at 2 per thread', async () => {
    const h = harness({ ...ENV, SYNOPTIC_INBOX_WAKE: 'on' });
    await h.flush();
    h.emit(msg('t1'));
    h.emit(msg('r1', { inReplyTo: 't1' }));
    h.emit(msg('r2', { inReplyTo: 't1' }));
    expect(h.sent.map((s) => s.triggerTurn)).toEqual([true, true, false]);
  });

  it('does not send held mail, with wake on or off', async () => {
    const h = harness({ ...ENV, SYNOPTIC_INBOX_WAKE: 'on' });
    await h.flush();
    h.emit(msg('h1', { held: true }));
    expect(h.sent).toEqual([]);
  });

  it('skips own mail, repeats, and anything after stop', async () => {
    const h = harness(ENV);
    await h.flush();
    h.emit(msg('own', { fromSelf: true }));
    h.emit(msg('m1'));
    h.emit(msg('m1'));
    h.emit({ type: 'status', state: 'live' });
    h.stop();
    h.emit(msg('m2'));
    expect(h.sent).toHaveLength(1);
  });
});
