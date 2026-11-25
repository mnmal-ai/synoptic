import type { EngineInterface, On, RenderElement } from 'claude-code';
import { atom, read, update } from 'claude-code';
import type { FeedEvent, FeedRow, PaneTodo, TodoDetail } from '../types';
import {
  ago,
  controlKids,
  cut,
  hostOf,
  remoteTurnText,
  type TodoSort,
  type TodoView,
  toolSummary,
  viewTodos
} from './pane-text.js';

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
const editField = atom({ plugin: 'cortext', key: 'paneField' }, null);
const fieldDraft = atom({ plugin: 'cortext', key: 'paneFieldDraft' }, '');
const todoView = atom(
  { plugin: 'cortext', key: 'paneTodoView' },
  {
    sort: 'priority',
    status: 'any',
    priority: 'any',
    search: ''
  }
);
const paneNote = atom({ plugin: 'cortext', key: 'paneNote' }, '');
const selected = atom({ plugin: 'cortext', key: 'paneSelected' }, null);
const detail = atom({ plugin: 'cortext', key: 'paneDetail' }, null);
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
  const [tag, props, ...children] = args;
  // An undefined prop is left out: a surface checks props against an allowlist of set values.
  const set = props
    ? Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined))
    : props;
  // biome-ignore lint/correctness/noUndeclaredVariables: `h` is the engine's global JSX factory in a hooks module
  return h(tag, set, ...children) as RenderElement;
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

type Field = 'title' | 'area' | 'notes' | 'body' | 'blockedBy' | 'revisitWhen';

const SORTS: { value: TodoSort; label: string }[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Recently created' },
  { value: 'status', label: 'Status' },
  { value: 'title', label: 'Title' }
];

async function loadTodos(p: Panes, $: EngineInterface): Promise<void> {
  const scope = await read($, todoScope);
  const and: object[] = [
    { archived: { eq: false } },
    { status: { in: ['open', 'in_progress', 'blocked', 'deferred'] } }
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
            project: true,
            _metadata: { createdAt: true, updatedAt: true }
          }
        }
      }
    });
    const got = body.data?.[key];
    if (!Array.isArray(got)) throw new Error(`${key} did not come back`);
    for (const r of got as (PaneTodo & {
      _metadata?: { createdAt?: string; updatedAt?: string };
    })[]) {
      rows.push({ ...r, createdAt: r._metadata?.createdAt, updatedAt: r._metadata?.updatedAt });
    }
    const pg = (
      body as { _pagination?: Record<string, { hasMore?: boolean; nextCursor?: string }> }
    )._pagination?.[key];
    if (!pg?.hasMore || !pg.nextCursor) break;
    cursor = pg.nextCursor;
  }
  await update($, todos, () => rows);
}

/** The rows the list shows now, in its order. */
async function shown($: EngineInterface): Promise<PaneTodo[]> {
  return viewTodos(await read($, todos), await read($, todoView));
}

/** Keeps a pick that is still listed; otherwise picks the first row, as a settings sidebar does. */
async function keepPick(p: Panes, $: EngineInterface): Promise<void> {
  const rows = await shown($);
  const pick = await read($, selected);
  if (rows.some((t) => t.id === pick)) return;
  const first = rows[0];
  if (first) await selectTodo(p, $, first);
  else {
    await update($, selected, () => null);
    await update($, detail, () => null);
  }
}

async function refreshTodos(p: Panes, $: EngineInterface): Promise<void> {
  try {
    await loadTodos(p, $);
    await keepPick(p, $);
    await note($, '');
  } catch (err) {
    await note($, `Could not load todos: ${(err as Error).message}`);
  }
}

async function setView(p: Panes, $: EngineInterface, patch: Partial<TodoView>): Promise<void> {
  await update($, todoView, (v) => ({ ...v, ...patch }));
  await keepPick(p, $);
}

async function selectTodo(p: Panes, $: EngineInterface, t: PaneTodo): Promise<void> {
  await update($, selected, () => t.id);
  await update($, editField, () => null);
  try {
    const rows = await query<TodoDetail>(p, $, 'Todo', {
      params: { where: { id: { eq: t.id } }, limit: 1 },
      fields: {
        id: true,
        notes: true,
        body: true,
        blockedBy: true,
        revisitWhen: true,
        targetDate: true,
        _metadata: { createdAt: true, updatedAt: true }
      }
    });
    await update($, detail, () => rows[0] ?? null);
  } catch (err) {
    await note($, `Could not load #${t.shortId}: ${(err as Error).message}`);
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
    await loadTodos(p, $);
    const made = (await read($, todos)).find((t) => t.id === row.id);
    if (made) await selectTodo(p, $, made);
    await note($, '');
  } catch (err) {
    await note($, `Could not create the todo: ${(err as Error).message}`);
  }
}

async function closeTodo(p: Panes, $: EngineInterface, t: PaneTodo): Promise<void> {
  try {
    // `close` is the store's own word: closed, resolution completed, archived. Undo: reopen the row.
    await sub(p, $, 'act', { sketch: `close Todo #${t.shortId}` });
    // Pick the row that takes its place, so the detail never goes blank.
    const rows = await shown($);
    const at = rows.findIndex((r) => r.id === t.id);
    await loadTodos(p, $);
    const after = await shown($);
    const next = after[Math.min(Math.max(at, 0), after.length - 1)];
    if (next) await selectTodo(p, $, next);
    else await keepPick(p, $);
    await note($, `Closed #${t.shortId}.`);
  } catch (err) {
    await note($, `Could not close #${t.shortId}: ${(err as Error).message}`);
  }
}

/** Saves one field, or the priority or status, of the picked todo. */
async function saveField(
  p: Panes,
  $: EngineInterface,
  t: PaneTodo,
  patch: Partial<Record<Field | 'priority' | 'status', string | null>>
): Promise<void> {
  try {
    const clean = Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [
        k,
        typeof v === 'string' && v.trim() === '' ? null : v
      ])
    );
    if (clean.title === null) clean.title = t.title; // a todo always has a title
    if (clean.area === null) clean.area = 'general';
    await mutate(p, $, 'updateTodo', { id: t.id, ...clean });
    await update($, editField, () => null);
    await loadTodos(p, $);
    const fresh = (await read($, todos)).find((r) => r.id === t.id);
    if (fresh) await selectTodo(p, $, fresh);
    await note($, '');
  } catch (err) {
    await note($, `Could not save #${t.shortId}: ${(err as Error).message}`);
  }
}

type Els = ReturnType<EngineInterface['ui']['resolve']>;

/**
 * A compact control. On a desktop: an icon button whose name shows as a tooltip under the pointer.
 * On a terminal, which has no pointer hover: the name itself, with its hotkey.
 */
function iconButton(
  els: Els,
  tty: boolean,
  b: {
    key: string;
    icon: string;
    name: string;
    hotkey?: string;
    primary?: boolean;
    onPress: () => void;
  }
): RenderElement {
  const { Box, Text, Button } = els;
  if (tty) {
    return el(Button, {
      key: b.key,
      label: b.name,
      hotkey: b.hotkey,
      variant: b.primary ? 'primary' : undefined,
      onPress: b.onPress
    });
  }
  return el(
    Box,
    { key: `tip-${b.key}`, position: 'relative' },
    el(
      Button,
      { key: b.key, label: b.name, hotkey: b.hotkey, plain: true, onPress: b.onPress },
      b.icon
    ),
    el(
      Box,
      {
        position: 'absolute',
        top: 2,
        left: 0,
        display: 'none',
        hover: { display: 'flex' },
        backgroundColor: 'text',
        paddingX: 1
      },
      el(
        Text,
        { color: 'inverseText', size: 'caption', wrap: 'truncate-end' },
        b.hotkey ? `${b.name}  ${b.hotkey}` : b.name
      )
    )
  );
}

function priorityTone(t: PaneTodo): string {
  if (t.status === 'blocked') return 'error';
  if (t.priority === 'high') return 'warning';
  return t.priority === 'medium' ? 'text' : 'subtle';
}

async function drawTodos(
  p: Panes,
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0]
) {
  const els = $.ui.resolve(e);
  const { Box, Text, Button, Input, Select } = els;
  const Markdown = (els as unknown as { Markdown?: typeof Text }).Markdown;
  const tty = e.surface === 'terminal';
  const all = await read($, todos);
  const view = await read($, todoView);
  const rows = viewTodos(all, view);
  const scope = await read($, todoScope);
  const said = await read($, paneNote);
  const pick = await read($, selected);
  const more = await read($, detail);
  const field = await read($, editField);
  const draft = await read($, fieldDraft);
  const current = rows.find((t) => t.id === pick) ?? all.find((t) => t.id === pick);
  const now = await $.clock.now();
  const filtered = view.status !== 'any' || view.priority !== 'any' || view.search.trim() !== '';

  // Left: search, sort, filters, then the list. The picked row is filled with the accent.
  const master = el(
    Box,
    { flexDirection: 'column', width: '38%', gap: 1 },
    el(
      Box,
      { flexDirection: 'row', gap: 1 },
      el(
        Box,
        { flexGrow: 1 },
        el(Input, {
          key: 'todo-search',
          placeholder: 'Search todos',
          submitLabel: 'search',
          value: view.search,
          onInput: (v: string) => void setView(p, $, { search: v }),
          onSubmit: (v: string) => void setView(p, $, { search: v })
        })
      ),
      iconButton(els, tty, {
        key: 'todo-refresh',
        icon: '↻',
        name: 'Refresh',
        hotkey: 'r',
        onPress: () => void refreshTodos(p, $)
      })
    ),
    el(
      Box,
      { flexDirection: 'row', gap: 1, flexWrap: 'wrap' },
      el(Select, {
        key: 'todo-scope',
        value: scope,
        options: [
          { value: 'project', label: p.project },
          { value: 'all', label: 'All projects' }
        ],
        onSelect: (v: string) =>
          void update($, todoScope, () => (v === 'all' ? 'all' : 'project')).then(() =>
            refreshTodos(p, $)
          )
      }),
      el(Select, {
        key: 'todo-sort',
        label: 'Sort',
        value: view.sort,
        options: SORTS,
        onSelect: (v: string) => void setView(p, $, { sort: v as TodoSort })
      }),
      el(Select, {
        key: 'todo-status',
        label: 'Status',
        value: view.status,
        options: [
          { value: 'any', label: 'Any' },
          ...STATUSES.map((v) => ({ value: v, label: v.replace('_', ' ') }))
        ],
        onSelect: (v: string) => void setView(p, $, { status: v })
      }),
      el(Select, {
        key: 'todo-priority',
        label: 'Priority',
        value: view.priority,
        options: [{ value: 'any', label: 'Any' }, ...PRIORITIES.map((v) => ({ value: v }))],
        onSelect: (v: string) => void setView(p, $, { priority: v })
      })
    ),
    el(Input, {
      key: 'todo-new',
      placeholder: `New todo in ${scope === 'all' ? p.project : p.project}`,
      submitLabel: 'add',
      value: '',
      onSubmit: (v: string) => void createTodo(p, $, v)
    }),
    el(
      Box,
      { flexDirection: 'row', gap: 1 },
      el(
        Text,
        { color: 'subtle', size: 'caption', tabular: true },
        filtered ? `${rows.length} of ${all.length}` : `${all.length} open`
      ),
      filtered
        ? el(Button, {
            key: 'todo-clear',
            label: 'Clear filters',
            plain: true,
            dimColor: true,
            onPress: () => void setView(p, $, { status: 'any', priority: 'any', search: '' })
          })
        : null
    ),
    rows.length === 0
      ? el(
          Text,
          { color: 'subtle' },
          all.length === 0 ? 'Nothing open here.' : 'No todo matches these filters.'
        )
      : null,
    ...rows.map((t) => {
      const on = t.id === pick;
      return el(
        Box,
        {
          key: `row-${t.id}`,
          flexDirection: 'row',
          gap: 1,
          paddingX: 1,
          backgroundColor: on ? 'suggestion' : undefined,
          hover: on ? undefined : { backgroundColor: 'promptBorder' }
        },
        el(
          Button,
          {
            key: `pick-${t.id}`,
            label: `#${t.shortId} ${t.title}`,
            plain: true,
            onPress: () => void selectTodo(p, $, t)
          },
          el(
            Text,
            {
              color: on ? 'inverseText' : priorityTone(t),
              bold: t.priority === 'high' || t.status === 'blocked'
            },
            t.status === 'blocked'
              ? '■ '
              : t.priority === 'high'
                ? '● '
                : t.priority === 'medium'
                  ? '○ '
                  : '· '
          ),
          el(Text, { color: on ? 'inverseText' : 'text', bold: on, wrap: 'truncate-end' }, t.title)
        )
      );
    })
  );

  const label = (text: string) => el(Text, { color: 'subtle', size: 'caption' }, text);

  // A field shown as its value; a press swaps in an editor, Enter saves, Escape-free cancel beside it.
  const editable = (
    t: PaneTodo,
    name: Field,
    title: string,
    value: string | null | undefined,
    opts: { rows?: number; prose?: boolean; empty: string }
  ) => {
    if (field === name) {
      return el(
        Box,
        { key: `field-${name}`, flexDirection: 'column' },
        label(title),
        el(Input, {
          key: `input-${name}-${t.id}`,
          value: draft,
          rows: opts.rows,
          autoFocus: true,
          submitLabel: 'save',
          onInput: (v: string) => void update($, fieldDraft, () => v),
          onSubmit: (v: string) => void saveField(p, $, t, { [name]: v })
        }),
        el(
          Box,
          { flexDirection: 'row', gap: 1 },
          el(Button, {
            key: `save-${name}`,
            label: 'Save',
            variant: 'primary',
            onPress: () => void read($, fieldDraft).then((v) => saveField(p, $, t, { [name]: v }))
          }),
          el(Button, {
            key: `cancel-${name}`,
            label: 'Cancel',
            onPress: () => void update($, editField, () => null)
          })
        )
      );
    }
    const start = () =>
      void update($, fieldDraft, () => value ?? '').then(() => update($, editField, () => name));
    return el(
      Box,
      { key: `field-${name}`, flexDirection: 'column' },
      label(title),
      el(
        Box,
        { key: `edit-${name}-${t.id}`, hover: { backgroundColor: 'promptBorder' } },
        value
          ? opts.prose && Markdown && !tty
            ? el(
                Box,
                { flexDirection: 'column' },
                el(Markdown, { text: value }),
                el(Button, {
                  key: `open-${name}`,
                  label: `Edit ${title.toLowerCase()}`,
                  plain: true,
                  dimColor: true,
                  onPress: start
                })
              )
            : el(
                Button,
                {
                  key: `open-${name}`,
                  label: `Edit ${title.toLowerCase()}`,
                  plain: true,
                  onPress: start
                },
                el(Text, { color: 'text' }, value)
              )
          : el(Button, {
              key: `open-${name}`,
              label: opts.empty,
              plain: true,
              dimColor: true,
              onPress: start
            })
      )
    );
  };

  // Right: the picked todo, every field editable in place.
  const page = !current
    ? el(Text, { color: 'subtle' }, rows.length ? 'Pick a todo on the left.' : 'Nothing to show.')
    : el(
        Box,
        { flexDirection: 'column', gap: 1 },
        el(
          Box,
          { flexDirection: 'row', gap: 1 },
          el(
            Box,
            { flexGrow: 1 },
            el(
              Text,
              { color: 'subtle', size: 'caption', tabular: true },
              `#${current.shortId} · ${current.project ?? 'cross-cutting'}`
            )
          ),
          iconButton(els, tty, {
            key: 'todo-close',
            icon: '✓',
            name: 'Close as done',
            hotkey: 'x',
            primary: true,
            onPress: () => void closeTodo(p, $, current)
          })
        ),
        field === 'title'
          ? editable(current, 'title', 'Title', current.title, { rows: 2, empty: 'Add a title' })
          : el(
              Box,
              { key: `edit-title-${current.id}`, hover: { backgroundColor: 'promptBorder' } },
              el(
                Button,
                {
                  key: 'open-title',
                  label: 'Edit title',
                  plain: true,
                  onPress: () =>
                    void update($, fieldDraft, () => current.title).then(() =>
                      update($, editField, () => 'title')
                    )
                },
                el(Text, { size: 'title', weight: 'semibold', color: 'text' }, current.title)
              )
            ),
        el(
          Box,
          { flexDirection: 'row', gap: 2, flexWrap: 'wrap' },
          el(Select, {
            key: `pri-${current.id}`,
            label: 'Priority',
            value: current.priority,
            options: PRIORITIES.map((v) => ({ value: v })),
            onSelect: (v: string) => void saveField(p, $, current, { priority: v })
          }),
          el(Select, {
            key: `status-${current.id}`,
            label: 'Status',
            value: current.status,
            options: STATUSES.map((v) => ({ value: v, label: v.replace('_', ' ') })),
            onSelect: (v: string) => void saveField(p, $, current, { status: v })
          })
        ),
        el(
          Box,
          { flexDirection: 'row', gap: 3, flexWrap: 'wrap' },
          editable(current, 'area', 'Area', current.area, { empty: 'Add an area' }),
          el(
            Box,
            { flexDirection: 'column' },
            label('Created'),
            el(
              Text,
              { color: 'text', tabular: true },
              current.createdAt ? ago(current.createdAt, now) : '—'
            )
          ),
          el(
            Box,
            { flexDirection: 'column' },
            label('Updated'),
            el(
              Text,
              { color: 'text', tabular: true },
              current.updatedAt ? ago(current.updatedAt, now) : '—'
            )
          ),
          more?.targetDate
            ? el(
                Box,
                { flexDirection: 'column' },
                label('Target'),
                el(Text, { color: 'text', tabular: true }, more.targetDate.slice(0, 10))
              )
            : null
        ),
        current.status === 'blocked' || more?.blockedBy
          ? editable(current, 'blockedBy', 'Blocked by', more?.blockedBy, {
              empty: 'Say what it waits on'
            })
          : null,
        current.status === 'deferred' || more?.revisitWhen
          ? editable(current, 'revisitWhen', 'Revisit when', more?.revisitWhen, {
              empty: 'Say when to look again'
            })
          : null,
        editable(current, 'notes', 'Notes', more?.notes, {
          rows: 4,
          prose: true,
          empty: 'Add notes'
        }),
        editable(current, 'body', 'Description', more?.body, {
          rows: 8,
          prose: true,
          empty: 'Add a description'
        })
      );

  return el(
    Box,
    { flexDirection: 'column', gap: 1 },
    said ? el(Text, { color: said.startsWith('Could not') ? 'error' : 'subtle' }, said) : null,
    el(
      Box,
      { flexDirection: 'row', gap: 2 },
      master,
      el(
        Box,
        {
          flexDirection: 'column',
          flexGrow: 1,
          borderStyle: 'single',
          borderColor: 'promptBorder',
          paddingX: 2,
          paddingY: 1
        },
        page
      )
    )
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
