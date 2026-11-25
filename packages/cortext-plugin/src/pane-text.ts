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

/** `HH:MM` in the host's local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The dim transcript line for mail that arrived: number, sender, time, subject. */
export function mailReceivedLine(
  m: { shortId: number; from: string; subject: string; createdAt: string; urgent?: boolean },
  _now?: number
): string {
  const at = Date.parse(m.createdAt);
  const when = Number.isNaN(at) ? '' : ` · ${clockTime(at)}`;
  return `Mail received #${m.shortId}${m.urgent ? ' (urgent)' : ''} · from ${oneLine(m.from)}${when} · ${cut(oneLine(m.subject), 90)}`;
}

/**
 * The dim transcript line for a mailbox call this session made through the substrate MCP
 * server, or undefined when the call is not one. Reads the `act` sketch or the `mutate` frame.
 */
export function mailCallLine(
  tool: string,
  input: Record<string, unknown>,
  now: number
): string | undefined {
  const at = clockTime(now);
  if (/__act$/.test(tool) && typeof input.sketch === 'string') {
    const sketch = input.sketch.trim();
    const send = /^send\s+AgentMessage\b/i.test(sketch);
    if (send) {
      const to = /\bto=("[^"]*"|\S+)/.exec(sketch)?.[1]?.replace(/"/g, '') ?? 'someone';
      const subject = /\bsubject="([^"]*)"/.exec(sketch)?.[1] ?? '';
      return `Mail sent · to ${oneLine(to)} · ${at}${subject ? ` · ${cut(oneLine(subject), 90)}` : ''}`;
    }
    const closed = /^(ack|read)\s+AgentMessage\s+([#\d,\s]+)/i.exec(sketch);
    if (closed) {
      const verb = closed[1]?.toLowerCase() === 'ack' ? 'acked' : 'marked read';
      return `Mail ${verb} · ${closed[2]?.trim()} · ${at}`;
    }
    return undefined;
  }
  if (/__mutate$/.test(tool) && input.payload && typeof input.payload === 'object') {
    for (const [key, frame] of Object.entries(input.payload as Record<string, unknown>)) {
      const params = (frame as { params?: Record<string, unknown> } | null)?.params ?? {};
      if (key.endsWith('/sendAgentMessage')) {
        const to = Array.isArray(params.to) ? params.to.join(', ') : String(params.to ?? 'someone');
        const subject = typeof params.subject === 'string' ? params.subject : '';
        return `Mail sent · to ${oneLine(to)} · ${at}${subject ? ` · ${cut(oneLine(subject), 90)}` : ''}`;
      }
      if (key.endsWith('/ackAgentMessage')) return `Mail acked · ${at}`;
      if (key.endsWith('/markAgentMessageRead')) return `Mail marked read · ${at}`;
    }
  }
  return undefined;
}

function oneLine(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    out += c < 32 || c === 127 || (c >= 128 && c <= 159) || c === 8232 || c === 8233 ? ' ' : ch;
  }
  return out.trim();
}

export type TodoSort = 'priority' | 'created' | 'updated' | 'status' | 'title';
export type TodoView = { sort: TodoSort; status: string; priority: string; search: string };
type Sortable = {
  shortId: number;
  title: string;
  status: string;
  priority: string;
  createdAt?: string;
  updatedAt?: string;
};

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const STATUS_RANK: Record<string, number> = { blocked: 0, in_progress: 1, open: 2, deferred: 3 };

/** The list as the pane shows it: filtered by status, priority and a title search, then sorted. */
export function viewTodos<T extends Sortable>(rows: readonly T[], view: TodoView): T[] {
  const needle = view.search.trim().toLowerCase();
  const kept = rows.filter(
    (t) =>
      (view.status === 'any' || t.status === view.status) &&
      (view.priority === 'any' || t.priority === view.priority) &&
      (needle === '' || t.title.toLowerCase().includes(needle) || `#${t.shortId}`.includes(needle))
  );
  const time = (iso?: string): number => (iso ? Date.parse(iso) || 0 : 0);
  const byPriority = (a: T, b: T): number =>
    (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
  const newest = (a: T, b: T): number => b.shortId - a.shortId;
  const order: Record<TodoSort, (a: T, b: T) => number> = {
    priority: (a, b) => byPriority(a, b) || newest(a, b),
    created: (a, b) => time(b.createdAt) - time(a.createdAt) || newest(a, b),
    updated: (a, b) => time(b.updatedAt) - time(a.updatedAt) || newest(a, b),
    status: (a, b) =>
      (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
      byPriority(a, b) ||
      newest(a, b),
    title: (a, b) => a.title.localeCompare(b.title)
  };
  return [...kept].sort(order[view.sort]);
}

/** "3m ago", "5h ago", "2d ago". */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
