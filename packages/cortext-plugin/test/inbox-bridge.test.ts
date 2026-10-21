// Engine tests for hooks/inbox-bridge.mjs, run by `claude plugin test packages/cortext-plugin`.
// The test's `on` hooks sit beneath the plugin and stand for the engine; vitest never sees this
// file (it collects only *.test.js).
//
// Known kit defect (measured on 2.1.290 and 2.1.291): a plugin's own `$.session.append` is
// dispatched over the process's global hook chain, not the test engine's, so it never reaches
// `on('session.append')` here and rejects "no implementation for session.append". Every case
// whose bridge path appends fails on that until the kit routes it; the first case asserts the
// watcher logged nothing, which names the defect when it fires.
import { expect, mock, test } from 'claude-code/testing';

type Ev = Record<string, unknown>;
type Pause = { pause: number };
type Line = Ev | Pause;

const msg = (n: number, extra: Ev = {}): Ev => ({
  type: 'message',
  id: `u${n}`,
  shortId: n,
  subject: `s${n}`,
  body: 'b',
  inReplyTo: null,
  tags: null,
  from: 'peer@Host',
  createdAt: `2026-10-06T0${n}:00:00Z`,
  fromSelf: false,
  urgent: false,
  ...extra
});
const LIVE = (wake = true): Ev => ({ type: 'status', state: 'live', config: { wake } });
const PROMPT_CHECK = 'SYNOPTIC_INBOX_PROMPT_CHECK';

type Options = {
  respawn?: Line[][];
  env?: Record<string, string>;
  /** Registered above the default `turn.abort` answer, so it can refuse in its place. */
  abort?: (e: { turnId: string }) => unknown;
};

/**
 * Engine fakes beneath the plugin. `process.spawn` streams the next script entry as NDJSON (a
 * `{ pause }` entry sleeps on the mocked clock mid-stream), `session.append`, `prompt.submit` and
 * `turn.abort` are recorded, `env` and `state` are maps. A `prompt.submit` is held, as the engine
 * holds one until its turn starts, until the test calls `releaseSubmits()`.
 */
// biome-ignore lint/suspicious/noExplicitAny: the kit's `on` is typed per event; the fakes are not
function harness(on: any, script: Line[][], opts: Options = {}) {
  const clock = mock.clock(on);
  const appended: string[] = [];
  const submitted: string[] = [];
  const aborted: string[] = [];
  const spawns: string[][] = [];
  const env = new Map<string, string>(Object.entries(opts.env ?? {}));
  const state = new Map<string, { value: unknown; version: number }>();
  const held: (() => void)[] = [];
  const logs: string[] = [];
  const queue = [...script, ...(opts.respawn ?? [])];
  const addr = (e: { plugin: string; key: string; id?: string }) =>
    `${e.plugin}/${e.key}/${e.id ?? ''}`;

  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }));
  on('turn.start', async (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }));
  on('turn.complete', async () => ({ text: '' }));
  // biome-ignore lint/correctness/useYield: an empty step, answered whole with no chunks
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn'
    };
  });
  on('process.spawn', async function* (_$: unknown, e: { argv: readonly string[] }) {
    spawns.push([...e.argv]);
    for (const line of queue.shift() ?? []) {
      if ('pause' in line) await clock.sleep((line as Pause).pause);
      else yield { stream: 'stdout', text: `${JSON.stringify(line)}\n` };
    }
    return { value: { code: 0, signal: null } };
  });
  on('session.append', async (_$: unknown, e: { message: { content: { text: string }[] } }) => {
    appended.push(e.message.content[0].text);
    return { message: e.message, uuid: `m${appended.length}` };
  });
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    submitted.push(e.text);
    return new Promise((resolve) => held.push(() => resolve({ text: e.text })));
  });
  if (opts.abort) on('turn.abort', async (_$: unknown, e: { turnId: string }) => opts.abort?.(e));
  else
    on('turn.abort', async (_$: unknown, e: { turnId: string }) => {
      aborted.push(e.turnId);
      return { value: undefined };
    });
  on('env.get', async (_$: unknown, e: { name: string }) => ({ value: env.get(e.name) }));
  on('env.set', async (_$: unknown, e: { name: string; value?: string }) => {
    if (e.value === undefined) env.delete(e.name);
    else env.set(e.name, e.value);
    return { value: undefined };
  });
  on('state.get', async (_$: unknown, e: { plugin: string; key: string; id?: string }) => ({
    value: state.get(addr(e)) ?? { value: undefined, version: 0 }
  }));
  on(
    'state.set',
    async (
      _$: unknown,
      e: { plugin: string; key: string; id?: string; value: unknown; ifVersion?: number }
    ) => {
      const prev = state.get(addr(e)) ?? { value: undefined, version: 0 };
      if (e.ifVersion !== undefined && e.ifVersion !== prev.version)
        return { value: { isSet: false, version: prev.version } };
      state.set(addr(e), { value: e.value, version: prev.version + 1 });
      return { value: { isSet: true, version: prev.version + 1 } };
    }
  );
  on('ui.log', async (_$: unknown, e: { text: string }) => {
    logs.push(e.text);
    return { value: undefined };
  });

  const releaseSubmits = async () => {
    for (const release of held.splice(0)) release();
    await clock.settle();
  };
  return { logs, clock, appended, submitted, aborted, env, spawns, releaseSubmits };
}

// biome-ignore lint/suspicious/noExplicitAny: the engine's `$` as the kit hands it
type Engine = any;

const start = async (
  $: Engine,
  h: { clock: { settle: () => Promise<void> } },
  isInteractive = true
) => {
  await $.session.start({ cwd: '/repo', surface: null, isInteractive });
  await h.clock.settle(); // the watcher run outlives the session.start dispatch
};
const step = async ($: Engine, turnId: string, agentId?: string) => {
  for await (const _ of $.turn.step({
    turnId,
    index: 0,
    model: 'm',
    messageCount: 1,
    ...(agentId ? { agentId } : {})
  }))
    void _;
};
const complete = ($: Engine, turnId: string, reason: 'answer' | 'aborted') =>
  $.turn.complete({
    turnId,
    reason,
    answer: '',
    durationMs: 0,
    isAborted: reason === 'aborted'
  });
const ROW = '[cortext inbox · new mail #1 · signed by peer@Host';

test('mid-turn mail is appended and nothing is submitted', async ($, on) => {
  const h = harness(on, [[LIVE(), msg(1)]]);
  await $.turn.start({ text: 'work', turnId: 't1' });
  await start($, h);
  expect(h.logs).toEqual([]);
  expect(h.appended).toHaveLength(1);
  expect(h.appended[0]).toContain(ROW);
  expect(h.submitted).toEqual([]);
});

test('idle mail wakes once per burst when wake is on', async ($, on) => {
  const h = harness(on, [[LIVE(true), msg(1), msg(2)]]);
  await start($, h);
  expect(h.appended).toHaveLength(2);
  expect(h.submitted).toHaveLength(1);
});

test('with wake off (the shipped default), idle mail is appended without a wake', async ($, on) => {
  const h = harness(on, [[LIVE(false), msg(1)]]);
  await start($, h);
  expect(h.appended).toHaveLength(1);
  expect(h.submitted).toEqual([]);
});

test('an exhausted wake budget means no wake', async ($, on) => {
  // 2 per thread: three idle replies on one thread, each after the previous wake settled.
  const t = (n: number) => msg(n, { inReplyTo: 'root' });
  const h = harness(on, [[LIVE(true), t(1), { pause: 1_000 }, t(2), { pause: 1_000 }, t(3)]]);
  await start($, h);
  expect(h.submitted).toHaveLength(1);
  await h.releaseSubmits();
  await h.clock.advance(1_000);
  expect(h.submitted).toHaveLength(2);
  await h.releaseSubmits();
  await h.clock.advance(1_000);
  expect(h.appended).toHaveLength(3);
  expect(h.submitted).toHaveLength(2);
});

test('a reply that rides a pending wake does not spend the thread budget', async ($, on) => {
  // D1 budgets wakes, not messages: t(2) lands while t(1)'s wake is pending, so one wake is spent.
  const t = (n: number) => msg(n, { inReplyTo: 'root' });
  const h = harness(on, [[LIVE(true), t(1), t(2), { pause: 1_000 }, t(3)]]);
  await start($, h);
  expect(h.submitted).toHaveLength(1);
  await h.releaseSubmits();
  await h.clock.advance(1_000);
  expect(h.appended).toHaveLength(3);
  expect(h.submitted).toHaveLength(2);
});

test('fromSelf never wakes or preempts', async ($, on) => {
  const h = harness(on, [
    [LIVE(true), msg(1, { fromSelf: true }), msg(2, { urgent: true, fromSelf: true })]
  ]);
  await start($, h);
  expect(h.appended).toHaveLength(2);
  expect(h.submitted).toEqual([]);
  expect(h.aborted).toEqual([]);
});

test('headless sessions append only', async ($, on) => {
  const h = harness(on, [[LIVE(true), msg(1), msg(2, { urgent: true })]]);
  await start($, h, false);
  expect(h.appended).toHaveLength(2);
  expect(h.submitted).toEqual([]);
  expect(h.aborted).toEqual([]);
});

test('mail after the last step wakes at turn.complete only when the reason is answer', async ($, on) => {
  const h = harness(on, [[LIVE(true), msg(1)]]);
  await $.turn.start({ text: 'x', turnId: 't1' });
  await start($, h);
  await complete($, 't1', 'aborted');
  expect(h.logs).toEqual([]);
  expect(h.appended).toHaveLength(1);
  expect(h.submitted).toEqual([]);
});

test('mail after the last step wakes at turn.complete when the reason is answer', async ($, on) => {
  const h = harness(on, [[LIVE(true), msg(1)]]);
  await $.turn.start({ text: 'x', turnId: 't1' });
  await start($, h);
  expect(h.submitted).toEqual([]);
  await complete($, 't1', 'answer');
  await h.clock.settle();
  expect(h.submitted).toHaveLength(1);
});

test('a repeated id is delivered once across a respawn (reconnect snapshot)', async ($, on) => {
  const h = harness(on, [[LIVE(), msg(1)]], { respawn: [[LIVE(), msg(1), msg(2)]] });
  await start($, h);
  expect(h.spawns).toHaveLength(1);
  await h.clock.advance(5_000);
  expect(h.spawns).toHaveLength(2);
  expect(h.appended.map((t) => t.match(/#(\d+)/)?.[1])).toEqual(['1', '2']);
});

test('disabled is not respawned', async ($, on) => {
  const h = harness(on, [[{ type: 'status', state: 'disabled', reason: 'HTTP 401' }]]);
  await start($, h);
  await h.clock.advance(60_000);
  expect(h.spawns).toHaveLength(1);
});

test('live turns the prompt check off; a watcher exit restores it', async ($, on) => {
  const h = harness(on, [[LIVE(), { pause: 1_000 }]], { env: { [PROMPT_CHECK]: 'on' } });
  await start($, h);
  expect(h.env.get(PROMPT_CHECK)).toBe('off'); // live, the stream still open
  await h.clock.advance(1_000);
  expect(h.env.get(PROMPT_CHECK)).toBe('on'); // the stream ended: restored
});

test('live then disabled restores the prompt check and never respawns', async ($, on) => {
  const h = harness(on, [
    [LIVE(), { pause: 1_000 }, { type: 'status', state: 'disabled', reason: 'HTTP 401' }]
  ]);
  await start($, h);
  expect(h.env.get(PROMPT_CHECK)).toBe('off');
  await h.clock.advance(60_000);
  expect(h.env.has(PROMPT_CHECK)).toBe(false);
  expect(h.spawns).toHaveLength(1);
});

test('urgent mail while idle submits the notice at once, past an exhausted wake budget and with wake off', async ($, on) => {
  const h = harness(on, [[LIVE(false), msg(1, { urgent: true })]]);
  await start($, h);
  expect(h.aborted).toEqual([]);
  expect(h.submitted).toHaveLength(1);
  expect(h.submitted[0]).toContain('#1');
  expect(h.submitted[0]).not.toMatch(/background/);
});

test('urgent mail with no tool call in flight aborts, then submits the interrupted notice', async ($, on) => {
  const h = harness(on, [[LIVE(), msg(1, { urgent: true })]]);
  await $.turn.start({ text: 'x', turnId: 't1' });
  await start($, h);
  expect(h.aborted).toEqual(['t1']);
  expect(h.submitted).toHaveLength(1);
  expect(h.submitted[0]).toMatch(/background/);
});

test('urgent mail during a tool call aborts once the 20 s grace passes', async ($, on) => {
  let release!: () => void;
  on('tool.call', () => new Promise((r) => (release = () => r({ result: 'ok', text: 'ok' }))));
  const h = harness(on, [[LIVE(), msg(1, { urgent: true })]]);
  await $.turn.start({ text: 'x', turnId: 't1' });
  const call = $.tool.call({ tool: 'Bash', command: 'sleep 99' });
  await start($, h);
  await h.clock.advance(19_000);
  expect(h.aborted).toEqual([]);
  await h.clock.advance(1_000);
  expect(h.aborted).toEqual(['t1']);
  expect(h.submitted[0]).toMatch(/background/);
  release();
  await call;
});

test('urgent mail during a tool call: a main-thread step within the grace cancels the abort', async ($, on) => {
  let release!: () => void;
  on('tool.call', () => new Promise((r) => (release = () => r({ result: 'ok', text: 'ok' }))));
  const h = harness(on, [[LIVE(), msg(1, { urgent: true })]]);
  await $.turn.start({ text: 'x', turnId: 't1' });
  const call = $.tool.call({ tool: 'Bash', command: 'sleep 99' });
  await start($, h);
  release();
  await call;
  await step($, 't1'); // the row rides this request
  await h.clock.advance(25_000);
  expect(h.appended).toHaveLength(1);
  expect(h.aborted).toEqual([]);
  expect(h.submitted).toEqual([]);
});

test('a handled urgent message is not preempted after its grace', async ($, on) => {
  on('tool.call', () => new Promise(() => {}));
  const h = harness(on, [[LIVE(), msg(1, { urgent: true }), { type: 'handled', id: 'u1' }]]);
  await $.turn.start({ text: 'x', turnId: 't1' });
  void $.tool.call({ tool: 'Bash', command: 'sleep 99' });
  await start($, h);
  await h.clock.advance(25_000);
  expect(h.appended).toHaveLength(1);
  expect(h.aborted).toEqual([]);
  expect(h.submitted).toEqual([]);
});

test('urgent mail past the preemption budget is handled as normal mail', async ($, on) => {
  const h = harness(on, [[LIVE(false), ...[1, 2, 3, 4].map((n) => msg(n, { urgent: true }))]]);
  await start($, h);
  expect(h.submitted).toHaveLength(3);
  expect(h.appended).toHaveLength(4);
});

test('a rejected turn.abort falls back to the notice without the interruption warning', async ($, on) => {
  const h = harness(on, [[LIVE(), msg(1, { urgent: true })]], {
    abort: () => ({ deny: 'turn already ended' })
  });
  await $.turn.start({ text: 'x', turnId: 't1' });
  await start($, h);
  expect(h.submitted).toHaveLength(1);
  expect(h.submitted[0]).not.toMatch(/background/);
});

test("a subagent's step or tool call leaves late and the in-flight count alone", async ($, on) => {
  on('tool.call', () => new Promise(() => {}));
  const h = harness(on, [[LIVE(), msg(1, { urgent: true })]]);
  await $.turn.start({ text: 'x', turnId: 't1' });
  void $.tool.call({ tool: 'Bash', command: 'x' }); // main thread: in flight
  await start($, h);
  await step($, 't1', 'sub-1'); // a subagent step must NOT clear late
  await h.clock.advance(20_000);
  expect(h.aborted).toEqual(['t1']);
});

test('a hot reload while live restores the original prompt check, not the live value', async ($, on) => {
  // A reload re-runs session.start while the old watcher has the seam set 'off'. The second
  // watcher outlives the first, so its restore is the one that sticks.
  const h = harness(on, [[LIVE(), { pause: 1_000 }]], {
    env: { [PROMPT_CHECK]: 'on' },
    respawn: [[LIVE(), { pause: 2_000 }]]
  });
  await start($, h);
  expect(h.env.get(PROMPT_CHECK)).toBe('off');
  await start($, h); // the reload: the env already reads 'off'
  await h.clock.advance(2_000);
  expect(h.spawns).toHaveLength(2);
  expect(h.env.get(PROMPT_CHECK)).toBe('on');
});

test('a hot reload restores an unset prompt check to unset', async ($, on) => {
  const h = harness(on, [[LIVE(), { pause: 1_000 }]], { respawn: [[LIVE(), { pause: 2_000 }]] });
  await start($, h);
  expect(h.env.get(PROMPT_CHECK)).toBe('off');
  await start($, h);
  await h.clock.advance(2_000);
  expect(h.env.has(PROMPT_CHECK)).toBe(false);
});

test('respawns of a watcher that never went live back off 5 s × 2^n to 5 min; live resets it', async ($, on) => {
  // Seven exits with no line, then one that goes live, then an exit with no line again.
  const h = harness(on, [[], [], [], [], [], [], [], [LIVE()], []]);
  await start($, h);
  // Gaps before each respawn: 5, 10, 20, 40, 80, 160 s, then the 300 s cap.
  for (const [i, gap] of [5, 10, 20, 40, 80, 160, 300].entries()) {
    await h.clock.advance(gap * 1_000 - 1);
    expect(h.spawns).toHaveLength(i + 1);
    await h.clock.advance(1);
    expect(h.spawns).toHaveLength(i + 2);
  }
  // The eighth watcher went live: the count resets, so the next respawn is 5 s away.
  await h.clock.advance(5_000);
  expect(h.spawns).toHaveLength(9);
});
