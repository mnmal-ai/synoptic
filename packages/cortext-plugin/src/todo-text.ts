// Text and ordering the Todos pane uses. No engine imports, so vitest covers it in CI.

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

/**
 * Text folded into at most `max` lines of `width` characters, breaking at spaces where it can;
 * the last line ends in an ellipsis when text is left over.
 */
export function wrapLines(text: string, width: number, max: number): string[] {
  const w = Math.max(4, Math.floor(width));
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  let i = 0;
  while (i < words.length && lines.length < max) {
    const word = words[i] ?? '';
    const next = line ? `${line} ${word}` : word;
    if (next.length <= w) {
      line = next;
      i++;
    } else if (!line) {
      // A word wider than the line is split.
      lines.push(word.slice(0, w));
      words[i] = word.slice(w);
    } else {
      lines.push(line);
      line = '';
    }
  }
  if (line && lines.length < max) lines.push(line);
  if (i < words.length && lines.length > 0) {
    const last = lines[lines.length - 1] ?? '';
    lines[lines.length - 1] = `${last.slice(0, w - 1).trimEnd()}…`;
  }
  return lines;
}
