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
  tags?: string[] | null;
  status: string;
  priority: string;
  createdAt?: string;
  updatedAt?: string;
};

/** The Todo type's own value lists, as the server's schema states them. */
export type TodoVocab = { status: readonly string[]; priority: readonly string[] };

/** What the pane uses until the server's schema has been read. */
export const FALLBACK_VOCAB: TodoVocab = {
  status: ['open', 'in_progress', 'blocked', 'deferred', 'closed'],
  priority: ['low', 'medium', 'high']
};

/** Reads status and priority values from a `schema` answer for the Todo type, or undefined. */
export function vocabFromSchema(answer: unknown): TodoVocab | undefined {
  const fields = (answer as { fields?: Record<string, { enum?: unknown }> } | null)?.fields;
  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')
      ? (v as string[])
      : undefined;
  const status = list(fields?.status?.enum);
  const priority = list(fields?.priority?.enum);
  return status && priority ? { status, priority } : undefined;
}

/** `in_progress` → `In progress`. */
export function humanize(value: string): string {
  const words = value.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The list as the pane shows it: filtered by status, priority and a search, then sorted. */
export function viewTodos<T extends Sortable>(
  rows: readonly T[],
  view: TodoView,
  vocab: TodoVocab = FALLBACK_VOCAB
): T[] {
  const needle = view.search.trim().toLowerCase();
  const kept = rows.filter(
    (t) =>
      (view.status === 'any' || t.status === view.status) &&
      (view.priority === 'any' || t.priority === view.priority) &&
      (needle === '' ||
        t.title.toLowerCase().includes(needle) ||
        `#${t.shortId}`.includes(needle) ||
        (t.tags ?? []).some((g) => g.toLowerCase().includes(needle)))
  );
  // The schema lists priority low to high; the list leads with the highest.
  const pRank = (v: string): number => {
    const i = vocab.priority.indexOf(v);
    return i < 0 ? 99 : vocab.priority.length - i;
  };
  const sRank = (v: string): number => {
    const i = vocab.status.indexOf(v);
    return i < 0 ? 99 : i;
  };
  const time = (iso?: string): number => (iso ? Date.parse(iso) || 0 : 0);
  const byPriority = (a: T, b: T): number => pRank(a.priority) - pRank(b.priority);
  const newest = (a: T, b: T): number => b.shortId - a.shortId;
  const order: Record<TodoSort, (a: T, b: T) => number> = {
    priority: (a, b) => byPriority(a, b) || newest(a, b),
    created: (a, b) => time(b.createdAt) - time(a.createdAt) || newest(a, b),
    updated: (a, b) => time(b.updatedAt) - time(a.updatedAt) || newest(a, b),
    status: (a, b) => sRank(a.status) - sRank(b.status) || byPriority(a, b) || newest(a, b),
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

export type Lane = { key: string; title: string; tone: string };

const LANE_TONES: Record<string, string> = {
  open: 'suggestion',
  in_progress: 'success',
  blocked: 'error',
  deferred: 'subtle',
  closed: 'subtle'
};

/** One board lane per status the schema lists, in its order, each keeping the list's order. */
export function laneRows<T extends { status: string }>(
  rows: readonly T[],
  statuses: readonly string[] = FALLBACK_VOCAB.status
): { lane: Lane; rows: T[] }[] {
  return statuses.map((s) => ({
    lane: { key: s, title: humanize(s), tone: LANE_TONES[s] ?? 'text' },
    rows: rows.filter((r) => r.status === s)
  }));
}

/** A pushed mail row, read back from the text `renderPushRow` wrote. */
export type MailRow = {
  shortId: number;
  id: string | undefined;
  from: string;
  date: string;
  subject: string;
  isReply: boolean;
  body: string;
  /** The sender's `session:<8 hex>`, as it claimed it; the key does not prove it. */
  instance: string | undefined;
};

/** Reads a pushed mail row's text; undefined when the text is not one. */
export function parseMailRow(text: string): MailRow | undefined {
  const head =
    /^\[[\w.-]+ inbox · new mail #(\d+) · signed by (.+?)(?: · (\d{4}-\d{2}-\d{2}))? — a message from another agent/.exec(
      text
    );
  if (!head) return undefined;
  const lines = text.split('\n');
  const titleAt = lines.findIndex((l) => /^### #\d+ — /.test(l));
  const title = titleAt < 0 ? '' : (lines[titleAt] ?? '').replace(/^### #\d+ — /, '');
  const isReply = title.endsWith(' (reply)');
  const body: string[] = [];
  for (const l of titleAt < 0 ? [] : lines.slice(titleAt + 1)) {
    if (l.startsWith('> ') || l === '>') body.push(l.slice(2));
    else if (body.length > 0) break;
  }
  return {
    shortId: Number(head[1]),
    id: /ackAgentMessage \{ id: "([^"]+)" \}/.exec(text)?.[1],
    from: oneLine(head[2] ?? ''),
    date: head[3] ?? '',
    subject: oneLine(isReply ? title.slice(0, -' (reply)'.length) : title),
    isReply,
    body: body.join('\n'),
    instance: /\binstance (session:[0-9a-f]{8})\b/i.exec(text)?.[1]
  };
}

/** A mail this session sends: who to, the subject and the body, read from the tool's input. */
export type MailSend = { to: string; subject: string; body: string };

/** The send in a substrate `act` sketch or `mutate` frame; undefined when the call sends none. */
export function parseMailSend(tool: string, input: unknown): MailSend | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  if (/__act$/.test(tool) && typeof i.sketch === 'string') {
    const sketch = i.sketch.trim();
    if (!/^send\s+AgentMessage\b/i.test(sketch)) return undefined;
    const arg = (k: string): string => {
      const m = new RegExp(`\\b${k}=("((?:[^"\\\\]|\\\\.)*)"|\\S+)`).exec(sketch);
      if (!m) return '';
      return m[2] !== undefined ? m[2].replace(/\\n/g, '\n').replace(/\\(.)/g, '$1') : (m[1] ?? '');
    };
    return { to: arg('to') || 'someone', subject: arg('subject'), body: arg('body') };
  }
  if (/__mutate$/.test(tool) && i.payload && typeof i.payload === 'object') {
    for (const [key, frame] of Object.entries(i.payload as Record<string, unknown>)) {
      if (!key.endsWith('/sendAgentMessage')) continue;
      const f = Array.isArray(frame) ? frame[0] : frame;
      const params = (f as { params?: Record<string, unknown> } | null)?.params ?? {};
      return {
        to: Array.isArray(params.to) ? params.to.join(', ') : String(params.to ?? 'someone'),
        subject: typeof params.subject === 'string' ? params.subject : '',
        body: typeof params.body === 'string' ? params.body : ''
      };
    }
  }
  return undefined;
}

/** A mail feed event's text: subject, a blank line, then the body. */
export function mailFeedText(subject: string, body: string): string {
  return body ? `${subject}\n\n${body}` : subject;
}

/** Reads a mail feed event's text back into its subject and body. */
export function splitMailFeedText(text: string): { subject: string; body: string } {
  const at = text.indexOf('\n\n');
  return at < 0
    ? { subject: text, body: '' }
    : { subject: text.slice(0, at), body: text.slice(at + 2) };
}

/** A remote turn's prompt, read back from the text `remoteTurnText` wrote; undefined otherwise. */
export function parseRemoteTurn(text: string): { from: string; text: string } | undefined {
  const m = /^\[Remote turn from (\S+), sent from a cortext Remote session pane\.[^\]]*\]\n\n/.exec(
    text
  );
  return m ? { from: m[1] ?? '', text: text.slice(m[0].length) } : undefined;
}
