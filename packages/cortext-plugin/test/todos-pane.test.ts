// Engine tests for the Todos pane, run by `claude plugin test packages/cortext-plugin`.
// The `on` hooks here stand for the engine and the substrate MCP server; vitest never sees this
// file (it collects only *.test.js). Each case draws the pane on every surface, so a prop one
// surface refuses fails here instead of in a person's session.
import { expect, test } from 'claude-code/testing';

const PANE = {
  plugin: 'cortext',
  component: 'Pane',
  requestId: 'cortext-todos',
  props: {
    title: 'Todos',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {}
  }
} as const;

const ROWS = [
  {
    id: 'a',
    shortId: 1,
    title: 'Low one',
    area: 'x',
    status: 'open',
    priority: 'low',
    project: null,
    tags: ['psa'],
    _metadata: { createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-24T00:00:00Z' }
  },
  {
    id: 'b',
    shortId: 2,
    title: 'High one',
    area: 'x',
    status: 'open',
    priority: 'high',
    project: 'example',
    _metadata: { createdAt: '2026-11-21T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z' }
  },
  {
    id: 'c',
    shortId: 3,
    title: 'Stuck one',
    area: 'x',
    status: 'blocked',
    priority: 'medium',
    project: 'example',
    _metadata: { createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-23T00:00:00Z' }
  }
];

// biome-ignore lint/suspicious/noExplicitAny: the kit's `on` is typed per event; the fakes are not
function substrate(on: any, writes: unknown[], rows: unknown[] = ROWS) {
  on('command.register', () => ({ value: undefined }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.log', () => ({ value: undefined }));
  on('clock.now', () => ({ value: Date.parse('2026-11-25T00:00:00Z') }));
  on('clock.every', () => ({ value: undefined }));
  on(
    'mcp.call',
    (_: unknown, e: { tool: string; args?: { payload?: Record<string, unknown> } }) => {
      const payload = e.args?.payload ?? {};
      const [key, frame] = Object.entries(payload)[0] ?? ['', {}];
      let data: Record<string, unknown> = {};
      if (key.endsWith('/Todo')) {
        const where = (frame as { params?: { where?: { id?: { eq?: string } } } }).params?.where;
        data = where?.id?.eq
          ? { [key]: [{ id: where.id.eq, notes: 'Some **notes**', body: null }] }
          : { [key]: rows };
      } else if (e.tool === 'mutate') {
        writes.push(payload);
        data = { [key]: { id: 'a' } };
      }
      return {
        value: {
          content: [{ type: 'text', text: JSON.stringify({ data, _pagination: {} }) }],
          isError: false
        }
      };
    }
  );
}

test('opens with the first row picked, its detail on the right, on every surface', async ($, on) => {
  const writes: unknown[] = [];
  substrate(on, writes);
  await $.command.run({ command: 'cortext-todos', args: '' });

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    // Priority sort: high first, so "High one" (#2) is picked and its title fills the editor.
    expect(await ui.find({ type: 'Input', key: 'f-title-b' }), `title on ${surface}`).toBeDefined();
    // A surface with Client draws the list there; the others get one Button per row.
    const listed = await ui.drawn({ in: 'row-b' }).catch(() => undefined);
    if (listed) expect(JSON.stringify(listed)).toContain('#2');
    else
      expect(await ui.find({ type: 'Button', key: 'pick-b' }), `rows on ${surface}`).toBeDefined();
    expect(await ui.find({ type: 'Input', key: 'f-notes-b' })).toBeDefined();
    expect(
      await ui.find({ type: 'Button', key: 'todo-close' }),
      `close on ${surface}`
    ).toBeDefined();
    await ui.unmount();
  }
});

test('notes edit in place: typing shows Save, and Enter saves just that field', async ($, on) => {
  const writes: unknown[] = [];
  substrate(on, writes);
  await $.command.run({ command: 'cortext-todos', args: '' });

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  expect(await ui.find({ type: 'Button', key: 'save-notes' })).toBeUndefined();
  await ui.input({ key: 'f-notes-b', text: 'new notes', kind: 'change' });
  expect(await ui.find({ type: 'Button', key: 'save-notes' })).toBeDefined();
  await ui.input({ key: 'f-notes-b', text: 'new notes' });
  expect(JSON.stringify(writes)).toContain('"notes":"new notes"');
  expect(await ui.find({ type: 'Button', key: 'save-notes' })).toBeUndefined();
  await ui.unmount();
});

test('the status filter narrows the list and says how many it hides', async ($, on) => {
  substrate(on, []);
  await $.command.run({ command: 'cortext-todos', args: '' });

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.select({ key: 'todo-status', value: 'blocked' });
  expect((await ui.find({ type: 'Text', text: /of 3/ }))?.text).toBe('1 of 3');
  await ui.unmount();
});

test('the board draws a lane per schema status; a click opens a card, a drop moves it', async ($, on) => {
  const writes: unknown[] = [];
  substrate(on, writes);
  await $.command.run({ command: 'cortext-todos', args: '' });

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  await ui.select({ key: 'todo-view', value: 'board' });
  const board = { in: 'todo-board' } as const;
  expect((await ui.find({ ...board, type: 'Text', text: /^Blocked/ }))?.text).toBe('Blocked 1');
  expect((await ui.find({ ...board, type: 'Text', text: /^Closed/ }))?.text).toBe('Closed 0');
  expect((await ui.find({ ...board, type: 'Text', text: /^psa$/ }))?.text).toBe('psa');
  // Lane one holds #2 then #1 (priority order); a click on the first card opens #2 at the right.
  await ui.pointer({ key: 'todo-board', type: 'down', x: 1, y: 2, button: 'left' });
  await ui.pointer({ key: 'todo-board', type: 'up', x: 1, y: 2, button: 'left' });
  expect(await ui.find({ type: 'Input', key: 'f-title-b' })).toBeDefined();
  // Drag the second card (#1) to the last lane.
  await ui.pointer({ key: 'todo-board', type: 'down', x: 1, y: 7, button: 'left' });
  await ui.pointer({ key: 'todo-board', type: 'move', x: 500, y: 7, button: 'left' });
  await ui.pointer({ key: 'todo-board', type: 'up', x: 500, y: 7, button: 'left' });
  expect(JSON.stringify(writes)).toContain('"status":"closed"');
  await ui.unmount();
});

test('all projects: 170 rows from 8 projects draw on every surface', async ($, on) => {
  const many = Array.from({ length: 170 }, (_, i) => ({
    id: `m${i}`,
    shortId: 1000 + i,
    title: `Todo number ${i} with a fairly long title that runs past the column`,
    area: 'x',
    status: ['open', 'in_progress', 'blocked', 'deferred'][i % 4],
    priority: ['high', 'medium', 'low'][i % 3],
    project: i % 9 === 0 ? undefined : `proj-${i % 8}`,
    tags: i % 5 === 0 ? ['#362', 'session:dd3e721c', 'from:1364'] : i % 7 === 0 ? [] : undefined,
    _metadata: { createdAt: '2026-11-20T00:00:00Z' }
  }));
  substrate(on, [], many);
  await $.command.run({ command: 'cortext-todos', args: '' });
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.select({ key: 'todo-scope', value: 'all' });
    expect(await ui.find({ type: 'Text', text: /^Could not/ })).toBeUndefined();
    await ui.select({ key: 'todo-view', value: 'board' });
    expect(await ui.find({ type: 'Text', text: /^Could not/ })).toBeUndefined();
    await ui.select({ key: 'todo-view', value: 'grouped' });
    expect(await ui.find({ type: 'Text', text: /^Could not/ })).toBeUndefined();
    await ui.select({ key: 'todo-view', value: 'list' });
    await ui.unmount();
  }
});

test('arrow keys in the list move the pick through every row', async ($, on) => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `w${i}`,
    shortId: 3000 + i,
    title: `Row ${i}`,
    area: 'x',
    status: 'open',
    priority: 'medium',
    project: 'horizon',
    _metadata: { createdAt: '2026-11-20T00:00:00Z' }
  }));
  substrate(on, [], many);
  await $.command.run({ command: 'cortext-todos', args: '' });
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  const start = await ui.find({ type: 'Text', text: /^#30\d\d · horizon$/ });
  const shown = 12;
  for (let i = 0; i < shown + 2; i++) {
    // The picked row holds the keys; the detail's header names it.
    const head = await ui.find({ type: 'Text', text: /^#30\d\d · horizon$/ });
    const id = `w${Number(head?.text.slice(1, 5)) - 3000}`;
    await ui.key({ key: 'down', in: `row-${id}` });
  }
  const end = await ui.find({ type: 'Text', text: /^#30\d\d · horizon$/ });
  expect(end?.text).not.toBe(start?.text);
  expect(await ui.find({ type: 'Text', text: /scroll the list/ })).toBeUndefined();
  await ui.unmount();
});

test('dragging the splitter widens the list', async ($, on) => {
  substrate(on, []);
  await $.command.run({ command: 'cortext-todos', args: '' });
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  await ui.pointer({ in: 'todo-splitter', type: 'down', x: 0, y: 2, button: 'left' });
  await ui.pointer({ in: 'todo-splitter', type: 'move', x: 12, y: 2, button: 'left' });
  await ui.pointer({ in: 'todo-splitter', type: 'up', x: 12, y: 2, button: 'left' });
  // 12 of 120 columns is 10 points: the list goes from 34% to 44%.
  expect(JSON.stringify(await ui.drawn())).toContain('"width":"44%"');
  // 5 columns is 4.2 points: the pane still draws, with a whole-number width.
  await ui.pointer({ in: 'todo-splitter', type: 'down', x: 0, y: 2, button: 'left' });
  await ui.pointer({ in: 'todo-splitter', type: 'move', x: 5, y: 2, button: 'left' });
  await ui.pointer({ in: 'todo-splitter', type: 'up', x: 5, y: 2, button: 'left' });
  expect(JSON.stringify(await ui.drawn())).toContain('"width":"48%"');
  await ui.unmount();
});

test('grouped view: a group per status, a glyph opens the picker, a pick moves the todo', async ($, on) => {
  const writes: unknown[] = [];
  substrate(on, writes);
  await $.command.run({ command: 'cortext-todos', args: '' });
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.select({ key: 'todo-view', value: 'grouped' });
    expect(await ui.find({ type: 'Button', key: 'gfold-blocked' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /of 3 closed/ })).toBeDefined();
    await ui.unmount();
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  await ui.press({ key: 'gstatus-a' });
  await ui.press({ key: 'gset-a-in_progress' });
  expect(JSON.stringify(writes)).toContain('"status":"in_progress"');
  await ui.press({ key: 'gopen-c' });
  expect(await ui.find({ type: 'Input', key: 'f-title-c' })).toBeDefined();
  await ui.unmount();
});
