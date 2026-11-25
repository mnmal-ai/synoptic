// Icons from Tabler Icons (https://github.com/tabler/tabler-icons), outline set, MIT License,
// Copyright (c) 2020-2026 Paweł Kuna. The path data is copied as published; see THIRD_PARTY_LICENSES.txt.

const PATHS: Record<string, readonly string[]> = {
  'arrow-back-up': ['M9 14l-4 -4l4 -4', 'M5 10h11a4 4 0 1 1 0 8h-1'],
  'chevron-down': ['M6 9l6 6l6 -6'],
  'chevron-up': ['M6 15l6 -6l6 6'],
  inbox: [
    'M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12',
    'M4 13h3l3 3h4l3 -3h3'
  ],
  'layout-sidebar-right-expand': [
    'M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12',
    'M15 4v16',
    'M10 10l-2 2l2 2'
  ],
  mail: [
    'M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10',
    'M3 7l9 6l9 -6'
  ],
  'mail-opened': [
    'M3 9l9 6l9 -6l-9 -6l-9 6',
    'M21 9v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10',
    'M3 19l6 -6',
    'M15 13l6 6'
  ],
  send: [
    'M10 14l11 -11',
    'M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5'
  ],
  'circle-check': ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M9 12l2 2l4 -4'],
  circle: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0'],
  'clock-pause': ['M20.942 13.018a9 9 0 1 0 -7.909 7.922', 'M12 7v5l2 2', 'M17 17v5', 'M21 17v5'],
  'hand-stop': [
    'M8 13v-7.5a1.5 1.5 0 0 1 3 0v6.5',
    'M11 5.5v-2a1.5 1.5 0 1 1 3 0v8.5',
    'M14 5.5a1.5 1.5 0 0 1 3 0v6.5',
    'M17 7.5a1.5 1.5 0 0 1 3 0v8.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7a69.74 69.74 0 0 1 -.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.47 1.47'
  ],
  'layout-kanban': [
    'M4 4l6 0',
    'M14 4l6 0',
    'M4 10a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2l0 -8',
    'M14 10a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2l0 -2'
  ],
  'layout-list': [
    'M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -2',
    'M4 16a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -2'
  ],
  list: ['M9 6l11 0', 'M9 12l11 0', 'M9 18l11 0', 'M5 6l0 .01', 'M5 12l0 .01', 'M5 18l0 .01'],
  notes: [
    'M5 5a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -14',
    'M9 7l6 0',
    'M9 11l6 0',
    'M9 15l4 0'
  ],
  progress: [
    'M10 20.777a8.942 8.942 0 0 1 -2.48 -.969',
    'M14 3.223a9.003 9.003 0 0 1 0 17.554',
    'M4.579 17.093a8.961 8.961 0 0 1 -1.227 -2.592',
    'M3.124 10.5c.16 -.95 .468 -1.85 .9 -2.675l.169 -.305',
    'M6.907 4.579a8.954 8.954 0 0 1 3.093 -1.356'
  ],
  refresh: ['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4']
};

export type IconName = keyof typeof PATHS;

/** One Tabler icon as an SVG document, stroked in `color` (a raw color: an Svg image has no theme). */
export function icon(name: string, color: string, size = 16): string {
  const paths = (PATHS[name] ?? []).map((d) => `<path d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
