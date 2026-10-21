// Rule tiering and rendering: binding rules in full, pinned and the most
// relevant advisory rules in full, every other rule as one skim line.
//
// Moved from synoptic's AgentRule renderer so other renderers that
// deliver rules in the same shape cannot drift from it.
// What a rule IS stays with the caller: which store it lives in, how it is
// ranked, what its reference looks like and where its full text can be
// fetched. Callers map their rows to entries and pass their own wording as
// labels; this file only sorts entries into tiers and lays them out.
//
// A rule entry:
//
//   ref       how the rule is cited, rendered bold: '#54', 'L41-120'.
//   severity  'must' is binding. Anything else, including absent, is advisory.
//   pinned    true renders the rule in full whatever its score.
//   category  groups full rules; null renders as 'uncategorised'.
//   body      the full rule text.
//   synopsis  the skim line's text.
//   note      optional: one line indented under a full rule, e.g. where its
//             rationale can be fetched.
//   tokens    optional: the caller's token count, shown on the skim line.
//   score     optional: relevance, higher first. Ranking is the caller's —
//             this file never computes one.
//
// Never-omit is the invariant: every entry lands in exactly one tier, so the
// worst a low score can do is summarise a rule, never drop it.

/**
 * @typedef {object} RuleEntry
 * @property {string} ref
 * @property {string|null} [severity]
 * @property {boolean} [pinned]
 * @property {string|null} [category]
 * @property {string} body
 * @property {string} synopsis
 * @property {string|null} [note]
 * @property {number|null} [tokens]
 * @property {number|null} [score]
 */

/**
 * @typedef {object} RuleTiers
 * @property {RuleEntry[]} must     every binding rule. Never ranked.
 * @property {RuleEntry[]} pinned   advisory rules marked pinned, input order.
 * @property {RuleEntry[]} salient  the top `topK` unpinned advisory rules.
 * @property {RuleEntry[]} skim     the remaining advisory rules.
 */

import { flattenHeadings } from './fold.js';

/**
 * Sort entries into tiers. Unpinned advisory rules are ordered by `score`,
 * highest first; equal or absent scores keep their input order, so a caller
 * that has already ranked can pass entries in order and omit scores.
 *
 * @param {ReadonlyArray<RuleEntry>} entries
 * @param {{ topK?: number }} [opts]
 * @returns {RuleTiers}
 */
export function tierRules(entries, { topK = 5 } = {}) {
  const must = [];
  const pinned = [];
  const ranked = [];
  for (const e of entries) {
    if (e.severity === 'must') must.push(e);
    else if (e.pinned === true) pinned.push(e);
    else ranked.push(e);
  }
  /** @param {RuleEntry} e */
  const key = (e) => (typeof e.score === 'number' && !Number.isNaN(e.score) ? e.score : -Infinity);
  ranked.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka === kb ? 0 : kb > ka ? 1 : -1;
  });
  const k = Math.max(0, topK);
  return { must, pinned, salient: ranked.slice(0, k), skim: ranked.slice(k) };
}

/**
 * The full form of one rule, as lines.
 * @param {RuleEntry} e
 * @returns {string[]}
 */
export function renderRuleFull(e) {
  // A body line that starts `## X` would otherwise render as a real section
  // of the document, with nothing marking it as rule text.
  const out = [`- **${e.ref}** — ${flattenHeadings(e.body)}`];
  if (e.note) out.push(`  ${e.note}`);
  return out;
}

/**
 * The skim form of one rule, one line.
 * @param {RuleEntry} e
 * @returns {string}
 */
export function renderRuleSkim(e) {
  const cat = e.category ? ` *(${e.category})*` : '';
  const tok = typeof e.tokens === 'number' ? ` (${e.tokens} tok)` : '';
  return `- **${e.ref}**${cat}${tok} — ${flattenHeadings(e.synopsis)}`;
}

/**
 * Full rules grouped under one heading per category, as lines.
 *
 * Category order is a real decision in a long document — attention falls off
 * in the middle — so a caller can rank them with `categoryOrder`: listed
 * categories first in that order, unlisted ones after, alphabetically. With
 * no `categoryOrder`, categories sort by code point.
 *
 * @param {ReadonlyArray<RuleEntry>} entries
 * @param {object} [opts]
 * @param {string} [opts.level]                       heading prefix, e.g. '####'.
 * @param {ReadonlyArray<string>} [opts.categoryOrder]
 * @param {boolean} [opts.counts]                     append '(n)' to each heading.
 * @param {(a: RuleEntry, b: RuleEntry) => number} [opts.compare]  within a category; default input order.
 * @returns {string[]}
 */
export function renderRuleGroups(
  entries,
  { level = '####', categoryOrder, counts = false, compare } = {}
) {
  /** @type {Record<string, RuleEntry[]>} */
  const grouped = {};
  for (const e of entries) {
    const cat = e.category ?? 'uncategorised';
    grouped[cat] ??= [];
    grouped[cat].push(e);
  }
  let cats = Object.keys(grouped);
  if (categoryOrder) {
    /** @param {string} c */
    const rank = (c) => {
      const i = categoryOrder.indexOf(c);
      return i === -1 ? categoryOrder.length : i;
    };
    cats = cats.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  } else {
    cats = cats.sort();
  }
  const out = [];
  for (const cat of cats) {
    const inCat = compare ? [...grouped[cat]].sort(compare) : grouped[cat];
    out.push(counts ? `${level} ${cat} (${inCat.length})` : `${level} ${cat}`, '');
    for (const e of inCat) out.push(...renderRuleFull(e));
    out.push('');
  }
  return out;
}

/**
 * Render tiers as one markdown block: optional title and intro, then each
 * non-empty tier in the order must, pinned, salient, skim. A tier with a label
 * gets that label as its heading; one without renders its rules directly, which
 * suits a block holding a single tier. An empty tier renders nothing, heading
 * included — an empty heading presupposes content that is not there.
 *
 * @param {Partial<RuleTiers>} tiers
 * @param {object} [opts]
 * @param {string} [opts.title]                  e.g. '## Rules (3 pinned, 5 salient, 12 skim)'.
 * @param {ReadonlyArray<string>} [opts.intro]   paragraphs under the title.
 * @param {Partial<Record<keyof RuleTiers, string>>} [opts.labels]
 * @param {ReadonlyArray<keyof RuleTiers>} [opts.skimTiers]  tiers rendered as
 *   skim lines rather than full rules; default `['skim']`.
 * @param {string} [opts.level]                  category heading prefix.
 * @param {ReadonlyArray<string>} [opts.categoryOrder]
 * @param {boolean} [opts.counts]
 * @param {(a: RuleEntry, b: RuleEntry) => number} [opts.compare]
 * @returns {string}
 */
export function renderRuleTiers(
  tiers,
  { title, intro = [], labels = {}, skimTiers = ['skim'], ...groupOpts } = {}
) {
  const lines = [];
  if (title) lines.push(title, '');
  for (const p of intro) lines.push(p, '');
  for (const tier of /** @type {const} */ (['must', 'pinned', 'salient', 'skim'])) {
    const set = tiers[tier] ?? [];
    if (set.length === 0) continue;
    if (labels[tier]) lines.push(labels[tier], '');
    if (skimTiers.includes(tier)) {
      for (const e of set) lines.push(renderRuleSkim(e));
      lines.push('');
    } else {
      lines.push(...renderRuleGroups(set, groupOpts));
    }
  }
  return lines.join('\n');
}
