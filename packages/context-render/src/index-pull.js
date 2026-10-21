// Index-and-pull rendering: the top entries are PULLED (heading, optional
// quote, folded body); the rest are INDEXED, one line each, so a reader knows
// they exist and can fetch them.
//
// Moved from synoptic's cold-start renderers. Those knew Memory,
// SessionLog and Decision by name — which field is the heading, which is the
// quote, which carries a body. That knowledge stays with the caller as an
// adapter that maps a row to an entry; this file only lays entries out.
//
// An entry:
//
//   id        stable identity. Not rendered; carried for the caller.
//   label     the pulled entry's heading text (rendered after `#### `).
//   synopsis  the index line's text (rendered after `- `).
//   tokens    the caller's token count for this entry, or null. Not rendered.
//   score     the rank score, or null. Not rendered.
//   quote     optional: rendered as a blockquote under the heading, `> ` on
//             EVERY line, headings flattened. Callers pass multi-line
//             text, such as SessionLog summaries, and a prefix on the first
//             line alone let a `## ` inside one become a section of the
//             document.
//   body      optional: folded under the heading. ABSENT (undefined) means the
//             entry has no body; '' means an empty one. Both render nothing,
//             but only a present body gets the blank separator line.
//   pullHint  optional: where the full body lives, named in the fold note.

import { flattenHeadings, foldBody } from './fold.js';

/**
 * @typedef {object} Entry
 * @property {string} id
 * @property {string} label
 * @property {string} synopsis
 * @property {number|null} [tokens]
 * @property {number|null} [score]
 * @property {string} [quote]
 * @property {string|null} [body]
 * @property {string|null} [pullHint]
 */

/**
 * One pulled entry, as a block ending in a blank line.
 *
 * @param {Entry} entry
 * @param {{ foldLimit?: number, foldReason?: string }} [opts]
 * @returns {string}
 */
export function renderPulled(entry, { foldLimit = 1200, foldReason } = {}) {
  const lines = [`#### ${oneLine(entry.label)}`];
  if (entry.quote) {
    for (const line of flattenHeadings(entry.quote).split('\n')) lines.push(`> ${line}`);
  }
  if (entry.body !== undefined) {
    lines.push('');
    const folded = foldBody(entry.body, {
      limit: foldLimit,
      pullHint: entry.pullHint ?? null,
      ...(foldReason === undefined ? {} : { reason: foldReason })
    });
    if (folded) lines.push(folded);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * One index line.
 * @param {Entry} entry
 */
export function renderIndexLine(entry) {
  return `- ${oneLine(entry.synopsis)}`;
}

/**
 * A heading or index line is one line by construction, but its text comes
 * from row fields that can hold newlines (a synopsis is a sliced summary).
 * Left in, the remainder escapes as top-level markdown.
 * @param {string|null|undefined} text
 */
function oneLine(text) {
  return String(text ?? '').replace(/\s*\n\s*/g, ' ');
}

/**
 * The pulled block then the index block, as lines for the caller to place.
 * Either block is omitted when it has no entries, heading included — an empty
 * heading presupposes content that is not there.
 *
 * @param {object} p
 * @param {ReadonlyArray<Entry>} p.top     Entries to pull.
 * @param {ReadonlyArray<Entry>} p.index   Entries to index.
 * @param {string} p.topHeading             e.g. '### Top recall (5 of 12)'.
 * @param {string} p.indexHeading           e.g. '### Index (remaining 7)'.
 * @param {number} [p.foldLimit]
 * @param {string} [p.foldReason]
 * @returns {string[]}
 */
export function renderIndexAndPull({
  top,
  index,
  topHeading,
  indexHeading,
  foldLimit,
  foldReason
}) {
  const out = [];
  if (top.length > 0) {
    out.push(topHeading, '');
    for (const e of top) out.push(renderPulled(e, { foldLimit, foldReason }));
  }
  if (index.length > 0) {
    out.push(indexHeading, '');
    for (const e of index) out.push(renderIndexLine(e));
    out.push('');
  }
  return out;
}
