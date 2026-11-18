// Compaction into Substrate. At compaction the skin builds a checkpoint from
// the messages being compacted away (the tool calls made, each with a
// one-line result, and the model's last note), writes it as the next
// ExecutionCheckpoint of the session's Task, and hands OMP a short pointer in
// place of a model-written summary. Built mechanically, so it cannot invent a
// goal or emit a stray tool call, which small models do when summarising.
// Anything short of an acknowledged write leaves OMP's own compaction to run.

import { substrateMutate, substrateQuery } from '../../synoptic/src/substrate-http.js';

export type Checkpoint = { completed: string; nextAction: string };

/** The parts of an OMP message this module reads. */
export type Message = {
  role?: string;
  content?: unknown;
  toolName?: string;
  isError?: boolean;
};

/** The parts of an OMP session entry this module reads. */
export type Entry = { type: string; message?: Message };

/** Steps listed in a checkpoint; earlier ones are counted, not listed. */
const STEPS_MAX = 30;
const LINE_MAX = 160;
const NOTE_MAX = 600;
const REQUEST_MAX = 2000;

export const NEXT_ACTION =
  'Carry on with the request from where the steps above leave off; do not redo a step listed there.';

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c?.type === 'text' ? String(c.text ?? '') : ''))
    .filter((t) => t.trim() !== '')
    .join('\n');
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '') ?? '';
}

/** The newest user request on the branch, compacted away or not. */
export function lastRequest(entries: Entry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = (entries[i] as Entry).message;
    if ((entries[i] as Entry).type !== 'message' || m?.role !== 'user') continue;
    const text = textOf(m.content);
    if (text.trim()) return clip(text, REQUEST_MAX);
  }
  return null;
}

/** The checkpoint for `messages`, or null when they hold no step or note. */
export function buildCheckpoint(messages: Message[]): Checkpoint | null {
  const steps: string[] = [];
  const pending = new Map<string, number>();
  let note = '';
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c?.type !== 'toolCall') continue;
        pending.set(String(c.id), steps.length);
        steps.push(clip(`${c.name}(${JSON.stringify(c.arguments ?? {})})`, LINE_MAX));
      }
      const text = textOf(m.content);
      if (text.trim()) note = text;
    } else if (m.role === 'toolResult') {
      const at = pending.get(String((m as { toolCallId?: unknown }).toolCallId));
      if (at === undefined) continue;
      const result = clip(firstLine(textOf(m.content)), LINE_MAX);
      steps[at] = `${steps[at]} → ${m.isError ? 'error: ' : ''}${result || '(no output)'}`;
    }
  }
  if (steps.length === 0 && !note.trim()) return null;
  const shown = steps.slice(-STEPS_MAX);
  const lines = [
    ...(steps.length > shown.length ? [`(${steps.length - shown.length} earlier steps)`] : []),
    ...shown.map((s) => `- ${s}`),
    ...(note.trim() ? [`Last note: ${clip(note, NOTE_MAX)}`] : [])
  ];
  return { completed: lines.join('\n'), nextAction: NEXT_ACTION };
}

export type TaskRef = { id: string; shortId: number; title: string };

type Access = {
  substrateUrl: string;
  namespace: string;
  project: string | null;
  fetchImpl: typeof fetch;
};

async function createTask(a: Access, title: string): Promise<TaskRef | null> {
  const key = `${a.namespace}/createTask`;
  const data = await substrateMutate(
    a.substrateUrl,
    {
      [key]: {
        params: { title, project: a.project },
        fields: { id: true, shortId: true, title: true }
      }
    },
    { fetchImpl: a.fetchImpl }
  );
  const row = data[key] as TaskRef | undefined;
  return row?.id ? row : null;
}

async function latestRevision(a: Access, task: string): Promise<number | null> {
  const key = `${a.namespace}/ExecutionCheckpoint`;
  const data = await substrateQuery(
    a.substrateUrl,
    {
      [key]: {
        params: { where: { task: { eq: task } }, orderBy: [{ revision: 'desc' }], limit: 1 },
        fields: { revision: true }
      }
    },
    { fetchImpl: a.fetchImpl }
  );
  if (!Object.hasOwn(data, key)) return null;
  return Number((data[key] as Array<{ revision: number }>)[0]?.revision ?? 0);
}

/** Writes `cp` one revision above the latest; null unless acknowledged. A
 *  unique_violation (another writer advanced the task) re-reads once. */
async function writeRevision(a: Access, task: string, cp: Checkpoint): Promise<number | null> {
  const key = `${a.namespace}/createExecutionCheckpoint`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await latestRevision(a, task);
    if (latest === null) return null;
    const revision = latest + 1;
    let raced = false;
    const data = await substrateMutate(
      a.substrateUrl,
      {
        [key]: {
          params: {
            task,
            revision,
            completed: cp.completed,
            nextAction: cp.nextAction,
            project: a.project
          },
          fields: { id: true }
        }
      },
      {
        fetchImpl: a.fetchImpl,
        onFrameFailure: (_k: string, detail: string) => {
          if (/^unique_violation\b/.test(detail)) raced = true;
        }
      }
    );
    if (Object.hasOwn(data, key)) return revision;
    if (!raced) return null;
  }
  return null;
}

/** Saves `cp` under `task` (creating the Task when null). Null on any refusal. */
export async function saveCheckpoint(
  a: Access,
  task: TaskRef | null,
  cp: Checkpoint,
  title: string
): Promise<{ task: TaskRef; revision: number } | null> {
  const t = task ?? (await createTask(a, title));
  if (t === null) return null;
  const revision = await writeRevision(a, t.id, cp);
  return revision === null ? null : { task: t, revision };
}

/** What replaces the compacted history. */
export function renderPointer(
  task: TaskRef,
  revision: number,
  request: string | null,
  cp: Checkpoint
): string {
  const earlier = revision > 1 ? `; revisions 1–${revision - 1} hold earlier ones` : '';
  return [
    '[Context compacted into Substrate by the cortext extension. This is NOT a message from the user.]',
    ...(request ? [`Request: ${request}`] : []),
    `Steps compacted away (Task #${task.shortId}, checkpoint revision ${revision}${earlier}):`,
    cp.completed,
    `Next: ${cp.nextAction}`
  ].join('\n');
}
