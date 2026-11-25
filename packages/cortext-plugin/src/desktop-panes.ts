import type { EngineInterface, On, RenderElement } from 'claude-code';
import { atom, read, update } from 'claude-code';
import type { FeedEvent, FeedRow, PaneTodo, TodoDetail } from '../types';
import { accent, BRAND, MARK_SVG, rule, statusTone } from './brand.js';
import { el } from './el.js';
import { groupedView } from './grouped.js';
import { openMail } from './mail-card.js';
import { mailCard, promptCard } from './mail-view.js';
import {
  ago,
  clockTime,
  controlKids,
  cut,
  FALLBACK_VOCAB,
  hostOf,
  humanize,
  laneRows,
  mailFeedText,
  parseRemoteTurn,
  remoteTurnText,
  splitMailFeedText,
  type TodoSort,
  type TodoView,
  toolSummary,
  viewTodos,
  vocabFromSchema
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
// The mnmal-ai mark, drawn at the header's top left where a surface draws Svg.
const AUTO_REFRESH_MS = 60_000;

// The tag declines rows an earlier version stored, which lacked createdAt and updatedAt.
const todos = atom({ plugin: 'cortext', key: 'paneTodos' }, [], { shape: 'todos-2' });
const todoScope = atom({ plugin: 'cortext', key: 'paneTodoScope' }, 'project');
// Unsaved text per `<todo id>:<field>`; a field with an entry here shows Save and Revert.
const drafts = atom({ plugin: 'cortext', key: 'paneDrafts' }, {});
// The Todo type's status and priority values, read from the server's schema on each refresh.
const vocab = atom({ plugin: 'cortext', key: 'paneVocab' }, FALLBACK_VOCAB);
const refreshedAt = atom({ plugin: 'cortext', key: 'paneRefreshedAt' }, 0);
// The list's share of the pane, in percent; the splitter moves it.
const splitPct = atom({ plugin: 'cortext', key: 'paneSplit' }, 34);
const layout = atom({ plugin: 'cortext', key: 'paneLayout' }, 'list');
// Grouped view: the statuses folded away (closed starts folded) and the row whose picker is open.
const folds = atom({ plugin: 'cortext', key: 'paneFolds' }, ['closed']);
const pickerFor = atom({ plugin: 'cortext', key: 'panePicker' }, null);
// On the board a picked card opens full width; false shows the lanes.
const cardOpen = atom({ plugin: 'cortext', key: 'paneCardOpen' }, false);
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
  todoPoll: { cancel: () => void } | undefined;
  cols: number; // the Todos pane's body width, as its last draw reported
};

/** The text of an MCP tool result, parsed as JSON. Throws with the server's words on an error. */
async function sub(p: Panes, $: EngineInterface, tool: string, args: Record<string, unknown>) {
  const r = await $.mcp.call(p.server, tool, args);
  const text = r.content
    .map((c) => (c.type === 'text' ? (c as { text: string }).text : ''))
    .join('');
  if (r.isError) throw new Error(cut(text || `${tool} failed`, 200));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A reply cut short (a size cap on the way) or a server answering in prose.
    throw new Error(
      `${tool} answered ${text.length} characters that are not JSON: ${cut(text, 120)}`
    );
  }
  const body = parsed as {
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
  // Every status the schema has, closed included while not archived: the board has a lane for each.
  const and: object[] = [{ archived: { eq: false } }];
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
          params: { where: { AND: and }, limit: 100, ...(cursor ? { cursor } : {}) },
          fields: {
            id: true,
            shortId: true,
            title: true,
            area: true,
            status: true,
            priority: true,
            project: true,
            tags: true,
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
  return viewTodos(await read($, todos), await read($, todoView), await read($, vocab));
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
    try {
      const answer = await sub(p, $, 'schema', { namespace: p.ns, type: 'Todo', shape: 'fields' });
      const got = vocabFromSchema(answer);
      if (got) await update($, vocab, () => got);
    } catch {
      // An older server or a refused schema read: keep the last value lists, or the fallback.
    }
    await loadTodos(p, $);
    await keepPick(p, $);
    const at = await $.clock.now();
    await update($, refreshedAt, () => at);
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
    await update($, drafts, (d) => dropDrafts(d, t.id, Object.keys(patch)));
    await loadTodos(p, $);
    const fresh = (await read($, todos)).find((r) => r.id === t.id);
    if (fresh) await selectTodo(p, $, fresh);
    await note($, '');
  } catch (err) {
    await note($, `Could not save #${t.shortId}: ${(err as Error).message}`);
  }
}

type Els = ReturnType<EngineInterface['ui']['resolve']>;

function dropDrafts(
  d: Record<string, string>,
  id: string,
  fields: string[]
): Record<string, string> {
  const out = { ...d };
  for (const f of fields) delete out[`${id}:${f}`];
  return out;
}

// The pane's parts, each built from the app's own controls so every surface draws them natively.

/** A caption over a control or value. */
function labelled(els: Els, label: string, child: RenderElement | null): RenderElement {
  const { Box, Text } = els;
  return el(Box, { flexDirection: 'column' }, el(Text, { color: 'subtle' }, label), child);
}

/** Tags as one quiet line: `quote-lane · psa`. */
function tagLine(t: PaneTodo): string {
  return (t.tags ?? []).join(' · ');
}

// Mobile and VS Code draw no Client: there the list and the board fall back to these buttons.
/** One list row: a single Button holding plain Text parts, the picked one in the app's primary style. */
function listRow(els: Els, t: PaneTodo, on: boolean, onPress: () => void): RenderElement {
  const { Text, Button } = els;
  return el(
    Button,
    {
      key: `pick-${t.id}`,
      label: `#${t.shortId} ${t.title}`,
      plain: on ? undefined : true,
      variant: on ? 'primary' : undefined,
      onPress
    },
    el(Text, { dimColor: !on }, `#${t.shortId} `),
    el(Text, {}, t.title)
  );
}

/** One board card: a bordered Box around one Button whose Text parts are the title, the id and the tags. */
function card(
  els: Els,
  t: PaneTodo,
  showProject: boolean,
  on: boolean,
  onPress: () => void
): RenderElement {
  const { Box, Text, Button } = els;
  const tags = tagLine(t);
  const where = showProject ? `${t.project ?? 'cross-cutting'} · ` : '';
  return el(
    Box,
    {
      key: `card-${t.id}`,
      borderStyle: 'round',
      borderColor: on ? BRAND.accent : rule(false),
      paddingX: 1,
      hover: { borderColor: BRAND.accent }
    },
    el(
      Button,
      { key: `open-${t.id}`, label: t.title, plain: true, onPress },
      el(Text, { bold: t.priority === 'high' }, t.title),
      '\n',
      el(
        Text,
        { dimColor: true },
        `${where}#${t.shortId} · ${t.priority}${t.area ? ` · ${t.area}` : ''}`
      ),
      tags ? '\n' : '',
      tags ? el(Text, { color: BRAND.accent }, tags) : ''
    )
  );
}

/**
 * A field that is always editable: click into the text and type. Enter saves (Shift+Enter is a
 * new line in a tall field); while it differs from what is stored, Save and Revert sit under it.
 */
function textField(
  els: Els,
  o: {
    id: string;
    name: string;
    label: string;
    stored: string;
    draft: string | undefined;
    rows?: number;
    placeholder: string;
    onDraft: (v: string | undefined) => void;
    onSave: (v: string) => void;
  }
): RenderElement {
  const { Box, Button, Input } = els;
  const dirty = o.draft !== undefined && o.draft !== o.stored;
  return labelled(
    els,
    o.label,
    el(
      Box,
      { flexDirection: 'column', gap: 1 },
      el(Input, {
        key: `f-${o.name}-${o.id}`,
        value: o.draft ?? o.stored,
        rows: o.rows,
        placeholder: o.placeholder,
        submitLabel: 'save',
        onInput: (v: string) => o.onDraft(v),
        onSubmit: (v: string) => o.onSave(v)
      }),
      dirty
        ? el(
            Box,
            { flexDirection: 'row', gap: 1 },
            el(Button, {
              key: `save-${o.name}`,
              label: 'Save',
              variant: 'primary',
              onPress: () => o.onSave(o.draft ?? '')
            }),
            el(Button, {
              key: `revert-${o.name}`,
              label: 'Revert',
              onPress: () => o.onDraft(undefined)
            })
          )
        : null
    )
  );
}

/** The header both layouts share: search, actions, then scope, sort and filters, then the add field. */
function header(
  els: Els,
  p: Panes,
  $: EngineInterface,
  s: {
    tty: boolean;
    view: TodoView;
    scope: string;
    mode: string;
    shownCount: number;
    allCount: number;
    voc: { status: readonly string[]; priority: readonly string[] };
    refreshed: number;
  }
): RenderElement {
  const { Box, Text, Button, Input, Select } = els;
  const Svg = (els as unknown as { Svg?: typeof Box }).Svg;
  const logo =
    Svg && !s.tty
      ? el(Svg, { source: MARK_SVG, alt: 'mnmal-ai', width: 22, height: 22 })
      : el(Text, { bold: true, color: 'claude' }, 'mnmal');
  const brand = el(
    Box,
    { flexDirection: 'row', gap: 1, alignItems: 'center' },
    logo,
    el(Text, { bold: true }, 'Todos')
  );
  const filtered =
    s.view.status !== 'any' || s.view.priority !== 'any' || s.view.search.trim() !== '';
  return el(
    Box,
    { flexDirection: 'column', gap: 1 },
    el(
      Box,
      { flexDirection: 'row', gap: 2, alignItems: 'center' },
      brand,
      el(
        Box,
        { flexGrow: 1 },
        el(Input, {
          key: 'todo-search',
          placeholder: 'Search title, #id or tag',
          submitLabel: 'find',
          value: s.view.search,
          onInput: (v: string) => void setView(p, $, { search: v }),
          onSubmit: (v: string) => void setView(p, $, { search: v })
        })
      ),
      el(Select, {
        key: 'todo-view',
        label: 'View',
        value: s.mode,
        options: [
          { value: 'list', label: 'List' },
          { value: 'board', label: 'Board' },
          { value: 'grouped', label: 'Grouped' }
        ],
        onSelect: (v: string) =>
          void update($, layout, () => (v === 'board' || v === 'grouped' ? v : 'list')).then(() =>
            update($, cardOpen, () => false)
          )
      }),
      el(
        Box,
        { flexDirection: 'row', gap: 1, alignItems: 'center' },
        el(
          Text,
          { color: 'subtle', tabular: true },
          s.refreshed ? `Last refreshed ${clockTime(s.refreshed)}` : 'Not refreshed yet'
        ),
        el(Button, {
          key: 'todo-refresh',
          label: 'Refresh',
          hotkey: s.tty ? 'r' : undefined,
          onPress: () => void refreshTodos(p, $)
        })
      )
    ),
    el(
      Box,
      { flexDirection: 'row', columnGap: 2, rowGap: 1, flexWrap: 'wrap', alignItems: 'center' },
      el(Select, {
        key: 'todo-scope',
        value: s.scope,
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
        value: s.view.sort,
        options: SORTS,
        onSelect: (v: string) => void setView(p, $, { sort: v as TodoSort })
      }),
      el(Select, {
        key: 'todo-status',
        label: 'Status',
        value: s.view.status,
        options: [
          { value: 'any', label: 'Any' },
          ...s.voc.status.map((v) => ({ value: v, label: humanize(v) }))
        ],
        onSelect: (v: string) => void setView(p, $, { status: v })
      }),
      el(Select, {
        key: 'todo-priority',
        label: 'Priority',
        value: s.view.priority,
        options: [
          { value: 'any', label: 'Any' },
          ...[...s.voc.priority].reverse().map((v) => ({ value: v, label: humanize(v) }))
        ],
        onSelect: (v: string) => void setView(p, $, { priority: v })
      }),
      el(
        Text,
        { color: 'subtle', tabular: true },
        filtered ? `${s.shownCount} of ${s.allCount}` : `${s.allCount} open`
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
    el(Input, {
      key: 'todo-new',
      placeholder: `New todo in ${p.project}`,
      submitLabel: 'add',
      value: '',
      onSubmit: (v: string) => void createTodo(p, $, v)
    })
  );
}

async function drawTodos(
  p: Panes,
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0]
) {
  const els = $.ui.resolve(e);
  const { Box, Text, Button, Select } = els;
  // Only the terminal and the desktop app run surface modules; elsewhere the buttons stand in.
  const Client =
    e.surface === 'terminal' || e.surface === 'desktop'
      ? (els as unknown as { Client?: typeof Box }).Client
      : undefined;
  const tty = e.surface === 'terminal';
  const all = await read($, todos);
  const view = await read($, todoView);
  const voc = await read($, vocab);
  const rows = viewTodos(all, view, voc);
  const scope = await read($, todoScope);
  const mode = await read($, layout);
  const opened = await read($, cardOpen);
  const said = await read($, paneNote);
  const pick = await read($, selected);
  const more = await read($, detail);
  const pending = await read($, drafts);
  const current = rows.find((t) => t.id === pick) ?? all.find((t) => t.id === pick);
  const now = await $.clock.now();

  const field = (
    name: 'title' | 'area' | 'notes' | 'body' | 'blockedBy' | 'revisitWhen',
    label: string,
    stored: string | null | undefined,
    rowsTall: number | undefined,
    placeholder: string
  ) => {
    if (!current) return null;
    const k = `${current.id}:${name}`;
    return textField(els, {
      id: current.id,
      name,
      label,
      stored: stored ?? '',
      draft: pending[k],
      rows: rowsTall,
      placeholder,
      onDraft: (v) =>
        void update($, drafts, (d) => {
          const out = { ...d };
          if (v === undefined) delete out[k];
          else out[k] = v;
          return out;
        }),
      onSave: (v) => void saveField(p, $, current, { [name]: v })
    });
  };
  const fact = (label: string, value: string) =>
    labelled(els, label, el(Text, { tabular: true }, value));

  // The picked todo, every field editable in place. Shared by the list's right side and the board's card view.
  const detailView = (back: RenderElement | null) =>
    !current
      ? el(Text, { color: 'subtle' }, rows.length ? 'Pick a todo.' : 'Nothing to show.')
      : el(
          Box,
          { flexDirection: 'column', gap: 1 },
          el(
            Box,
            { flexDirection: 'row', gap: 2, alignItems: 'center' },
            back,
            el(
              Box,
              { flexGrow: 1 },
              el(
                Text,
                { color: 'subtle', tabular: true },
                `#${current.shortId} · ${current.project ?? 'cross-cutting'}`
              )
            ),
            el(Button, {
              key: 'todo-close',
              label: 'Close as done',
              hotkey: tty ? 'x' : undefined,
              onPress: () => void closeTodo(p, $, current)
            })
          ),
          field('title', 'Title', current.title, 3, 'Title'),
          el(
            Box,
            { flexDirection: 'row', columnGap: 3, rowGap: 1, flexWrap: 'wrap' },
            labelled(
              els,
              'Priority',
              el(Select, {
                key: `pri-${current.id}`,
                value: current.priority,
                options: [...voc.priority].reverse().map((v) => ({ value: v, label: humanize(v) })),
                onSelect: (v: string) => void saveField(p, $, current, { priority: v })
              })
            ),
            labelled(
              els,
              'Status',
              el(Select, {
                key: `status-${current.id}`,
                value: current.status,
                options: voc.status.map((v) => ({ value: v, label: humanize(v) })),
                onSelect: (v: string) => void saveField(p, $, current, { status: v })
              })
            ),
            fact('Created', current.createdAt ? ago(current.createdAt, now) : '—'),
            fact('Updated', current.updatedAt ? ago(current.updatedAt, now) : '—'),
            more?.targetDate ? fact('Target', more.targetDate.slice(0, 10)) : null
          ),
          tagLine(current)
            ? labelled(els, 'Tags', el(Text, { color: accent(tty) }, tagLine(current)))
            : null,
          field('area', 'Area', current.area, undefined, 'Area'),
          current.status === 'blocked' || more?.blockedBy
            ? field('blockedBy', 'Waiting on', more?.blockedBy, 2, 'What it needs from you')
            : null,
          current.status === 'deferred' || more?.revisitWhen
            ? field('revisitWhen', 'Revisit when', more?.revisitWhen, 2, 'When to look again')
            : null,
          field('notes', 'Notes', more?.notes, 6, 'Add notes'),
          field('body', 'Description', more?.body, 10, 'Add a description')
        );

  const head = header(els, p, $, {
    tty,
    view,
    scope,
    mode,
    shownCount: rows.length,
    allCount: all.length,
    voc,
    refreshed: await read($, refreshedAt)
  });
  const empty =
    rows.length === 0
      ? el(
          Text,
          { color: 'subtle' },
          all.length === 0 ? 'Nothing open here.' : 'No todo matches these filters.'
        )
      : null;

  const split = await read($, splitPct);
  p.cols = (e as { props?: { bodyColumns?: number } }).props?.bodyColumns ?? p.cols;
  const allProjects = scope === 'all';
  const detailPanel = (back: RenderElement | null, width?: string) =>
    el(
      Box,
      {
        flexDirection: 'column',
        flexGrow: width ? 0 : 1,
        flexShrink: 0,
        width,
        borderStyle: 'round',
        borderColor: rule(tty),
        paddingX: 2,
        paddingY: 1
      },
      detailView(back)
    );

  let body: RenderElement;
  if (mode === 'grouped') {
    const view = groupedView({
      els: els as unknown as Record<string, unknown>,
      surface: e.surface,
      el,
      heading: allProjects ? 'All projects' : p.project,
      statuses: voc.status,
      rows,
      allProjects,
      picked: opened ? pick : null,
      pickerFor: await read($, pickerFor),
      folded: await read($, folds),
      columns: p.cols,
      onOpen: (r) => {
        const t = all.find((x) => x.id === r.id);
        if (t) void selectTodo(p, $, t).then(() => update($, cardOpen, () => true));
      },
      onTogglePicker: (r) => void update($, pickerFor, (cur) => (cur === r.id ? null : r.id)),
      onSetStatus: (r, status) => {
        const t = all.find((x) => x.id === r.id);
        void update($, pickerFor, () => null);
        if (t && t.status !== status) {
          void update($, todos, (list) =>
            list.map((x) => (x.id === t.id ? { ...x, status } : x))
          ).then(() => saveField(p, $, t, { status }));
        }
      },
      onToggleGroup: (st) =>
        void update($, folds, (f) => (f.includes(st) ? f.filter((x) => x !== st) : [...f, st]))
    });
    body =
      opened && current
        ? el(
            Box,
            { flexDirection: 'row', gap: 1 },
            el(Box, { flexGrow: 1, flexShrink: 1 }, view),
            detailPanel(
              el(Button, {
                key: 'todo-back',
                label: 'Close panel',
                hotkey: tty ? 'b' : undefined,
                onPress: () => void update($, cardOpen, () => false)
              }),
              '42%'
            )
          )
        : view;
  } else if (mode === 'board') {
    const laneData = laneRows(rows, voc.status).map(({ lane, rows: inLane }) => ({
      status: lane.key,
      title: lane.title,
      tone: statusTone(lane.key, tty),
      cards: inLane.map((t) => ({
        id: t.id,
        title: `#${t.shortId}  ${t.title}`,
        meta: `${allProjects ? `${t.project ?? 'cross-cutting'} · ` : ''}${t.priority}${t.area ? ` · ${t.area}` : ''}`,
        tags: tagLine(t),
        strong: t.priority === 'high'
      }))
    }));
    const tallest = Math.max(1, ...laneData.map((l) => l.cards.length));
    // The board is one Client: it draws the cards and turns a click into `open`, a drop into `move`.
    const lanes =
      empty ??
      (Client
        ? // biome-ignore lint/correctness/noUndeclaredVariables: a literal h(Client, { module }) is how the engine finds the surface module
          (h(Client, {
            key: 'todo-board',
            module: './board.mjs',
            props: {
              lanes: laneData,
              picked: opened ? pick : null,
              colors: { accent: accent(tty), rule: rule(tty), tags: accent(tty) }
            },
            height: 2 + tallest * 5,
            flexGrow: 1
          }) as RenderElement)
        : el(
            Box,
            { flexDirection: 'row', gap: 2, flexGrow: 1 },
            ...laneRows(rows, voc.status).map(({ lane, rows: inLane }) =>
              el(
                Box,
                {
                  key: `lane-${lane.key}`,
                  flexDirection: 'column',
                  flexGrow: 1,
                  flexShrink: 1,
                  gap: 1
                },
                el(
                  Text,
                  { bold: true, color: statusTone(lane.key, tty) },
                  `${lane.title} (${inLane.length})`
                ),
                ...inLane.map((t) =>
                  card(
                    els,
                    t,
                    allProjects,
                    t.id === pick && opened,
                    () => void selectTodo(p, $, t).then(() => update($, cardOpen, () => true))
                  )
                )
              )
            )
          ));
    // A picked card opens a rail at the right; the lanes stay in view beside it.
    body =
      opened && current
        ? el(
            Box,
            { flexDirection: 'row', gap: 1 },
            el(Box, { flexGrow: 1, flexShrink: 1 }, lanes),
            detailPanel(
              el(Button, {
                key: 'todo-back',
                label: 'Close panel',
                hotkey: tty ? 'b' : undefined,
                onPress: () => void update($, cardOpen, () => false)
              }),
              '42%'
            )
          )
        : lanes;
  } else {
    body = el(
      Box,
      { flexDirection: 'row' },
      el(
        Box,
        { flexDirection: 'column', width: `${split}%`, flexShrink: 0, paddingRight: 1 },
        empty,
        ...(Client
          ? [
              // biome-ignore lint/correctness/noUndeclaredVariables: a literal h(Client, { module }) is how the engine finds the surface module
              h(Client, {
                key: 'todo-list',
                module: './list.mjs',
                props: {
                  rows: rows.map((t) => ({
                    id: t.id,
                    num: `#${t.shortId}`,
                    title: allProjects ? `${t.title}  · ${t.project ?? 'cross-cutting'}` : t.title,
                    tone: statusTone(t.status, tty),
                    strong: t.priority === 'high' || t.status === 'blocked'
                  })),
                  picked: pick,
                  tty
                },
                height: Math.max(1, rows.length)
              }) as RenderElement
            ]
          : rows.map((t) => listRow(els, t, t.id === pick, () => void selectTodo(p, $, t))))
      ),
      Client
        ? // biome-ignore lint/correctness/noUndeclaredVariables: a literal h(Client, { module }) is how the engine finds the surface module
          (h(Client, {
            key: 'todo-splitter',
            module: './splitter.mjs',
            props: { rows: Math.max(10, rows.length), rule: rule(tty), accent: accent(tty) },
            width: 1
          }) as RenderElement)
        : null,
      el(Box, { flexDirection: 'column', flexGrow: 1, paddingLeft: 1 }, detailPanel(null))
    );
  }

  return el(
    Box,
    { flexDirection: 'column', gap: 1 },
    head,
    said ? el(Text, { color: said.startsWith('Could not') ? 'error' : 'subtle' }, said) : null,
    body
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

  const opened = await read($, openMail);
  const picked = list.find((f) => f.id === feed);
  const step = (ev: FeedEvent): RenderElement => {
    if (ev.kind === 'mail-in' || ev.kind === 'mail-out') {
      const { subject, body } = splitMailFeedText(ev.text);
      const id = `feed-${feed}-${ev.step}`;
      return mailCard(els, e.surface, {
        key: `ev-${ev.step}`,
        dir: ev.kind === 'mail-in' ? 'in' : 'out',
        peer: ev.tool ?? 'someone',
        when: '',
        subject,
        body,
        isOpen: opened.includes(id),
        onToggle: () =>
          update($, openMail, (prev) => {
            const ids = prev ?? [];
            return ids.includes(id) ? ids.filter((n) => n !== id) : [...ids, id].slice(-200);
          })
      });
    }
    if (ev.kind === 'tool') {
      return el(
        Box,
        { key: `ev-${ev.step}` },
        el(Text, { dimColor: true, wrap: 'truncate-end' }, `  ${ev.tool ?? 'tool'}: ${ev.text}`)
      );
    }
    if (ev.kind === 'prompt') {
      // A person typed it: the sharer's own prompt, or a turn a viewer sent (you, or someone else).
      const turn = parseRemoteTurn(ev.text);
      return promptCard(els, e.surface, {
        key: `ev-${ev.step}`,
        who: turn && turn.from === p.kid ? 'me' : 'them',
        name: turn ? (turn.from === p.kid ? '' : turn.from) : (picked?.host ?? ''),
        note: turn ? 'remote turn' : '',
        text: turn ? turn.text : ev.text
      });
    }
    return Markdown
      ? el(Markdown, { key: `ev-${ev.step}`, text: ev.text })
      : el(Box, { key: `ev-${ev.step}` }, el(Text, {}, ev.text));
  };

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
    turnPoll: undefined,
    todoPoll: undefined,
    cols: 120
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

/** Called from the bridge for mail it delivered and mail this session sent. */
export async function shareMail(
  p: Panes,
  $: EngineInterface,
  dir: 'in' | 'out',
  peer: string,
  subject: string,
  body: string
): Promise<void> {
  await publish(p, $, dir === 'in' ? 'mail-in' : 'mail-out', mailFeedText(subject, body), peer);
}

/**
 * Opens the Remote session pane on the shared session that stamped `instance`, or on the
 * picker with a note when that session is not shared.
 */
export async function openRemoteSession(
  p: Panes,
  $: EngineInterface,
  instance: string
): Promise<void> {
  await loadFeeds(p, $);
  const found = (await read($, feeds)).find((f) => f.instance === instance);
  if (found) await watch(p, $, found.id);
  else await note($, `${instance} is not shared. Its user turns it on with /cortext-share on.`);
  // A press is the person's input, so the pane is placed at any width; focus raises it.
  const opened = await $.ui.open({ id: SESSION_PANE, title: 'Remote session', focus: true });
  if (!opened.isPlaced) $.ui.toast(`Could not open the Remote session pane: ${opened.reason}`);
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
    p.todoPoll?.cancel();
    p.todoPoll = $.clock.every(AUTO_REFRESH_MS, () => void refreshTodos(p, $));
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

  on('ui.close', { id: TODOS_PANE }, async (_$, e, next) => {
    p.todoPoll?.cancel();
    p.todoPoll = undefined;
    return next(e);
  });

  // The splitter posts column moves; the board posts a card's open and a card's move to a lane.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { type?: string; delta?: number; id?: string; status?: string } | null;
    if (
      (data?.type === 'open' || data?.type === 'move' || data?.type === 'pick') &&
      typeof data.id === 'string'
    ) {
      const t = (await read($, todos)).find((r) => r.id === data.id);
      if (t && data.type === 'pick') await selectTodo(p, $, t);
      if (t && data.type === 'open') {
        await selectTodo(p, $, t);
        await update($, cardOpen, () => true);
      }
      if (
        t &&
        data.type === 'move' &&
        typeof data.status === 'string' &&
        data.status !== t.status
      ) {
        const status = data.status;
        // Move the card at once, then save; a refused save reloads the list as the server has it.
        await update($, todos, (rows) => rows.map((r) => (r.id === t.id ? { ...r, status } : r)));
        await saveField(p, $, t, { status });
        await note($, `Moved #${t.shortId} to ${humanize(status)}.`);
      }
    }
    if (data?.type === 'split' && typeof data.delta === 'number' && p.cols > 0) {
      const step = (data.delta * 100) / p.cols;
      await update($, splitPct, (v) =>
        Math.min(75, Math.max(15, Math.round((v + step) * 10) / 10))
      );
    }
    return next(e);
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
