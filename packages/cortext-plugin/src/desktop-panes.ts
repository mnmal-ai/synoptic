import type { EngineInterface, On, RenderElement } from 'claude-code';
import { atom, read, update } from 'claude-code';
import type { FeedEvent, FeedRow, PaneTodo, TodoDraft } from '../types';
import { controlKids, cut, hostOf, remoteTurnText, toolSummary } from './pane-text.js';

// Two panes and one opt-in, all through the session's own substrate MCP server,
// so every write is signed by this repo's key:
// - Todos: list, create, edit and close the store's Todos.
// - Remote session: a read-only view of another session that turned sharing on.
// - /cortext-share on|off: publish this session's prompts, replies and tool names.
// - /cortext-share control <kid>[,<kid>]: also run turns those kids send from their pane.
//   The check is on _metadata.createdBy, which the server sets from the signing key.

const TODOS_PANE = 'cortext-todos';
const SESSION_PANE = 'cortext-session';
const POLL_MS = 4_000;
const TITLE_MAX = 80;
const TEXT_MAX = 4_000;
const TOOL_TEXT_MAX = 160;
const EVENTS_KEPT = 300;
const PRIORITIES = ['high', 'medium', 'low'] as const;
const STATUSES = ['open', 'in_progress', 'blocked', 'deferred'] as const;

const todos = atom({ plugin: 'cortext', key: 'paneTodos' }, []);
const todoScope = atom({ plugin: 'cortext', key: 'paneTodoScope' }, 'project');
const editing = atom({ plugin: 'cortext', key: 'paneEditing' }, null);
const paneNote = atom({ plugin: 'cortext', key: 'paneNote' }, '');
const feeds = atom({ plugin: 'cortext', key: 'paneFeeds' }, []);
const watched = atom({ plugin: 'cortext', key: 'paneWatched' }, null);
const events = atom({ plugin: 'cortext', key: 'paneEvents' }, []);
const SHARE = { plugin: 'cortext', key: 'shareOn' } as const;
const FEED = { plugin: 'cortext', key: 'shareFeed' } as const;
const STEP = { plugin: 'cortext', key: 'shareStep' } as const;
const CONTROL = { plugin: 'cortext', key: 'shareControlFrom' } as const;

// What the hooks share. Module variables reset on every reload; what must survive one lives in $.state.
export type Panes = {
  ns: string;
  server: string; // the substrate MCP server's name as /mcp lists it
  project: string;
  instance: string; // `session:<8 hex>`, the tag the cold-start names
  host: string;
  kid: string; // this session's signing kid, which a sharer names to let it send turns
  writes: Promise<void>; // feed writes run one after another, so steps never race
  poll: { cancel: () => void } | undefined;
  turnPoll: { cancel: () => void } | undefined;
};

/** One element: `h` with its result narrowed to what a Box child and a render hook take. */
function el(...args: Parameters<typeof h>): RenderElement {
  // biome-ignore lint/correctness/noUndeclaredVariables: `h` is the engine's global JSX factory in a hooks module
  return h(...args) as RenderElement;
}

/** The text of an MCP tool result, parsed as JSON. Throws with the server's words on an error. */
async function sub(p: Panes, $: EngineInterface, tool: string, args: Record<string, unknown>) {
  const r = await $.mcp.call(p.server, tool, args);
  const text = r.content
    .map((c) => (c.type === 'text' ? (c as { text: string }).text : ''))
    .join('');
  if (r.isError) throw new Error(cut(text || `${tool} failed`, 200));
  const body = JSON.parse(text) as {
    data?: Record<string, unknown>;
    errors?: { message: string; code?: string }[];
    ok?: boolean;
  };
  if (body.errors && body.errors.length > 0) {
    const err = new Error(cut(body.errors[0]?.message ?? 'refused', 200)) as Error & {
      code?: string;
    };
    err.code = body.errors[0]?.code;
    throw err;
  }
  return body;
}

async function query<T>(p: Panes, $: EngineInterface, type: string, frame: object): Promise<T[]> {
  const key = `${p.ns}/${type}`;
  const body = await sub(p, $, 'query', { payload: { [key]: frame } });
  const rows = body.data?.[key];
  // A rejected frame is absent from data; an empty list is a real "nothing matched".
  if (!Array.isArray(rows)) throw new Error(`${key} did not come back`);
  return rows as T[];
}

async function mutate<T>(p: Panes, $: EngineInterface, op: string, params: object): Promise<T> {
  const key = `${p.ns}/${op}`;
  const body = await sub(p, $, 'mutate', {
    payload: { [key]: { params, fields: { id: true } } }
  });
  const row = body.data?.[key];
  if (row === undefined) throw new Error(`${key} did not come back`);
  return row as T;
}

async function note($: EngineInterface, text: string): Promise<void> {
  await update($, paneNote, () => text);
}

// --- Todos ---------------------------------------------------------------

async function loadTodos(p: Panes, $: EngineInterface): Promise<void> {
  const scope = await read($, todoScope);
  const and: object[] = [
    { archived: { eq: false } },
    { status: { in: ['open', 'in_progress', 'blocked'] } }
  ];
  if (scope === 'project') {
    and.push({ OR: [{ project: { eq: p.project } }, { project: { eq: null } }] });
  }
  const rows: PaneTodo[] = [];
  let cursor: string | undefined;
  // Page to the end: a list cut at the limit would hide todos without saying so.
  for (let page = 0; page < 20; page++) {
    const key = `${p.ns}/Todo`;
    const body = await sub(p, $, 'query', {
      payload: {
        [key]: {
          params: { where: { AND: and }, limit: 200, ...(cursor ? { cursor } : {}) },
          fields: {
            id: true,
            shortId: true,
            title: true,
            area: true,
            status: true,
            priority: true,
            project: true
          }
        }
      }
    });
    const got = body.data?.[key];
    if (!Array.isArray(got)) throw new Error(`${key} did not come back`);
    rows.push(...(got as PaneTodo[]));
    const pg = (
      body as { _pagination?: Record<string, { hasMore?: boolean; nextCursor?: string }> }
    )._pagination?.[key];
    if (!pg?.hasMore || !pg.nextCursor) break;
    cursor = pg.nextCursor;
  }
  const rank = (t: PaneTodo): number =>
    PRIORITIES.indexOf(t.priority as (typeof PRIORITIES)[number]);
  rows.sort((a, b) => rank(a) - rank(b) || b.shortId - a.shortId);
  await update($, todos, () => rows);
}

async function refreshTodos(p: Panes, $: EngineInterface): Promise<void> {
  try {
    await loadTodos(p, $);
    await note($, '');
  } catch (err) {
    await note($, `Could not load todos: ${(err as Error).message}`);
  }
}

async function createTodo(p: Panes, $: EngineInterface, title: string): Promise<void> {
  const clean = cut(title, 300);
  if (clean === '') return;
  try {
    const row = await mutate<{ id: string }>(p, $, 'createTodo', {
      title: clean,
      area: 'general',
      priority: 'medium',
      project: p.project
    });
    await note($, `Created a todo (${row.id.slice(0, 8)}).`);
    await loadTodos(p, $);
  } catch (err) {
    await note($, `Could not create the todo: ${(err as Error).message}`);
  }
}

async function closeTodo(p: Panes, $: EngineInterface, t: PaneTodo): Promise<void> {
  try {
    // `close` is the store's own word: closed, resolution completed, archived. Undo: reopen the row.
    await sub(p, $, 'act', { sketch: `close Todo #${t.shortId}` });
    await note($, `Closed #${t.shortId}.`);
    await loadTodos(p, $);
  } catch (err) {
    await note($, `Could not close #${t.shortId}: ${(err as Error).message}`);
  }
}

async function saveTodo(p: Panes, $: EngineInterface, draft: TodoDraft): Promise<void> {
  try {
    await mutate(p, $, 'updateTodo', {
      id: draft.id,
      title: cut(draft.title, 300),
      area: cut(draft.area, 60) || 'general',
      priority: draft.priority,
      status: draft.status
    });
    await update($, editing, () => null);
    await note($, `Saved #${draft.shortId}.`);
    await loadTodos(p, $);
  } catch (err) {
    await note($, `Could not save #${draft.shortId}: ${(err as Error).message}`);
  }
}

async function drawTodos(
  p: Panes,
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0]
) {
  const { Box, Text, Button, Input, Select } = $.ui.resolve(e);
  const list = await read($, todos);
  const scope = await read($, todoScope);
  const draft = await read($, editing);
  const said = await read($, paneNote);

  const row = (t: PaneTodo): RenderElement =>
    draft?.id === t.id
      ? el(
          Box,
          {
            key: `edit-${t.id}`,
            flexDirection: 'column',
            borderStyle: 'round',
            paddingX: 1,
            gap: 1
          },
          el(Text, { bold: true }, `#${t.shortId}`),
          el(Input, {
            key: `title-${t.id}`,
            label: 'Title',
            value: draft.title,
            autoFocus: true,
            onInput: (v: string) => void update($, editing, (d) => (d ? { ...d, title: v } : d)),
            onSubmit: () => void read($, editing).then((d) => d && saveTodo(p, $, d))
          }),
          el(Input, {
            key: `area-${t.id}`,
            label: 'Area',
            value: draft.area,
            onInput: (v: string) => void update($, editing, (d) => (d ? { ...d, area: v } : d)),
            onSubmit: () => void read($, editing).then((d) => d && saveTodo(p, $, d))
          }),
          el(Select, {
            key: `pri-${t.id}`,
            label: 'Priority',
            value: draft.priority,
            options: PRIORITIES.map((v) => ({ value: v })),
            onSelect: (v: string) => void update($, editing, (d) => (d ? { ...d, priority: v } : d))
          }),
          el(Select, {
            key: `status-${t.id}`,
            label: 'Status',
            value: draft.status,
            options: STATUSES.map((v) => ({ value: v })),
            onSelect: (v: string) => void update($, editing, (d) => (d ? { ...d, status: v } : d))
          }),
          el(
            Box,
            { flexDirection: 'row', gap: 1 },
            el(Button, {
              key: `save-${t.id}`,
              label: 'Save',
              onPress: () => void read($, editing).then((d) => d && saveTodo(p, $, d))
            }),
            el(Button, {
              key: `cancel-${t.id}`,
              label: 'Cancel',
              onPress: () => void update($, editing, () => null)
            })
          )
        )
      : el(
          Box,
          { key: `row-${t.id}`, flexDirection: 'row', gap: 1 },
          el(
            Box,
            { flexGrow: 1 },
            el(
              Text,
              { wrap: 'truncate-end' },
              el(Text, { dimColor: true }, `#${t.shortId} `),
              el(Text, { bold: t.priority === 'high' }, `${t.priority.padEnd(6)} `),
              t.status === 'open' ? '' : el(Text, { dimColor: true }, `[${t.status}] `),
              t.title,
              scope === 'all'
                ? el(Text, { dimColor: true }, `  ${t.project ?? 'cross-cutting'}`)
                : ''
            )
          ),
          el(Button, {
            key: `edit-btn-${t.id}`,
            label: 'Edit',
            onPress: () =>
              void update($, editing, () => ({
                id: t.id,
                shortId: t.shortId,
                title: t.title,
                area: t.area,
                priority: t.priority,
                status: t.status
              }))
          }),
          el(Button, {
            key: `close-btn-${t.id}`,
            label: 'Close',
            onPress: () => void closeTodo(p, $, t)
          })
        );

  return el(
    Box,
    { flexDirection: 'column', gap: 1 },
    el(
      Box,
      { flexDirection: 'row', gap: 1 },
      el(Select, {
        key: 'todo-scope',
        label: 'Show',
        value: scope,
        options: [
          { value: 'project', label: `${p.project} + cross-cutting` },
          { value: 'all', label: 'All projects' }
        ],
        onSelect: (v: string) =>
          void update($, todoScope, () => (v === 'all' ? 'all' : 'project')).then(() =>
            refreshTodos(p, $)
          )
      }),
      el(Button, { key: 'todo-refresh', label: 'Refresh', onPress: () => void refreshTodos(p, $) })
    ),
    el(Input, {
      key: 'todo-new',
      placeholder: `New todo in ${p.project}`,
      submitLabel: 'add',
      value: '',
      onSubmit: (v: string) => void createTodo(p, $, v)
    }),
    said ? el(Text, { dimColor: true }, said) : null,
    el(Text, { dimColor: true }, `${list.length} open`),
    ...list.map(row)
  );
}

// --- Sharing this session ------------------------------------------------

function enqueue(p: Panes, job: () => Promise<void>): void {
  // A failed write is dropped, never retried forever: the feed is a view, not a record.
  p.writes = p.writes.then(job).catch(() => {});
}

async function ensureFeed(p: Panes, $: EngineInterface, title: string): Promise<string> {
  const { value: known } = await $.state.get(FEED);
  if (known) return known;
  const found = await query<{ id: string }>(p, $, 'SessionFeed', {
    params: { where: { instance: { eq: p.instance } }, limit: 1 },
    fields: { id: true }
  });
  const at = new Date(await $.clock.now()).toISOString();
  let id = found[0]?.id;
  if (id) {
    await mutate(p, $, 'updateSessionFeed', { id, sharing: true, lastEventAt: at });
  } else {
    const row = await mutate<{ id: string }>(p, $, 'createSessionFeed', {
      instance: p.instance,
      host: p.host,
      title: cut(title || p.project, TITLE_MAX),
      lastEventAt: at,
      project: p.project
    });
    id = row.id;
  }
  await $.state.set(FEED, id);
  return id;
}

async function latestStep(p: Panes, $: EngineInterface, feed: string): Promise<number> {
  const rows = await query<{ step: number }>(p, $, 'SessionFeedEvent', {
    params: { where: { feed: { eq: feed } }, orderBy: [{ step: 'desc' }], limit: 1 },
    fields: { step: true }
  });
  return rows[0]?.step ?? 0;
}

async function publish(
  p: Panes,
  $: EngineInterface,
  kind: FeedEvent['kind'],
  text: string,
  tool?: string
): Promise<void> {
  const { value: on } = await $.state.get(SHARE);
  if (on !== true || text.trim() === '') return;
  enqueue(p, async () => {
    const feed = await ensureFeed(p, $, kind === 'prompt' ? text : '');
    const { value: last } = await $.state.get(STEP);
    let step = (last ?? (await latestStep(p, $, feed))) + 1;
    const write = () =>
      mutate(p, $, 'createSessionFeedEvent', {
        feed,
        step,
        kind,
        text: cut(text, kind === 'tool' ? TOOL_TEXT_MAX : TEXT_MAX),
        tool: tool ?? null,
        project: p.project
      });
    try {
      await write();
    } catch (err) {
      // Another writer took the step (a reload, a second window): read the latest and go one past it.
      if ((err as { code?: string }).code !== 'unique_violation') throw err;
      step = (await latestStep(p, $, feed)) + 1;
      await write();
    }
    await $.state.set(STEP, step);
    await mutate(p, $, 'updateSessionFeed', {
      id: feed,
      lastEventAt: new Date(await $.clock.now()).toISOString()
    });
  });
}

async function setSharing(p: Panes, $: EngineInterface, on: boolean): Promise<string> {
  await $.state.set(SHARE, on);
  if (!on) {
    await $.state.set(CONTROL, []);
    p.turnPoll?.cancel();
    p.turnPoll = undefined;
  }
  const { value: feed } = await $.state.get(FEED);
  if (!on && feed) {
    enqueue(p, async () => {
      await mutate(p, $, 'updateSessionFeed', { id: feed, sharing: false });
    });
    return 'Sharing is off. Viewers keep what was already shared; new steps stay here.';
  }
  return on
    ? `Sharing is on for ${p.instance}. Your prompts, replies and tool names (not tool output) go to Substrate, where any agent with read access can see them. Turn it off with /cortext-share off.`
    : 'Sharing is off.';
}

async function takeTurns(p: Panes, $: EngineInterface): Promise<void> {
  const { value: feed } = await $.state.get(FEED);
  const { value: allowed } = await $.state.get(CONTROL);
  if (!feed) return;
  const rows = await query<{
    id: string;
    text: string;
    _metadata: { createdBy?: { id?: string } };
  }>(p, $, 'SessionTurn', {
    params: {
      where: { feed: { eq: feed }, status: { eq: 'queued' } },
      orderBy: [{ createdAt: 'asc' }],
      limit: 5
    },
    fields: { id: true, text: true, _metadata: { createdBy: true } }
  });
  for (const t of rows) {
    const from = t._metadata.createdBy?.id ?? '';
    if (!(allowed ?? []).includes(from)) {
      await mutate(p, $, 'updateSessionTurn', {
        id: t.id,
        status: 'refused',
        reason: `${from || 'an unsigned writer'} is not allowed to send turns to ${p.instance}`
      });
      continue;
    }
    // Mark it taken before running it, so a second poll never runs it twice.
    await mutate(p, $, 'updateSessionTurn', { id: t.id, status: 'taken' });
    await $.ui.toast(`Running a remote turn from ${from}`);
    // Never awaited: submit resolves when the turn starts, which may wait for the current one.
    $.prompt.submit({ text: remoteTurnText(from, cut(t.text, TEXT_MAX)) }).catch(() => {});
  }
}

async function allowControl(p: Panes, $: EngineInterface, args: string): Promise<string> {
  const kids = controlKids(args);
  if (kids.length === 0) {
    return 'Name who may send turns: /cortext-share control <kid>[,<kid>]. The viewer sees its kid at the top of its Remote session pane.';
  }
  const on = await setSharing(p, $, true);
  await $.state.set(CONTROL, kids);
  p.turnPoll?.cancel();
  p.turnPoll = $.clock.every(POLL_MS, () => void takeTurns(p, $).catch(() => {}));
  return `${on}\n\n${kids.join(', ')} can now send turns to this session. Each runs here as a prompt, with this session's permissions. /cortext-share off stops both.`;
}

async function sendTurn(p: Panes, $: EngineInterface, text: string): Promise<void> {
  const feed = await read($, watched);
  const clean = text.trim();
  if (!feed || clean === '') return;
  try {
    await mutate(p, $, 'createSessionTurn', {
      feed,
      text: cut(clean, TEXT_MAX),
      project: p.project
    });
    await note($, `Sent. It runs only if that session allowed ${p.kid}.`);
  } catch (err) {
    await note($, `Could not send the turn: ${(err as Error).message}`);
  }
}

// --- Watching a remote session -------------------------------------------

async function loadFeeds(p: Panes, $: EngineInterface): Promise<void> {
  try {
    const rows = await query<FeedRow>(p, $, 'SessionFeed', {
      params: {
        where: { sharing: { eq: true }, archived: { eq: false } },
        orderBy: [{ lastEventAt: 'desc' }],
        limit: 50
      },
      fields: {
        id: true,
        instance: true,
        host: true,
        title: true,
        project: true,
        lastEventAt: true
      }
    });
    await update($, feeds, () => rows.filter((r) => r.instance !== p.instance));
  } catch (err) {
    await note($, `Could not list shared sessions: ${(err as Error).message}`);
  }
}

async function pollEvents(p: Panes, $: EngineInterface): Promise<void> {
  const feed = await read($, watched);
  if (!feed) return;
  const have = await read($, events);
  const after = have.at(-1)?.step ?? 0;
  try {
    const rows = await query<FeedEvent>(p, $, 'SessionFeedEvent', {
      params: {
        where: { feed: { eq: feed }, step: { gt: after } },
        orderBy: [{ step: 'asc' }],
        limit: 500
      },
      fields: { step: true, kind: true, text: true, tool: true }
    });
    if (rows.length > 0) await update($, events, (old) => [...old, ...rows].slice(-EVENTS_KEPT));
  } catch (err) {
    await note($, `Could not read the session: ${(err as Error).message}`);
  }
}

async function watch(p: Panes, $: EngineInterface, feed: string): Promise<void> {
  await update($, watched, () => feed);
  await update($, events, () => []);
  await pollEvents(p, $);
  p.poll?.cancel();
  p.poll = $.clock.every(POLL_MS, () => void pollEvents(p, $));
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

async function drawSession(
  p: Panes,
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0]
) {
  const els = $.ui.resolve(e);
  const { Box, Text, Button, Select, Input } = els;
  const Markdown = (els as unknown as { Markdown?: typeof Text }).Markdown;
  const list = await read($, feeds);
  const feed = await read($, watched);
  const shown = await read($, events);
  const said = await read($, paneNote);
  const now = await $.clock.now();
  const room = Math.max(3, ((e as { viewport?: { rows?: number } }).viewport?.rows ?? 40) - 6);

  const step = (ev: FeedEvent): RenderElement => {
    if (ev.kind === 'tool') {
      return el(
        Box,
        { key: `ev-${ev.step}` },
        el(Text, { dimColor: true, wrap: 'truncate-end' }, `  ${ev.tool ?? 'tool'}: ${ev.text}`)
      );
    }
    if (ev.kind === 'prompt') {
      return el(
        Box,
        { key: `ev-${ev.step}`, borderStyle: 'round', paddingX: 1 },
        el(Text, { bold: true }, ev.text)
      );
    }
    return Markdown
      ? el(Markdown, { key: `ev-${ev.step}`, text: ev.text })
      : el(Box, { key: `ev-${ev.step}` }, el(Text, {}, ev.text));
  };

  const picked = list.find((f) => f.id === feed);
  return el(
    Box,
    { flexDirection: 'column', gap: 1 },
    el(
      Box,
      { flexDirection: 'row', gap: 1 },
      list.length > 0
        ? el(Select, {
            key: 'feed-pick',
            label: 'Session',
            value: feed ?? undefined,
            options: list.map((f) => ({
              value: f.id,
              label: `${f.host} · ${f.project ?? '—'} · ${cut(f.title, 40)} · ${ago(f.lastEventAt, now)}`
            })),
            onSelect: (v: string) => void watch(p, $, v)
          })
        : el(
            Text,
            { dimColor: true },
            'No session is shared. The other person turns it on with /cortext-share on.'
          ),
      el(Button, { key: 'feed-refresh', label: 'Refresh', onPress: () => void loadFeeds(p, $) })
    ),
    picked
      ? el(Text, { dimColor: true }, `${picked.instance} on ${picked.host} · your key: ${p.kid}`)
      : null,
    said ? el(Text, { dimColor: true }, said) : null,
    ...shown.slice(-room).map(step),
    picked
      ? el(Input, {
          key: 'feed-send',
          placeholder: `Send a turn to ${picked.host} (runs only if it allowed your key)`,
          submitLabel: 'send',
          value: '',
          rows: 2,
          onSubmit: (v: string) => void sendTurn(p, $, v)
        })
      : null
  );
}

// --- Wiring ---------------------------------------------------------------

/** The panes' shared state, made by the bridge and handed to registerPanes and startPanes. */
export function newPanes(): Panes {
  return {
    ns: 'cortext',
    server: 'substrate',
    project: 'unknown',
    instance: 'session:unknown',
    host: 'unknown',
    kid: 'unknown',
    writes: Promise.resolve(),
    poll: undefined,
    turnPoll: undefined
  };
}

/** Called from the bridge's main-thread tool.call hook: the tool's name and summary, never its output. */
export async function shareToolCall(
  p: Panes,
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>
): Promise<void> {
  await publish(p, $, 'tool', toolSummary(tool, input), tool);
}

/** Called from the bridge's main-thread turn.complete hook. */
export async function shareReply(p: Panes, $: EngineInterface, answer: string): Promise<void> {
  await publish(p, $, 'reply', answer);
}

/** Called from the bridge's session.start hook: one module registers that hook once. */
export async function startPanes(p: Panes, $: EngineInterface, cwd: string): Promise<void> {
  p.ns = (await $.env.get('SUBSTRATE_NAMESPACE')) || 'cortext';
  p.server = (await $.env.get('SYNOPTIC_SUBSTRATE_MCP')) || 'substrate';
  p.project = cwd.split('/').filter(Boolean).at(-1) ?? 'unknown';
  p.instance = `session:${(await $.session.id()).slice(0, 8)}`;
  try {
    const who = await sub(p, $, 'whoami', {});
    const kid = (who as { identity?: { kid?: string } }).identity?.kid ?? '';
    if (kid) p.kid = kid;
    p.host = hostOf(kid);
  } catch {
    // No substrate server here: the panes say so when opened.
  }
  for (const [name, description] of [
    ['cortext-todos', 'Open the Todos pane: list, create, edit and close todos'],
    ['cortext-watch', 'Open a read-only pane on another shared session'],
    ['cortext-share', 'Share this session: /cortext-share on | off | control <kid>[,<kid>]']
  ] as const) {
    await $.command.register({ name, description });
  }
}

export function registerPanes(on: On, p: Panes): void {
  on('command.run', { command: 'cortext-todos' }, async ($) => {
    await refreshTodos(p, $);
    await $.ui.open({ id: TODOS_PANE, title: 'Todos' });
    return { text: 'Todos pane opened.' };
  });

  on('command.run', { command: 'cortext-watch' }, async ($) => {
    await loadFeeds(p, $);
    await $.ui.open({ id: SESSION_PANE, title: 'Remote session' });
    return { text: 'Remote session pane opened. Pick a shared session at the top.' };
  });

  on('command.run', { command: 'cortext-share' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();
    if (arg.startsWith('control'))
      return { text: await allowControl(p, $, e.args.trim().slice(7)) };
    if (arg !== 'on' && arg !== 'off') {
      const { value } = await $.state.get(SHARE);
      const { value: kids } = await $.state.get(CONTROL);
      const who = kids && kids.length > 0 ? ` ${kids.join(', ')} can send turns.` : '';
      return {
        text: `Sharing is ${value === true ? 'on' : 'off'}.${who} Use /cortext-share on, off, or control <kid>.`
      };
    }
    return { text: await setSharing(p, $, arg === 'on') };
  });

  on('ui.close', { id: SESSION_PANE }, async (_$, e, next) => {
    p.poll?.cancel();
    p.poll = undefined;
    return next(e);
  });

  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined) await publish(p, $, 'prompt', e.text);
    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: TODOS_PANE }, async ($, e) => drawTodos(p, $, e));
  on('ui.render', { component: 'Pane', requestId: SESSION_PANE }, async ($, e) =>
    drawSession(p, $, e)
  );
}
