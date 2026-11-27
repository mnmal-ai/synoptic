import type { EngineInterface, On, RenderElement } from 'claude-code';
import { atom, read, update } from 'claude-code';
import type { PaneTodo, TodoDetail } from '../types';
import { accent, BRAND, MARK_SVG, rule, statusTone } from './brand.js';
import { el } from './el.js';
import { groupedView } from './grouped.js';
import { mutate, query, sub } from './substrate-mcp.js';
import { clockTime, cut } from './text.js';
import {
  ago,
  brainFactLine,
  EMPTY_BOARD,
  FALLBACK_VOCAB,
  humanize,
  laneRows,
  rollBrainFact,
  type TodoSort,
  type TodoView,
  viewTodos,
  vocabFromSchema
} from './todo-text.js';

// The Todos pane: list, board and grouped views of the store's Todos, to create, edit and close
// them. Every read and write goes through the session's own substrate MCP server, so each write
// is signed by this repo's key.

const TODOS_PANE = 'cortext-todos';
const AUTO_REFRESH_MS = 60_000;
const PAGE_ROWS = 100;

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
// Lines a list row takes (list.ts ROW_LINES), and the most rows the list draws at once.
const LIST_ROW_LINES = 3;
const LIST_MAX_ROWS = 120;
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
// The brain fact rolled when the pane opened, as an index into BRAIN_FACTS, or null on most opens.
const brainFact = atom({ plugin: 'cortext', key: 'paneBrainFact' }, null);

// What the hooks share. Module variables reset on every reload; what must survive one lives in $.state.
export type TodosPane = {
  ns: string;
  server: string; // the substrate MCP server's name as /mcp lists it
  project: string;
  todoPoll: { cancel: () => void } | undefined;
  cols: number; // the pane's body width, as its last draw reported
  rng: () => number; // rolls the footer's brain fact on each open; tests pass their own
};

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

async function loadTodos(p: TodosPane, $: EngineInterface): Promise<void> {
  const scope = await read($, todoScope);
  // Every status the schema has, closed included while not archived: the board has a lane for each.
  const and: object[] = [{ archived: { eq: false } }];
  if (scope === 'project') {
    and.push({ OR: [{ project: { eq: p.project } }, { project: { eq: null } }] });
  }
  const rows: PaneTodo[] = [];
  const key = `${p.ns}/Todo`;
  let cursor: string | undefined;
  // Page until the server says there is no more: a list cut short would hide todos without saying so.
  for (;;) {
    const body = await sub(p, $, 'query', {
      payload: {
        [key]: {
          params: { where: { AND: and }, limit: PAGE_ROWS, ...(cursor ? { cursor } : {}) },
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
    if (!pg?.hasMore) break;
    // A page that says more but gives no new cursor would repeat forever; say so instead.
    if (!pg.nextCursor || pg.nextCursor === cursor) {
      throw new Error(`${key} said more rows follow ${rows.length} but gave no next cursor`);
    }
    cursor = pg.nextCursor;
  }
  await update($, todos, () => rows);
}

/** The rows the list shows now, in its order. */
async function shown($: EngineInterface): Promise<PaneTodo[]> {
  return viewTodos(await read($, todos), await read($, todoView), await read($, vocab));
}

/** Keeps a pick that is still listed; otherwise picks the first row, as a settings sidebar does. */
async function keepPick(p: TodosPane, $: EngineInterface): Promise<void> {
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

async function refreshTodos(p: TodosPane, $: EngineInterface): Promise<void> {
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

async function setView(p: TodosPane, $: EngineInterface, patch: Partial<TodoView>): Promise<void> {
  await update($, todoView, (v) => ({ ...v, ...patch }));
  await keepPick(p, $);
}

async function selectTodo(p: TodosPane, $: EngineInterface, t: PaneTodo): Promise<void> {
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

async function createTodo(p: TodosPane, $: EngineInterface, title: string): Promise<void> {
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

async function closeTodo(p: TodosPane, $: EngineInterface, t: PaneTodo): Promise<boolean> {
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
    return true;
  } catch (err) {
    await note($, `Could not close #${t.shortId}: ${(err as Error).message}`);
    await loadTodos(p, $).catch(() => {});
    return false;
  }
}

/**
 * Moves a todo to `status`. Closed goes through `close`, as the Close button does, so the row is
 * also resolved and archived; any other status is a plain field save.
 */
async function setStatus(
  p: TodosPane,
  $: EngineInterface,
  t: PaneTodo,
  status: string
): Promise<boolean> {
  if (status === 'closed') return closeTodo(p, $, t);
  return saveField(p, $, t, { status });
}

/** Saves one field, or the priority or status, of the picked todo. */
async function saveField(
  p: TodosPane,
  $: EngineInterface,
  t: PaneTodo,
  patch: Partial<Record<Field | 'priority' | 'status', string | null>>
): Promise<boolean> {
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
    return true;
  } catch (err) {
    await note($, `Could not save #${t.shortId}: ${(err as Error).message}`);
    await loadTodos(p, $).catch(() => {});
    return false;
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
  p: TodosPane,
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
  p: TodosPane,
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
                onSelect: (v: string) => void setStatus(p, $, current, v)
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
          all.length === 0 ? EMPTY_BOARD : 'No todo matches these filters.'
        )
      : null;

  // A small Easter egg on about one open in 50: a brain fact and the board's live open count.
  const fun = brainFactLine(
    await read($, brainFact),
    all.filter((t) => t.status !== 'closed').length
  );

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

  const shown = Math.min(rows.length, LIST_MAX_ROWS);

  let body: RenderElement;
  if (mode === 'grouped') {
    const view = groupedView({
      els: els as unknown as Record<string, unknown>,
      surface: e.surface,
      el,
      heading: allProjects ? 'All projects' : p.project,
      statuses: voc.status,
      rows,
      emptyText: all.length === 0 ? EMPTY_BOARD : undefined,
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
          ).then(() => setStatus(p, $, t, status));
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
        {
          flexDirection: 'column',
          // A value stored by an earlier version may carry a fraction.
          width: `${Number.isFinite(split) ? Math.round(split) : 34}%`,
          flexShrink: 0,
          paddingRight: 1
        },
        empty,
        ...(Client
          ? [
              el(
                Box,
                { key: 'todo-list', flexDirection: 'column', gap: tty ? 0 : 'sm' },
                ...rows.slice(0, shown).map(
                  (t) =>
                    // biome-ignore lint/correctness/noUndeclaredVariables: a literal h(Client, { module }) is how the engine finds the surface module
                    h(Client, {
                      key: `row-${t.id}`,
                      module: './list.mjs',
                      props: {
                        row: {
                          id: t.id,
                          num: `#${t.shortId}`,
                          title: t.title,
                          facts: [
                            t.priority === 'high'
                              ? { text: 'High', tone: tty ? 'warning' : BRAND.magenta }
                              : { text: humanize(t.priority) },
                            { text: humanize(t.status), tone: statusTone(t.status, tty) },
                            ...(t.area ? [{ text: t.area }] : []),
                            ...(allProjects ? [{ text: t.project ?? 'cross-cutting' }] : [])
                          ]
                        },
                        picked: t.id === pick,
                        tty
                      },
                      height: LIST_ROW_LINES
                    }) as RenderElement
                )
              ),
              rows.length > shown
                ? el(
                    Text,
                    { color: 'subtle', tabular: true },
                    `${rows.length - shown} more. Search or filter to narrow the list.`
                  )
                : null
            ]
          : rows.map((t) => listRow(els, t, t.id === pick, () => void selectTodo(p, $, t))))
      ),
      Client
        ? // biome-ignore lint/correctness/noUndeclaredVariables: a literal h(Client, { module }) is how the engine finds the surface module
          (h(Client, {
            key: 'todo-splitter',
            module: './splitter.mjs',
            props: {
              rows: Math.max(10, shown * LIST_ROW_LINES),
              rule: rule(tty),
              accent: accent(tty)
            },
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
    body,
    fun ? el(Text, { key: 'todo-brain-fact', color: 'subtle' }, fun) : null
  );
}

// --- Wiring ---------------------------------------------------------------

/** The pane's shared state, made by the bridge and handed to registerTodos and startTodos. */
export function newTodosPane(rng: () => number = Math.random): TodosPane {
  return {
    ns: 'cortext',
    server: 'substrate',
    project: 'unknown',
    todoPoll: undefined,
    cols: 120,
    rng
  };
}

/** Called from the bridge's session.start hook: one module registers that hook once. */
export async function startTodos(p: TodosPane, $: EngineInterface, cwd: string): Promise<void> {
  p.ns = (await $.env.get('SUBSTRATE_NAMESPACE')) || 'cortext';
  p.server = (await $.env.get('SYNOPTIC_SUBSTRATE_MCP')) || 'substrate';
  p.project = cwd.split('/').filter(Boolean).at(-1) ?? 'unknown';
  await $.command.register({
    name: 'cortext-todos',
    description: 'Open the Todos pane: list, create, edit and close todos'
  });
}

export function registerTodos(on: On, p: TodosPane): void {
  on('command.run', { command: 'cortext-todos' }, async ($) => {
    await update($, brainFact, () => rollBrainFact(p.rng));
    await refreshTodos(p, $);
    p.todoPoll?.cancel();
    p.todoPoll = $.clock.every(AUTO_REFRESH_MS, () => void refreshTodos(p, $));
    await $.ui.open({ id: TODOS_PANE, title: 'Todos' });
    return { text: 'Todos pane opened.' };
  });

  on('ui.close', { id: TODOS_PANE }, async (_$, e, next) => {
    p.todoPoll?.cancel();
    p.todoPoll = undefined;
    return next(e);
  });

  // The splitter posts column moves; the board posts a card's open and a card's move to a lane.
  on('ui.message', async ($, e, next) => {
    const data = e.data as {
      type?: string;
      delta?: number;
      by?: number;
      id?: string;
      status?: string;
    } | null;
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
        if (await setStatus(p, $, t, status)) {
          await note($, `Moved #${t.shortId} to ${humanize(status)}.`);
        }
      }
    }
    if (data?.type === 'step' && typeof data.by === 'number') {
      // An arrow in the list: the neighbour in the whole view.
      const view = viewTodos(await read($, todos), await read($, todoView), await read($, vocab));
      const picked = await read($, selected);
      const at = view.findIndex((r) => r.id === picked);
      const i = Math.min(view.length - 1, Math.max(0, at + Math.sign(data.by)));
      const t = view[i];
      if (t) await selectTodo(p, $, t);
    }
    if (data?.type === 'split' && typeof data.delta === 'number' && p.cols > 0) {
      const step = (data.delta * 100) / p.cols;
      await update($, splitPct, (v) =>
        // Whole points only: the desktop app refuses a width such as "38.2%".
        Math.min(75, Math.max(15, Math.round(v + step)))
      );
    }
    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: TODOS_PANE }, async ($, e) => drawTodos(p, $, e));
}
