import type { ClientModule, ClientPointerEvent } from 'claude-code';

// The list view's divider: a one-column region that turns a drag into column deltas, posted to
// the hooks module as `{ type: 'split', delta }`. Left and right arrows move it two columns
// while it has the focus (a click gives it).

type State = { last?: number };

const Splitter: ClientModule<{ rows: number; rule?: string; accent?: string }, State> = (
  props,
  surface
) => {
  const { Box, Text } = surface.elements;
  if (surface.state === undefined) {
    surface.setState({});
    surface.onPointer((ev: ClientPointerEvent) => {
      const last = surface.state?.last;
      if (ev.type === 'down' && ev.button === 'left') {
        surface.setState({ last: ev.x });
      } else if (ev.type === 'move' && ev.button === 'left' && last !== undefined) {
        const delta = ev.x - last;
        if (delta === 0) return;
        surface.post({ type: 'split', delta });
        // The region moves with the divider, so the pointer sits `delta` closer to it after the post.
        surface.setState({ last: ev.x - delta });
      } else if (ev.type === 'up') {
        surface.setState({});
      }
    });
    surface.onKey((k) => {
      const key = k.key.toLowerCase();
      if (key === 'left' || key === 'arrowleft') surface.post({ type: 'split', delta: -2 });
      if (key === 'right' || key === 'arrowright') surface.post({ type: 'split', delta: 2 });
    });
  }
  const dragging = surface.state?.last !== undefined;
  const rows = Math.max(1, Math.min(200, props.rows));
  // biome-ignore lint/correctness/noUndeclaredVariables: `h` is the engine's global JSX factory
  const line = h(
    Text,
    { color: dragging ? (props.accent ?? 'suggestion') : (props.rule ?? 'promptBorder') },
    Array(rows).fill('│').join('\n')
  );
  // biome-ignore lint/correctness/noUndeclaredVariables: as above
  return h(Box, { flexDirection: 'column', width: 1 }, line) as ReturnType<ClientModule>;
};

export default Splitter;
