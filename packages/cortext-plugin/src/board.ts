import type { ClientModule, ClientPointerEvent, RenderElement } from 'claude-code';

// The Todos board, drawn whole by this surface module so a card is one bordered block that the
// pointer can hover, click and drag. A click posts `{ type: 'open', id }`; a drop on another lane
// posts `{ type: 'move', id, status }`. Layout is fixed-size cells, so a pointer position maps to
// a lane and a card by arithmetic alone.

export type BoardCard = { id: string; title: string; meta: string; tags: string; strong: boolean };
export type BoardLane = { status: string; title: string; tone: string; cards: BoardCard[] };
export type BoardProps = { lanes: BoardLane[]; picked: string | null };

type Drag = { id: string; from: number; x: number; y: number; moved: boolean };
type State = { hover?: string; drag?: Drag; over?: number };

export const CARD_ROWS = 5; // border, title, meta, tags, border
export const HEAD_ROWS = 2; // lane title, blank
const GAP = 2;

/** The lane and card under a cell, for a board drawn `columns` wide. */
export function hitTest(
  lanes: readonly BoardLane[],
  columns: number,
  x: number,
  y: number
): { lane: number; card: number | undefined } {
  const n = Math.max(1, lanes.length);
  const width = Math.max(8, Math.floor((columns - GAP * (n - 1)) / n));
  const lane = Math.min(n - 1, Math.max(0, Math.floor(x / (width + GAP))));
  const row = y - HEAD_ROWS;
  const index = row >= 0 ? Math.floor(row / CARD_ROWS) : -1;
  const cards = lanes[lane]?.cards ?? [];
  return { lane, card: index >= 0 && index < cards.length ? index : undefined };
}

// The latest props per instance: the pointer listener is set once and must read the current lanes.
const latest = new WeakMap<object, BoardProps>();

const Board: ClientModule<BoardProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements;
  latest.set(surface, props);
  const lanes = props.lanes;
  const st = surface.state ?? {};
  if (surface.state === undefined) {
    surface.setState({});
    surface.onPointer((ev: ClientPointerEvent) => {
      const now = surface.state ?? {};
      const cur = latest.get(surface)?.lanes ?? [];
      const at = hitTest(cur, surface.columns, ev.x, ev.y);
      const cardAt = at.card === undefined ? undefined : cur[at.lane]?.cards[at.card];
      if (ev.type === 'down' && ev.button === 'left' && cardAt) {
        surface.setState({
          ...now,
          drag: { id: cardAt.id, from: at.lane, x: ev.x, y: ev.y, moved: false },
          over: at.lane
        });
      } else if (ev.type === 'move' && now.drag) {
        const moved =
          now.drag.moved || Math.abs(ev.x - now.drag.x) + Math.abs(ev.y - now.drag.y) > 1;
        surface.setState({ ...now, drag: { ...now.drag, moved }, over: at.lane });
      } else if (ev.type === 'move') {
        if (now.hover !== cardAt?.id) surface.setState({ ...now, hover: cardAt?.id });
      } else if (ev.type === 'up' && now.drag) {
        const d = now.drag;
        if (!d.moved) surface.post({ type: 'open', id: d.id });
        else if (at.lane !== d.from) {
          const status = cur[at.lane]?.status;
          if (status) surface.post({ type: 'move', id: d.id, status });
        }
        surface.setState({ hover: now.hover });
      } else if (ev.type === 'leave') {
        surface.setState({});
      }
    });
  }

  const n = Math.max(1, lanes.length);
  const width = Math.max(8, Math.floor((surface.columns - GAP * (n - 1)) / n));
  const dragging = st.drag?.moved ? st.drag : undefined;

  const cardEl = (c: BoardCard): RenderElement => {
    const lifted = dragging?.id === c.id;
    const lit = c.id === props.picked || c.id === st.hover;
    // biome-ignore lint/correctness/noUndeclaredVariables: `h` is the engine's global JSX factory
    return h(
      Box,
      {
        key: `c-${c.id}`,
        flexDirection: 'column',
        width,
        height: CARD_ROWS,
        borderStyle: 'round',
        borderColor: lifted ? 'subtle' : lit ? 'suggestion' : 'promptBorder',
        paddingX: 1
      },
      // biome-ignore lint/correctness/noUndeclaredVariables: as above
      h(Text, { bold: c.strong, dimColor: lifted, wrap: 'truncate-end' }, c.title),
      // biome-ignore lint/correctness/noUndeclaredVariables: as above
      h(Text, { color: 'subtle', wrap: 'truncate-end' }, c.meta),
      // biome-ignore lint/correctness/noUndeclaredVariables: as above
      h(Text, { color: 'suggestion', wrap: 'truncate-end' }, c.tags || ' ')
    ) as RenderElement;
  };

  // biome-ignore lint/correctness/noUndeclaredVariables: `h` is the engine's global JSX factory
  return h(
    Box,
    { flexDirection: 'row', gap: GAP },
    ...lanes.map((lane, i) => {
      const target = dragging !== undefined && st.over === i && i !== dragging.from;
      // biome-ignore lint/correctness/noUndeclaredVariables: as above
      return h(
        Box,
        { key: `l-${lane.status}`, flexDirection: 'column', width },
        // biome-ignore lint/correctness/noUndeclaredVariables: as above
        h(
          Text,
          { bold: true, color: lane.tone, underline: target, wrap: 'truncate-end' },
          `${lane.title} ${lane.cards.length}${target ? '  · drop here' : ''}`
        ),
        // biome-ignore lint/correctness/noUndeclaredVariables: as above
        h(Text, {}, ' '),
        ...(lane.cards.length === 0
          ? // biome-ignore lint/correctness/noUndeclaredVariables: as above
            [h(Text, { color: 'subtle' }, target ? '' : 'Empty')]
          : lane.cards.map(cardEl))
      );
    })
  ) as RenderElement;
};

export default Board;
