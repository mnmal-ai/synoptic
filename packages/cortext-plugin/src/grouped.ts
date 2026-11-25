// The Todos pane's Grouped view. Adapted from the list view of todo-sidebar
// (https://github.com/stoumann/todo-sidebar, MIT License, Copyright (c) 2026 Mark Stoumann; see
// THIRD_PARTY_LICENSES.txt): a heading with a progress bar, then one folding group per status,
// its rows in a card bordered in the status's color. A row's glyph opens a status picker under
// it; its title opens the todo in the side rail. Statuses come from the server's schema.
import type { RenderElement, RenderSurface } from 'claude-code';
import { icon } from './icons.js';
import { humanize } from './pane-text.js';

export type GroupedRow = {
  id: string;
  shortId: number;
  title: string;
  status: string;
  priority: string;
  project: string | null;
};

type Els = Record<string, unknown>;

// Each status's color as a raw color for surfaces other than the terminal, which takes theme
// keys: readable on dark and light themes, and what an Svg image needs.
const HEX: Record<string, string | null> = {
  open: null,
  in_progress: '#58a6ff',
  blocked: '#d29922',
  deferred: '#8b949e',
  closed: '#3fb950'
};
const THEME: Record<string, string | null> = {
  open: null,
  in_progress: 'suggestion',
  blocked: 'warning',
  deferred: 'subtle',
  closed: 'success'
};
const GLYPH: Record<string, string> = {
  open: '○',
  in_progress: '◐',
  blocked: '■',
  deferred: '◌',
  closed: '✓'
};
const ICON: Record<string, string> = {
  open: 'circle',
  in_progress: 'progress',
  blocked: 'hand-stop',
  deferred: 'clock-pause',
  closed: 'circle-check'
};
const TRACK = '#8b949e33';
const ROW_HOVER = '#8b949e1f';
const NEUTRAL = '#8b949e';

export type GroupedArgs = {
  els: Els;
  surface: RenderSurface;
  el: (...args: Parameters<typeof h>) => RenderElement;
  heading: string;
  statuses: readonly string[];
  rows: readonly GroupedRow[];
  allProjects: boolean;
  picked: string | null;
  pickerFor: string | null;
  folded: readonly string[];
  columns: number;
  onOpen: (row: GroupedRow) => void;
  onTogglePicker: (row: GroupedRow) => void;
  onSetStatus: (row: GroupedRow, status: string) => void;
  onToggleGroup: (status: string) => void;
};

/** The Grouped view's tree: heading and progress, then a group per status that has rows. */
export function groupedView(a: GroupedArgs): RenderElement {
  const { el } = a;
  type Tag = Parameters<typeof h>[0];
  const { Box, Text, Button } = a.els as { Box: Tag; Text: Tag; Button: Tag };
  const Svg = a.surface !== 'terminal' ? (a.els.Svg as Tag | undefined) : undefined;
  const tty = a.surface === 'terminal';
  const tone = (s: string): string | null => (tty ? (THEME[s] ?? null) : (HEX[s] ?? null));

  const glyph = (s: string) => {
    const color = tone(s);
    return color ? el(Text, { color }, GLYPH[s] ?? '•') : el(Text, {}, GLYPH[s] ?? '•');
  };
  // The group's mark: the Tabler icon where Svg draws, its glyph elsewhere.
  const mark = (s: string) =>
    Svg
      ? el(Svg, {
          source: icon(ICON[s] ?? 'circle', HEX[s] ?? NEUTRAL),
          alt: humanize(s),
          width: 16,
          height: 16
        })
      : glyph(s);
  const border = (s: string) => {
    const color = tone(s);
    if (!color) return { borderDimColor: true };
    return tty ? { borderColor: color, borderDimColor: true } : { borderColor: `${color}59` };
  };
  const rowHover = tty ? {} : { hover: { backgroundColor: ROW_HOVER } };

  const row = (r: GroupedRow): RenderElement => {
    const done = r.status === 'closed';
    const meta = [
      r.priority === 'high' ? el(Text, { color: tty ? 'warning' : '#d29922' }, 'high') : null,
      a.allProjects ? el(Text, { dimColor: true }, r.project ?? 'cross-cutting') : null,
      el(Text, { dimColor: true }, `#${r.shortId}`)
    ].filter(Boolean) as RenderElement[];
    return el(
      Box,
      { flexDirection: 'column' },
      el(
        Box,
        { key: `grow-${r.id}`, flexDirection: 'row', gap: 1, ...rowHover },
        el(
          Box,
          { flexShrink: 0 },
          // A desktop draws a Button's label in place of its children, so the label is the glyph.
          el(
            Button,
            {
              key: `gstatus-${r.id}`,
              label: GLYPH[r.status] ?? '•',
              plain: true,
              onPress: () => a.onTogglePicker(r)
            },
            glyph(r.status)
          )
        ),
        el(
          Box,
          { flexGrow: 1, flexShrink: 1, minWidth: 0 },
          el(
            Button,
            { key: `gopen-${r.id}`, label: r.title, plain: true, onPress: () => a.onOpen(r) },
            el(
              Text,
              {
                wrap: 'truncate-end',
                strikethrough: done,
                dimColor: done,
                bold: r.id === a.picked
              },
              r.title
            )
          )
        ),
        el(Box, { flexShrink: 0, flexDirection: 'row', gap: 1 }, ...meta)
      ),
      a.pickerFor === r.id ? picker(r) : null
    );
  };

  // The statuses to move a row to, opened under it by its glyph.
  const picker = (r: GroupedRow) =>
    el(
      Box,
      {
        flexDirection: 'column',
        alignSelf: 'flex-start',
        borderStyle: 'round',
        borderDimColor: true,
        paddingX: 1
      },
      ...a.statuses.map((s) =>
        el(
          Button,
          {
            key: `gset-${r.id}-${s}`,
            label: `${GLYPH[s] ?? '•'} ${humanize(s)}`,
            plain: true,
            onPress: () => a.onSetStatus(r, s)
          },
          glyph(s),
          el(Text, { bold: s === r.status }, ` ${humanize(s)}`)
        )
      )
    );

  // How far the list has come: closed, in progress and blocked as shares of all.
  const total = a.rows.length;
  const count = (s: string) => a.rows.filter((r) => r.status === s).length;
  const parts = [
    ['closed', count('closed')],
    ['in_progress', count('in_progress')],
    ['blocked', count('blocked')]
  ] as const;
  const progress = () => {
    if (total === 0) return null;
    if (Svg) {
      const [width, height] = [1000, 8];
      let x = 0;
      const rects = parts.map(([s, n]) => {
        const w = Math.round((width * n) / total);
        const rect = `<rect x="${x}" width="${w}" height="${height}" fill="${HEX[s]}"/>`;
        x += w;
        return rect;
      });
      const source =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
        `<clipPath id="bar"><rect width="${width}" height="${height}" rx="${height / 2}"/></clipPath>` +
        `<g clip-path="url(#bar)"><rect width="${width}" height="${height}" fill="${TRACK}"/>${rects.join('')}</g></svg>`;
      return el(Svg, { source, alt: `${count('closed')} of ${total} closed` });
    }
    const width = Math.max(10, Math.min(60, a.columns - 2));
    const [done, doing, waiting] = parts.map(([, n]) => Math.round((width * n) / total));
    return el(
      Text,
      {},
      el(Text, { color: 'success' }, '━'.repeat(done ?? 0)),
      el(Text, { color: 'suggestion' }, '━'.repeat(doing ?? 0)),
      el(Text, { color: 'warning' }, '━'.repeat(waiting ?? 0)),
      el(
        Text,
        { dimColor: true },
        '━'.repeat(Math.max(0, width - (done ?? 0) - (doing ?? 0) - (waiting ?? 0)))
      )
    );
  };

  // A group: its heading, which folds it away, over a card in the status's color.
  const group = (s: string, rows: readonly GroupedRow[]) => {
    const open = !a.folded.includes(s);
    return el(
      Box,
      { key: `group-${s}`, flexDirection: 'column', gap: 1 },
      el(
        Box,
        { flexDirection: 'row', justifyContent: 'space-between', paddingX: 1 },
        el(
          Box,
          { flexDirection: 'row', gap: 1, alignItems: 'center' },
          mark(s),
          el(Button, {
            key: `gfold-${s}`,
            label: humanize(s),
            plain: true,
            onPress: () => a.onToggleGroup(s)
          })
        ),
        el(
          Box,
          { flexDirection: 'row', gap: 2 },
          el(Text, { dimColor: true, tabular: true }, String(rows.length)),
          el(Button, {
            key: `gfold-${s}-chev`,
            label: open ? '▾' : '▸',
            plain: true,
            dimColor: true,
            onPress: () => a.onToggleGroup(s)
          })
        )
      ),
      open
        ? el(
            Box,
            { flexDirection: 'column', borderStyle: 'round', ...border(s), paddingX: 1 },
            ...rows.map(row)
          )
        : null
    );
  };

  const groups = a.statuses
    .map((s) => ({ s, rows: a.rows.filter((r) => r.status === s) }))
    .filter((g) => g.rows.length > 0);

  return el(
    Box,
    { flexDirection: 'column', gap: 2 },
    el(
      Box,
      { flexDirection: 'column', gap: 1 },
      el(
        Box,
        { flexDirection: 'row', justifyContent: 'space-between' },
        el(Text, { bold: true }, a.heading),
        total > 0 ? el(Text, { dimColor: true }, `${count('closed')} of ${total} closed`) : null
      ),
      progress()
    ),
    groups.length === 0
      ? el(
          Box,
          { flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1 },
          el(Text, {}, 'Nothing open.'),
          el(Text, { dimColor: true }, 'Add a todo above, or ask Claude to put one on the list.')
        )
      : null,
    ...groups.map((g) => group(g.s, g.rows))
  );
}
