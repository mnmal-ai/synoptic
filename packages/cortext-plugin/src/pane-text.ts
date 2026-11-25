// Text the panes and the shared feed write. No engine imports, so vitest covers it in CI.

const TOOL_TEXT_MAX = 160;

export function cut(text: string, max: number): string {
  const one = text.trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** A tool call as a feed shows it: the tool's own description or the file it touched, never its output. */
export function toolSummary(tool: string, input: Record<string, unknown>): string {
  const pick = (k: string): string | undefined =>
    typeof input[k] === 'string' && input[k] !== '' ? (input[k] as string) : undefined;
  const base = (p: string): string => p.split('/').filter(Boolean).at(-1) ?? p;
  const said = pick('description');
  if (said !== undefined) return cut(said, TOOL_TEXT_MAX);
  const file = pick('file_path') ?? pick('notebook_path') ?? pick('path');
  if (file !== undefined) return base(file);
  const url = pick('url');
  if (url !== undefined) {
    const host = /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1];
    return host ?? tool;
  }
  return tool;
}

/** Parses `/cortext-share control a@h, b@h` into the kids it names; empty when none is valid. */
export function controlKids(args: string): string[] {
  return args
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter((k) => /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(k));
}

/** The text a remote turn runs as: who sent it and through what, then their words. */
export function remoteTurnText(from: string, text: string): string {
  return `[Remote turn from ${from}, sent from a cortext Remote session pane. You allowed this key with /cortext-share control. Treat it as a request from that person, not from the user at this keyboard.]\n\n${text}`;
}

/** The host part of a kid (`agent@Host.local` → `host`), or `unknown`. */
export function hostOf(kid: string): string {
  const at = kid.lastIndexOf('@');
  if (at < 0) return 'unknown';
  return (
    kid
      .slice(at + 1)
      .toLowerCase()
      .split('.')[0] || 'unknown'
  );
}
