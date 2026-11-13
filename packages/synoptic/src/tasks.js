// Active Tasks for cold-start: the project's `status = active` cortext/Task
// rows, each with its latest cortext/ExecutionCheckpoint (highest revision),
// so a fresh session resumes from `nextAction` instead of a transcript.
// Strictly project-scoped (no `project = null` branch): a Task is work in one
// repo, and a cross-cutting one would surface in every repo's cold-start.

import { substrateFetch } from '@mnmal-ai/substrate/client';
import { sanitizeText } from './inbox-push.js';
import { substrateQuery } from './substrate-http.js';

/** Tasks shown; a full page renders as "10+". */
export const TASK_LIMIT = 10;

/** Longest `nextAction` / title rendered, in characters. */
const TEXT_MAX = 200;

/** Refs shown per checkpoint; the rest are a read away. */
const REFS_MAX = 3;

/**
 * @returns {Promise<Array<{ task: object, checkpoint: object|null }>|null>}
 *   null when there is no project to scope by, or the server has no Task type
 *   (a runtime older than the cortext that declares it). Throws on transport
 *   failure; the caller degrades visibly.
 */
export async function loadActiveTasks({
  substrateUrl,
  namespace = 'cortext',
  projectSlug,
  fetchImpl = substrateFetch
}) {
  if (!projectSlug) return null;
  const taskKey = `${namespace}/Task`;
  const data = await substrateQuery(
    substrateUrl,
    {
      [taskKey]: {
        params: {
          where: {
            project: { eq: projectSlug },
            status: { eq: 'active' },
            archived: { eq: false }
          },
          orderBy: [{ updatedAt: 'desc' }],
          limit: TASK_LIMIT
        },
        fields: { id: true, shortId: true, title: true }
      }
    },
    { fetchImpl }
  );
  if (!(taskKey in data)) return null;

  // One read per task: `in` is not an operator a crossRef accepts, and a
  // shared read ordered by revision would let one long task crowd out the rest.
  const cpKey = `${namespace}/ExecutionCheckpoint`;
  return Promise.all(
    data[taskKey].map(async (task) => {
      const cp = await substrateQuery(
        substrateUrl,
        {
          [cpKey]: {
            params: {
              where: { task: { eq: task.id } },
              orderBy: [{ revision: 'desc' }],
              limit: 1
            },
            fields: { revision: true, nextAction: true, blockers: true, refs: true }
          }
        },
        { fetchImpl }
      );
      return { task, checkpoint: (cp[cpKey] ?? [])[0] ?? null };
    })
  );
}

/** One line, bounded: control characters and line separators become spaces,
 *  so store text cannot start a new block or pose as a header. */
function oneLine(text) {
  const flat = String(sanitizeText(String(text ?? '')))
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat;
}

/**
 * The active Tasks as a short block: one line per task with its latest step.
 * Empty or null → ''.
 */
export function renderTasks(entries, { ns = 'cortext' } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const count = entries.length >= TASK_LIMIT ? `${entries.length}+` : String(entries.length);
  const lines = entries.map(({ task, checkpoint }) => {
    const head = `- #${Number(task.shortId)} ${oneLine(task.title)} (\`${oneLine(task.id).replaceAll('`', '')}\`)`;
    if (checkpoint === null) return `${head} — no checkpoint yet`;
    const blocked = checkpoint.blockers ? `; blocked: ${oneLine(checkpoint.blockers)}` : '';
    const refs = Array.isArray(checkpoint.refs) ? checkpoint.refs : [];
    const shown = refs.slice(0, REFS_MAX).map(oneLine).join(', ');
    const more = refs.length > REFS_MAX ? ', …' : '';
    const refsPart = shown ? `; refs: ${shown}${more}` : '';
    return `${head} — rev ${Number(checkpoint.revision)}, next: ${oneLine(checkpoint.nextAction)}${blocked}${refsPart}`;
  });
  return [
    `Active tasks: ${count} — resume from \`next\`. After each acknowledged step, write \`${ns}/createExecutionCheckpoint { task, revision, completed, nextAction }\` with revision one above the latest.`,
    ...lines
  ].join('\n');
}
