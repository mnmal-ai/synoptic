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
function substrate(on: any, writes: unknown[]) {
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
          : { [key]: ROWS };
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
    // Priority sort: high first, so "High one" is the picked row and the detail title.
    const titles = await ui.findAll({ type: 'Text', text: /one$/ });
    expect(titles.map((t) => t.text)).toContain('High one');
    expect(await ui.find({ type: 'Button', key: 'open-notes' })).toBeDefined();
    expect(await ui.find({ type: 'Button', key: 'todo-close' })).toBeDefined();
    await ui.unmount();
  }
});

test('a press on a field swaps in its editor, and Enter saves just that field', async ($, on) => {
  const writes: unknown[] = [];
  substrate(on, writes);
  await $.command.run({ command: 'cortext-todos', args: '' });

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  await ui.press({ key: 'open-notes' });
  const input = await ui.find({ type: 'Input', key: 'input-notes-b' });
  expect(input).toBeDefined();
  await ui.input({ key: 'input-notes-b', text: 'new notes' });
  expect(JSON.stringify(writes)).toContain('"notes":"new notes"');
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
