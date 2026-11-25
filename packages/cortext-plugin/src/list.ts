import type { ClientKeyEvent, ClientModule, ClientPointerEvent, RenderElement } from 'claude-code';

// The Todos list, drawn whole by this surface module: one line per row, the whole line lit
// under the pointer, the picked row in inverse colors. A click posts `{ type: 'pick', id }`;
// up and down arrows post the neighbour while the list has the focus (a click gives it).

export type ListRow = { id: string; num: string; title: string; tone: string; strong: boolean };
export type ListProps = { rows: ListRow[]; picked: string | null };
type State = { hover?: number };

const latest = new WeakMap<object, ListProps>();

const List: ClientModule<ListProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements;
  latest.set(surface, props);
  if (surface.state === undefined) {
    surface.setState({});
    surface.onPointer((ev: ClientPointerEvent) => {
      const rows = latest.get(surface)?.rows ?? [];
      const at = ev.y >= 0 && ev.y < rows.length ? ev.y : undefined;
      if (ev.type === 'up' && ev.button === 'left' && at !== undefined) {
        const row = rows[at];
        if (row) surface.post({ type: 'pick', id: row.id });
      } else if (ev.type === 'move' && surface.state?.hover !== at) {
        surface.setState({ hover: at });
      } else if (ev.type === 'leave') {
        surface.setState({});
      }
    });
    surface.onKey((k: ClientKeyEvent) => {
      const cur = latest.get(surface);
      if (!cur || cur.rows.length === 0) return;
      const key = k.key.toLowerCase();
      const i = cur.rows.findIndex((r) => r.id === cur.picked);
      const step =
        key === 'down' || key === 'arrowdown' ? 1 : key === 'up' || key === 'arrowup' ? -1 : 0;
      if (step === 0) return;
      const next = cur.rows[Math.min(cur.rows.length - 1, Math.max(0, i + step))];
      if (next) surface.post({ type: 'pick', id: next.id });
    });
  }
  const hover = surface.state?.hover;
  // biome-ignore lint/correctness/noUndeclaredVariables: `h` is the engine's global JSX factory
  return h(
    Box,
    { flexDirection: 'column' },
    ...props.rows.map((r, i) => {
      const on = r.id === props.picked;
      const lit = !on && i === hover;
      // biome-ignore lint/correctness/noUndeclaredVariables: as above
      return h(
        Text,
        { key: `r-${r.id}`, inverse: on, underline: lit, wrap: 'truncate-end' },
        // biome-ignore lint/correctness/noUndeclaredVariables: as above
        h(Text, { color: on ? undefined : r.tone, bold: true }, r.strong ? '● ' : '  '),
        // biome-ignore lint/correctness/noUndeclaredVariables: as above
        h(Text, { dimColor: !on }, `${r.num} `),
        r.title,
        ' '.repeat(Math.max(0, surface.columns))
      );
    })
  ) as RenderElement;
};

export default List;
