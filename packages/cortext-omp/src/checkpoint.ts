// Compaction into Substrate. The model states its work as a fenced
// ```checkpoint block; at compaction the skin writes that as the next
// ExecutionCheckpoint of the session's Task and hands OMP a short pointer to it
// in place of a transcript summary. Anything short of an acknowledged write
// leaves OMP's own compaction to run, so no state is dropped unsaved.

import { substrateMutate, substrateQuery } from '../../synoptic/src/substrate-http.js';

export type Checkpoint = {
  task: string | null;
  completed: string;
  nextAction: string;
  blockers: string | null;
  refs: string[];
};

/** The parts of an OMP session entry this module reads. */
export type Entry = {
  type: string;
  id?: string;
  message?: { role?: string; content?: unknown };
};

export const CHECKPOINT_REQUEST = [
  '[Automated context check by the cortext extension. This is NOT a message from the user.]',
  'Context is filling up and will be compacted soon. Reply now with only your work state, as one fenced block:',
  '```checkpoint',
  '{"task": "<short title of the overall task>", "completed": "<what is done so far>", "nextAction": "<the very next step>", "blockers": null, "refs": ["<file path or #id you will need again>"]}',
  '```',
  'It replaces this conversation after compaction, so make nextAction and refs enough to carry on.'
].join('\n');

const FENCE = /```checkpoint\s*\n([\s\S]*?)\n?```/g;

/** Longest field kept, in characters: the pointer rides in every request. */
const FIELD_MAX = 2000;
const REFS_MAX = 20;

function clip(s: string): string {
  const t = s.trim();
  return t.length > FIELD_MAX ? `${t.slice(0, FIELD_MAX - 1)}…` : t;
}

/** The last valid checkpoint block in `text`, or null. */
export function parseCheckpoint(text: string): Checkpoint | null {
  let found: Checkpoint | null = null;
  for (const m of text.matchAll(FENCE)) {
    try {
      const raw = JSON.parse(m[1] as string) as Record<string, unknown>;
      const { task, completed, nextAction, blockers, refs } = raw;
      if (typeof completed !== 'string' || !completed.trim()) continue;
      if (typeof nextAction !== 'string' || !nextAction.trim()) continue;
      found = {
        task: typeof task === 'string' && task.trim() ? clip(task) : null,
        completed: clip(completed),
        nextAction: clip(nextAction),
        blockers: typeof blockers === 'string' && blockers.trim() ? clip(blockers) : null,
        refs: Array.isArray(refs)
          ? refs
              .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
              .slice(0, REFS_MAX)
              .map(clip)
          : []
      };
    } catch {
      /* not JSON: a small model's near miss; an earlier block may still stand */
    }
  }
  return found;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) =>
      c && typeof c === 'object' && (c as { type?: unknown }).type === 'text'
        ? String((c as { text?: unknown }).text ?? '')
        : ''
    )
    .join('\n');
}

/** The newest checkpoint an assistant message stated since the last
 *  compaction, with the index of that message in `entries`. */
export function findCheckpoint(entries: Entry[]): { cp: Checkpoint; at: number } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as Entry;
    if (e.type === 'compaction') return null;
    if (e.type !== 'message' || e.message?.role !== 'assistant') continue;
    const cp = parseCheckpoint(textOf(e.message.content));
    if (cp !== null) return { cp, at: i };
  }
  return null;
}

/**
 * Where the kept history starts under a checkpoint stated at `at`: OMP's own
 * cut when the block lies inside the kept tail, otherwise the entry after the
 * block, so turns the checkpoint does not cover are kept rather than dropped
 * unsummarised. Null when the block is the last entry before an earlier cut.
 */
export function keepFrom(entries: Entry[], at: number, ompCut: string): string | null {
  const cut = entries.findIndex((e) => e.id === ompCut);
  if (cut >= 0 && cut <= at) return ompCut;
  return entries[at + 1]?.id ?? null;
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
            blockers: cp.blockers,
            refs: cp.refs,
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
  fallbackTitle: string
): Promise<{ task: TaskRef; revision: number } | null> {
  const t = task ?? (await createTask(a, cp.task ?? fallbackTitle));
  if (t === null) return null;
  const revision = await writeRevision(a, t.id, cp);
  return revision === null ? null : { task: t, revision };
}

/** What replaces the compacted history. */
export function renderPointer(ns: string, task: TaskRef, revision: number, cp: Checkpoint): string {
  return [
    '[Context compacted into Substrate by the cortext extension. Earlier turns are saved there, not here.]',
    `Task #${task.shortId} "${task.title}" (\`${task.id}\`), checkpoint revision ${revision}.`,
    `Completed: ${cp.completed}`,
    `Next: ${cp.nextAction}`,
    ...(cp.blockers ? [`Blockers: ${cp.blockers}`] : []),
    ...(cp.refs.length > 0 ? [`Refs: ${cp.refs.join(', ')}`] : []),
    'Read a ref again only when the next step needs it.',
    `After each further step, write ${ns}/createExecutionCheckpoint { task: "${task.id}", revision: ${revision + 1}, completed, nextAction }.`
  ].join('\n');
}
