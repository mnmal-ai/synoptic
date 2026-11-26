import type { ClientKeyEvent, ClientModule, ClientPointerEvent, RenderElement } from 'claude-code';
import { wrapLines } from './todo-text.js';

// One Todos list row, drawn by this surface module: the title on up to two lines and a quiet
// line of facts (priority, status, area), lit under the pointer and filled when picked. The
// pane draws one instance per row on screen, so the app spaces the rows natively and a click
// needs no arithmetic. A click posts `{ type: 'pick', id }`; up and down arrows post
// `{ type: 'step', by }` while the row has the focus (a click gives it).

export type ListRow = {
  id: string;
  num: string;
  title: string;
  /** What the row's quiet line says, as parts: `High`, `Open`, an area. */
  facts: { text: string; tone?: string }[];
};
export type RowProps = { row: ListRow; picked: boolean; tty?: boolean };
type State = { hover?: boolean };

/** Each row is two title lines and a facts line. */
export const ROW_LINES = 3;

// Off the terminal the picked row and the row under the pointer take a brand-tinted fill;
// on the terminal they keep inverse and underline, which every terminal theme draws.
const PICKED_FILL = '#0a9fdc2e';
const HOVER_FILL = '#8593a81f';

const latest = new WeakMap<object, RowProps>();

const Row: ClientModule<RowProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements;
  latest.set(surface, props);
  if (surface.state === undefined) {
    surface.setState({});
    surface.onPointer((ev: ClientPointerEvent) => {
      const id = latest.get(surface)?.row.id;
      if (ev.type === 'up' && ev.button === 'left' && id) surface.post({ type: 'pick', id });
      else if ((ev.type === 'move' || ev.type === 'enter') && !surface.state?.hover)
        surface.setState({ hover: true });
      else if (ev.type === 'leave') surface.setState({});
    });
    surface.onKey((k: ClientKeyEvent) => {
      const key = k.key.toLowerCase();
      const by =
        key === 'down' || key === 'arrowdown' ? 1 : key === 'up' || key === 'arrowup' ? -1 : 0;
      if (by !== 0) surface.post({ type: 'step', by });
    });
  }
  const r = props.row;
  const on = props.picked;
  const lit = !on && surface.state?.hover === true;
  const width = Math.max(8, surface.columns);
  const flag = (v: boolean, k: string) => (v ? { [k]: true } : {});
  // The terminal marks a row in its text; elsewhere the row's box takes a fill.
  const mark = props.tty ? { ...flag(on, 'inverse'), ...flag(lit, 'underline') } : {};
  const fill = props.tty ? undefined : on ? PICKED_FILL : lit ? HOVER_FILL : undefined;
  const lead = `${r.num} `;
  const [first = '', second = ''] = wrapLines(`${lead}${r.title}`, width - 2, 2);
  // biome-ignore lint/correctness/noUndeclaredVariables: `h` is the engine's global JSX factory
  const t = h;
  const facts: (string | RenderElement)[] = [];
  for (const f of r.facts) {
    const sep = facts.length ? ' · ' : '';
    if (f.tone) facts.push(sep, t(Text, { color: f.tone }, f.text));
    else facts.push(`${sep}${f.text}`);
  }
  const title = { ...mark, ...flag(on, 'bold') };
  // The terminal's cells are the letters' width, so the title is folded here; elsewhere the
  // letters are narrower than a cell, so the app folds it to the row's real width.
  const titleLines = props.tty
    ? [
        t(
          Text,
          title,
          t(Text, flag(!on, 'dimColor'), first.slice(0, lead.length)),
          first.slice(lead.length)
        ),
        t(Text, title, second || ' ')
      ]
    : [
        t(
          Box,
          { height: 2 },
          t(Text, { ...title, maxLines: 2 }, t(Text, flag(!on, 'dimColor'), lead), r.title)
        )
      ];
  return t(
    Box,
    {
      flexDirection: 'column',
      paddingX: 1,
      height: ROW_LINES,
      ...(fill ? { backgroundColor: fill } : {})
    },
    ...titleLines,
    t(Text, { ...mark, ...flag(!on, 'dimColor'), wrap: 'truncate-end' }, ...facts)
  ) as RenderElement;
};

export default Row;
