/**
 * Infer why a closed Todo stopped, for the one-off `resolution` backfill.
 *
 * Closure statements LEAD with the outcome ("DONE via PR #12", "Superseded by
 * #34", "[FIXED + VERIFIED LIVE]"), while the prose after them mentions
 * every other word in passing: a note that shipped a fix can still say
 * "dropped", "stale" or "duplicate" two paragraphs down. So the cue that
 * appears EARLIEST in the title plus the opening of the notes wins, and a
 * cue buried deeper counts for nothing. No cue -> `unspecified`, never a guess.
 */

import type { TODO_RESOLUTION_VOCAB } from './kernel/index.js';

export type TodoResolution = (typeof TODO_RESOLUTION_VOCAB)[number];

/** How much of the notes / body opening is read for a closure cue. */
const OPENING = 240;

const CUES: ReadonlyArray<readonly [TodoResolution, RegExp]> = [
  ['duplicate', /\b(duplicate of|dup(?:e)? of|duplicates #|same (?:defect|bug|issue) as #)/i],
  [
    'superseded',
    /\b(superseded|folded into|replaced by|subsumed (?:by|into)|rolled into|merged into #)/i
  ],
  [
    'obsolete',
    /\b(obsolete|moot|no longer (?:relevant|needed|applies|an issue)|overtaken by events|as stale\b|already fixed)/i
  ],
  [
    'wont_do',
    /\b(won'?t[ -](?:do|fix)|wontfix|not (?:needed|worth (?:it|doing))|declined|cancell?ed|abandoned|not doing|invalid|not[ -]a[ -]bug)\b/i
  ],
  [
    'completed',
    /\b(done|merged|shipped|landed|released|fixed|implemented|deployed|resolved|verified live|complete|completed|delivered|(?:by|via|in) PR #?\d+)\b/i
  ]
];

export interface ClosedTodoText {
  title?: string | null;
  notes?: string | null;
  body?: string | null;
}

export function inferTodoResolution(todo: ClosedTodoText): TodoResolution {
  const opening = (t: string | null | undefined) =>
    typeof t === 'string' ? t.slice(0, OPENING) : '';
  // A title describes the PROBLEM ("A declined source falls through..."); only
  // a leading [VERDICT] bracket on it is a closure statement.
  const verdict = /^\s*\[([^\]]*)\]/.exec(todo.title ?? '')?.[1] ?? '';
  const text = [verdict, opening(todo.notes), opening(todo.body)].join('\n');
  let best: { at: number; resolution: TodoResolution } | null = null;
  for (const [resolution, cue] of CUES) {
    const m = cue.exec(text);
    // Ties go to the earlier (more specific) class in CUES.
    if (m !== null && (best === null || m.index < best.at)) best = { at: m.index, resolution };
  }
  return best?.resolution ?? 'unspecified';
}
