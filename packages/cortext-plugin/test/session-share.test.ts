// Engine tests for read-only session sharing (src/session-share.ts), run by
// `claude plugin test packages/cortext-plugin`. The `on` hooks stand for the engine and the
// substrate MCP server, which keeps feeds and events in memory as the server would.
import { expect, mock, test } from 'claude-code/testing';

const ME = 'synoptic-claude@host-a';
const STRANGER = 'peer-claude@host-b';
const INSTANCE = 'session:1a2b3c4d';

type Feed = {
  id: string;
  instance: string;
  title: string;
  project: string | null;
  lastEventAt: string;
  sharing: boolean;
  archived: boolean;
  _metadata: { createdBy: { id: string } };
};
type Event = { feed: string; step: number; kind: string; text: string; tool: string | null };
type Write = { op: string; params: Record<string, unknown> };
type Where = Record<string, { eq?: unknown; gt?: number }>;

const PANE = {
  plugin: 'cortext',
  component: 'Pane',
  requestId: 'cortext-session',
  props: {
    title: 'Shared session',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {}
  }
} as const;

/**
 * Fakes beneath the plugin. `writes` collects every mutate; `lookups` every SessionFeed read's
 * `where`. `kid` is what whoami answers, '' for no identity.
 */
// biome-ignore lint/suspicious/noExplicitAny: the kit's `on` is typed per event; the fakes are not
function server(on: any, opts: { kid?: string; feeds?: Feed[]; events?: Event[] } = {}) {
  const clock = mock.clock(on);
  const kid = opts.kid ?? ME;
  const feeds: Feed[] = [...(opts.feeds ?? [])];
  const events: Event[] = [...(opts.events ?? [])];
  const writes: Write[] = [];
  const lookups: Where[] = [];
  const logs: string[] = [];

  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }));
  on('session.id', async () => ({ value: '1a2b3c4d-0000-0000-0000-000000000000' }));
  on('command.register', async () => ({ value: undefined }));
  on('env.get', async () => ({ value: undefined }));
  on('env.set', async () => ({ value: undefined }));
  on('ui.open', async () => ({ value: { isPlaced: true } }));
  on('ui.log', async (_$: unknown, e: { text: string }) => {
    logs.push(e.text);
    return { value: undefined };
  });
  // The inbox watcher: no identity here, so it stands down at once.
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: `${JSON.stringify({ type: 'status', state: 'disabled' })}\n` };
    return { value: { code: 0, signal: null } };
  });
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }));
  on('turn.complete', async () => ({ text: '' }));
  on(
    'mcp.call',
    async (
      _$: unknown,
      e: {
        tool: string;
        args?: { payload?: Record<string, { params?: Record<string, unknown> }> };
      }
    ) => {
      const answer = (body: unknown) => ({
        value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false }
      });
      if (e.tool === 'whoami')
        return answer({ authEnabled: true, identity: kid ? { kid, grant: '*' } : null });
      const [key, frame] = Object.entries(e.args?.payload ?? {})[0] ?? ['', {}];
      const params = frame.params ?? {};
      const where = (params.where ?? {}) as Where;
      if (e.tool === 'query' && key === 'cortext/SessionFeed') {
        lookups.push(where);
        const rows = feeds.filter(
          (f) =>
            (where.instance === undefined || f.instance === where.instance.eq) &&
            (where.createdBy === undefined || f._metadata.createdBy.id === where.createdBy.eq) &&
            (where.sharing === undefined || f.sharing === where.sharing.eq)
        );
        return answer({ data: { [key]: rows } });
      }
      if (e.tool === 'query' && key === 'cortext/SessionFeedEvent') {
        const mine = events.filter(
          (ev) => ev.feed === where.feed?.eq && ev.step > (where.step?.gt ?? 0)
        );
        const desc = (params.orderBy as { step?: string }[] | undefined)?.[0]?.step === 'desc';
        const rows = desc ? [...mine].sort((a, b) => b.step - a.step).slice(0, 1) : mine;
        return answer({ data: { [key]: rows } });
      }
      if (e.tool === 'mutate') {
        const op = key.slice('cortext/'.length);
        writes.push({ op, params });
        if (op === 'createSessionFeed') {
          const id = `f${feeds.length + 1}`;
          feeds.push({
            id,
            sharing: true,
            archived: false,
            ...(params as Omit<Feed, 'id' | 'sharing' | 'archived' | '_metadata'>),
            _metadata: { createdBy: { id: kid } }
          });
          return answer({ data: { [key]: { id } } });
        }
        if (op === 'createSessionFeedEvent') events.push(params as unknown as Event);
        if (op === 'updateSessionFeed') {
          const f = feeds.find((x) => x.id === params.id);
          if (f) Object.assign(f, params);
        }
        return answer({ data: { [key]: { id: String(params.id ?? 'e') } } });
      }
      return answer({ data: {} });
    }
  );
  return { clock, feeds, events, writes, lookups, logs };
}

// biome-ignore lint/suspicious/noExplicitAny: the engine's `$` as the kit hands it
type Engine = any;

const start = async ($: Engine, h: { clock: { settle: () => Promise<void> } }) => {
  await $.session.start({ cwd: '/repo/example', surface: null, isInteractive: true });
  await h.clock.settle();
};
const typed = ($: Engine, text: string) =>
  $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false });
const answered = ($: Engine, answer: string) =>
  $.turn.complete({ turnId: 't1', reason: 'answer', answer, durationMs: 0, isAborted: false });
const share = async ($: Engine, arg: string) =>
  ((await $.command.run({ command: 'cortext-share', args: arg })) as { text: string }).text;

test('shares nothing until the person turns it on', async ($, on) => {
  const h = server(on);
  await start($, h);
  await typed($, 'Fix the flaky test');
  await answered($, 'Fixed it.');
  await h.clock.settle();
  expect(h.writes).toEqual([]);
  expect(await share($, '')).toContain('Sharing is off for session:1a2b3c4d');
});

test("shares the person's prompts and the replies, never a plugin's prompt", async ($, on) => {
  const h = server(on);
  await start($, h);
  expect(await share($, 'on')).toContain('Viewers can only watch');
  await typed($, 'Fix the flaky test');
  await $.prompt.submit({ text: 'New agent mail is above.', origin: { kind: 'plugin' } });
  await answered($, 'Fixed it.');
  await h.clock.settle();

  // Its own feed is found by its instance AND its owner.
  expect(h.lookups[0]).toEqual({ instance: { eq: INSTANCE }, createdBy: { eq: ME } });
  const made = h.writes.find((w) => w.op === 'createSessionFeed');
  expect(made?.params).toMatchObject({
    instance: INSTANCE,
    title: 'Fix the flaky test',
    project: 'example'
  });
  expect(h.events.map((ev) => [ev.step, ev.kind, ev.text])).toEqual([
    [1, 'prompt', 'Fix the flaky test'],
    [2, 'reply', 'Fixed it.']
  ]);
});

test('never writes into a feed another key made under the same instance', async ($, on) => {
  const h = server(on, {
    feeds: [
      {
        id: 'theirs',
        instance: INSTANCE,
        title: 'squatted',
        project: null,
        lastEventAt: '2026-11-25T00:00:00Z',
        sharing: true,
        archived: false,
        _metadata: { createdBy: { id: STRANGER } }
      }
    ]
  });
  await start($, h);
  await share($, 'on');
  await typed($, 'hello');
  await h.clock.settle();
  expect(h.events.map((ev) => ev.feed)).toEqual(['f2']);
  expect(h.writes.some((w) => w.params.id === 'theirs')).toBe(false);
});

test('turning it off marks the feed and stops the writes', async ($, on) => {
  const h = server(on);
  await start($, h);
  await share($, 'on');
  await typed($, 'one');
  await h.clock.settle();
  expect(await share($, 'off')).toContain('Sharing is off');
  await typed($, 'two');
  await h.clock.settle();
  expect(h.writes.at(-1)).toEqual({
    op: 'updateSessionFeed',
    params: { id: 'f1', sharing: false }
  });
  expect(h.events.map((ev) => ev.text)).toEqual(['one']);
});

test('will not share without a substrate key', async ($, on) => {
  const h = server(on, { kid: '' });
  await start($, h);
  expect(await share($, 'on')).toContain('whoami named none');
  await typed($, 'hello');
  await h.clock.settle();
  expect(h.writes).toEqual([]);
  expect(await share($, '')).toContain('Sharing is off');
});

test('the watch pane names each owner, shows the steps and offers no way to send', async ($, on) => {
  const theirs = (id: string, instance: string, owner: string, title: string) => ({
    id,
    instance,
    title,
    project: 'example',
    lastEventAt: '2026-11-25T00:00:00Z',
    sharing: true,
    archived: false,
    _metadata: { createdBy: { id: owner } }
  });
  const h = server(on, {
    feeds: [
      theirs('mine', INSTANCE, ME, 'my own session'),
      theirs('peer', 'session:99887766', STRANGER, 'wire the relay')
    ],
    events: [
      { feed: 'peer', step: 1, kind: 'prompt', text: 'Wire the relay', tool: null },
      { feed: 'peer', step: 2, kind: 'tool', text: 'relay.ts', tool: 'Edit' },
      { feed: 'peer', step: 3, kind: 'reply', text: 'Relay wired.', tool: null }
    ]
  });
  await start($, h);
  await $.command.run({ command: 'cortext-watch', args: '' });

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const pick = (await ui.find({ type: 'Select', key: 'feed-pick' })) as {
      props: { options: { value: string; label: string }[] };
    };
    // This session's own feed is left out; the other is named by the key that created it.
    expect(
      pick.props.options.map((o) => o.value),
      surface
    ).toEqual(['peer']);
    expect(pick.props.options[0]?.label).toContain(STRANGER);
    await ui.select({ key: 'feed-pick', value: 'peer' });
    expect(await ui.find({ type: 'Text', text: /shared by peer-claude@host-b/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: 'Wire the relay' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /Edit · relay\.ts/ })).toBeDefined();
    expect(await ui.find({ type: 'Input' }), `read-only on ${surface}`).toBeUndefined();
    await ui.unmount();
  }
  expect(h.writes).toEqual([]);
});
