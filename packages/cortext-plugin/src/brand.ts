// The mnmal-ai palette, from the Substrate site's stylesheet (mnmal-ai.github.io/substrate):
// cyan accent, magenta mark, yellow signal, slate text. The site is dark only, so each color here
// is nudged to stay readable on the desktop app's light theme too. The terminal takes theme keys
// instead, so a person's terminal theme still decides there.

export const BRAND = {
  /** The site's `--accent` (#00aeef), a shade deeper so it reads on white. */
  accent: '#0a9fdc',
  /** The mark's magenta (#ff3794). */
  magenta: '#f0358c',
  /** The site's `--yellow` (#ffe644), deepened to amber so it reads on white. */
  yellow: '#d9a600',
  /** Between the site's `--muted` (#94a3b8) and slate-500, for both themes. */
  slate: '#8593a8'
} as const;

/** A translucent fill: `alpha` is two hex digits. */
export function tint(hex: string, alpha: string): string {
  return `${hex}${alpha}`;
}

/** The picked row's fill and the row under the pointer's. */
export const PICKED_FILL = tint(BRAND.accent, '2e');
export const HOVER_FILL = tint(BRAND.slate, '1f');

const STATUS_HEX: Record<string, string> = {
  open: BRAND.accent,
  in_progress: BRAND.magenta,
  blocked: BRAND.yellow,
  deferred: BRAND.slate,
  closed: BRAND.slate
};

const STATUS_KEY: Record<string, string> = {
  open: 'suggestion',
  in_progress: 'claude',
  blocked: 'warning',
  deferred: 'subtle',
  closed: 'subtle'
};

/** A status's color: a theme key on the terminal, a brand color elsewhere. */
export function statusTone(status: string, tty: boolean): string {
  return tty ? (STATUS_KEY[status] ?? 'text') : (STATUS_HEX[status] ?? BRAND.slate);
}

/** The accent: the theme's suggestion color on the terminal, brand cyan elsewhere. */
export function accent(tty: boolean): string {
  return tty ? 'suggestion' : BRAND.accent;
}

/** A quiet border: the prompt's on the terminal, slate at low weight elsewhere. */
export function rule(tty: boolean): string {
  return tty ? 'promptBorder' : tint(BRAND.slate, '59');
}

// The mnmal-ai mark as published in the site's favicon: two chevrons and a bar on magenta.
export const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" rx="14" fill="#ff3794"/><path fill="#1a1a1a" d="M12.33 36 L23.698 24.632 L31.737 24.632 L31.737 36 L28.407 36 L17.039 47.368 L9 47.368 L9 36 Z M35.067 36 L46.435 24.632 L54.474 24.632 L54.474 36 L51.144 36 L39.776 47.368 L31.737 47.368 L31.737 36 Z M54.474 47.368 L54.474 36 L63 36 L63 47.368 Z"/></svg>';
