// Small text helpers the panes share. No engine imports, so vitest covers them in CI.

export function cut(text: string, max: number): string {
  const one = text.trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** `HH:MM` in the host's local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
