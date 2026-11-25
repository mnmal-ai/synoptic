import type { ClientKeyEvent, ClientModule, ClientPointerEvent, RenderElement } from 'claude-code';
import { wrapLines } from './pane-text.js';

// The Todos list, drawn whole by this surface module: each row is its title on up to two
// lines and a quiet line of facts (priority, status, area), the whole row lit under the
// pointer and the picked row filled. A click posts `{ type: 'pick', id }`;
// up and down arrows post `{ type: 'step', by }` while the list has the focus (a click gives it).

export type ListRow = {
  id: string;
  num: string;
  title: string;
  /** What the row's quiet line says, as parts: `High`, `Open`, an area. */
  facts: { text: string; tone?: string }[];
};
export type ListProps = { rows: ListRow[]; picked: string | null; tty?: boolean };
type State = { hover?: number };

/** Each row is two title lines and a facts line; the facts line's quiet text parts the rows. */
export const ROW_LINES = 3;
/** The most rows drawn at once. */
export const MAX_ROWS = 120;

// Off the terminal the picked row and the row under the pointer take a brand-tinted fill;
// on the terminal they keep inverse and underline, which every terminal theme draws.
const PICKED_FILL = '#0a9fdc2e';
const HOVER_FILL = '#8593a81f';

const latest = new WeakMap<object, ListProps>();

const List: ClientModule<ListProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements;
  latest.set(surface, props);
  if (surface.state === undefined) {
    surface.setState({});
    surface.onPointer((ev: ClientPointerEvent) => {
      const rows = latest.get(surface)?.rows ?? [];
      const i = Math.floor(ev.y / ROW_LINES);
      const at = ev.y >= 0 && i < rows.length && ev.y % ROW_LINES < ROW_LINES - 1 ? i : undefined;
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
      const key = k.key.toLowerCase();
      const by =
        key === 'down' || key === 'arrowdown' ? 1 : key === 'up' || key === 'arrowup' ? -1 : 0;
      // The list draws only a window of rows, so the pane picks the neighbour from all of them.
      if (by !== 0) surface.post({ type: 'step', by });
    });
  }
  const hover = surface.state?.hover;
  const width = Math.max(8, surface.columns);
  // biome-ignore lint/correctness/noUndeclaredVariables: `h` is the engine's global JSX factory
  const t = h;
  // Only props that are on: the engine refuses a tree past 100,000 characters, and a list can
  // hold a few hundred rows. Past MAX_ROWS the list says how many it leaves out.
  const on = (v: boolean, k: string) => (v ? { [k]: true } : {});
  const shown = props.rows.slice(0, MAX_ROWS);
  const rest = props.rows.length - shown.length;
  return t(
    Box,
    { flexDirection: 'column' },
    ...shown.map((r, i) => {
      const picked = r.id === props.picked;
      const lit = !picked && i === hover;
      // The terminal marks a row in its text; elsewhere the row's box takes a fill.
      const mark = props.tty ? { ...on(picked, 'inverse'), ...on(lit, 'underline') } : {};
      const fill = props.tty ? undefined : picked ? PICKED_FILL : lit ? HOVER_FILL : undefined;
      const lead = `${r.num} `;
      const [first = '', second = ''] = wrapLines(`${lead}${r.title}`, width - 2, 2);
      const facts: (string | RenderElement)[] = [];
      for (const f of r.facts) {
        const sep = facts.length ? ' · ' : '';
        if (f.tone) facts.push(sep, t(Text, { color: f.tone }, f.text));
        else facts.push(`${sep}${f.text}`);
      }
      const title = { ...mark, ...on(picked, 'bold') };
      return t(
        Box,
        {
          key: `r-${r.id}`,
          flexDirection: 'column',
          paddingX: 1,
          ...(fill ? { backgroundColor: fill } : {})
        },
        t(
          Text,
          title,
          t(Text, on(!picked, 'dimColor'), first.slice(0, lead.length)),
          first.slice(lead.length)
        ),
        t(Text, title, second || ' '),
        t(Text, { ...mark, ...on(!picked, 'dimColor'), wrap: 'truncate-end' }, ...facts)
      );
    }),
    ...(rest > 0
      ? [t(Text, { dimColor: true }, ` ${rest} more. Search or filter to narrow the list.`)]
      : [])
  ) as RenderElement;
};

export default List;
