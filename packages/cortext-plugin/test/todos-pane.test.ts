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
    expect(await ui.find({ type: 'Input', key: 'f-title-b' })).toBeDefined();
    expect(await ui.find({ type: 'Button', key: 'pick-b' })).toBeDefined();
    expect(await ui.find({ type: 'Input', key: 'f-notes-b' })).toBeDefined();
    expect(await ui.find({ type: 'Button', key: 'todo-close' })).toBeDefined();
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

test('the board puts blocked todos under Needs you, shows tags, and a card opens its detail', async ($, on) => {
  substrate(on, []);
  await $.command.run({ command: 'cortext-todos', args: '' });

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.press({ key: 'todo-layout' });
    expect((await ui.find({ type: 'Text', text: /^Needs you/ }))?.text).toBe('Needs you (1)');
    expect((await ui.find({ type: 'Text', text: /^psa$/ }))?.text).toBe('psa');
    await ui.press({ key: 'open-c' });
    expect(await ui.find({ type: 'Input', key: 'f-title-c' })).toBeDefined();
    await ui.press({ key: 'todo-back' });
    await ui.press({ key: 'todo-layout' });
    await ui.unmount();
  }
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
    await ui.press({ key: 'todo-layout' });
    expect(await ui.find({ type: 'Text', text: /^Could not/ })).toBeUndefined();
    await ui.press({ key: 'todo-layout' });
    await ui.unmount();
  }
});
