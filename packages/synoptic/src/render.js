// Pure render functions for the synoptic cold-start hook.
// Input data → markdown string. No I/O, no env access.

export { renderConcepts } from './scoring/concepts.js';

import {
  renderIndexAndPull,
  renderRuleGroups,
  renderRuleTiers,
  tierRules
} from '@mnmal-ai/context-render';
import { describeRecallArms } from './recall-arms.js';
import { partitionByScore } from './scoring/memory-scorer.js';
import { rankRules } from './scoring/rule-salience.js';

// Character budget for one stored Memory body rendered in full.
//
// Measured before choosing it: the 20 full bodies in a live cold-start ran to
// 52,968 B — 54.1% of the whole payload, against 8,102 B for Inbox + Concepts +
// Open Work + Write contract combined. 1,200 holds the great majority of bodies
// whole (the median is far below it) while capping the long tail that was
// doing the crowding, and every cut announces itself.
const MEMORY_BODY_LIMIT = 1200;

// ---- What every Agent Memory section must disclose ----
//
// The section has two emitters, and `recallAvailable` upstream decides which
// one a session sees. A disclosure added to only one would never render on the
// path that runs BECAUSE recall was unavailable, and nothing exercised while
// the embedder is up would notice.
//
// So the rule lives HERE rather than in each renderer. A rule enforced at one
// choke point is a guarantee; the same rule repeated in every emitter is a
// convention the next emitter is free to omit.

// The types the unified path actually queries. Named in the empty notice so
// it says what was searched rather than implying the whole store.
const RECALL_SEARCHED = ['Memory', 'SessionLog', 'Decision'];

/** Mode lines for the states where no fusion ran. */
const STRUCTURAL_MODE = {
  // Recall was asked and could not answer.
  unavailable:
    'Mode: structural only (importance × recency) — semantic recall was unavailable, so no fusion ran.',
  // Nothing was asked: there was no anchor to search from. A different fact
  // from `unavailable`, and collapsing the two would read absent as false.
  'not-attempted':
    'Mode: structural only (importance × recency) — no anchor to search from, so semantic recall was not attempted.',
  // A caller that did not say. Rendered rather than omitted, so a future
  // emitter that forgets to pass the state is VISIBLE instead of silent.
  unknown:
    'Mode: structural only (importance × recency) — whether semantic recall ran was not recorded.'
};

/** `['a','b','c']` → `'a, b or c'`. */
function orList(types) {
  if (!Array.isArray(types) || types.length === 0) return 'Memory';
  if (types.length === 1) return types[0];
  return `${types.slice(0, -1).join(', ')} or ${types[types.length - 1]}`;
}

/**
 * The recall-state block every memory section carries: how the ranking was
 * produced, what the arms probe established, what the scope filter removed,
 * and — when nothing ranked — that the scope is empty rather than broken.
 *
 * Returns lines for the caller to place. Exported so the pairwise test can
 * assert that both emitters disclose the same facts about the same situation;
 * a per-emitter assertion cannot see a split.
 *
 * @param {object} p
 * @param {'fused'|'unavailable'|'not-attempted'|'unknown'} [p.recallState]
 * @param {{ evidence: string }} [p.arms]
 * @param {{ total: number, byProject: object }} [p.scopeDrops]
 * @param {number} p.k
 * @param {number} p.total      Rows ranked.
 * @param {string[]} p.searched Types actually queried, named in the empty notice.
 */
export function renderRecallState({
  recallState = 'unknown',
  arms = UNVERIFIED_ARMS,
  scopeDrops = NO_SCOPE_DROPS,
  k,
  total,
  searched
}) {
  const lines = [];
  if (recallState === 'fused') {
    const fusion = `Mode: RRF fusion, structural + semantic (k=${k})`;
    lines.push(
      total === 0
        ? `${fusion} — no rows to fuse | MEMORY_HYBRID=off to disable`
        : `${fusion} | MEMORY_HYBRID=off to disable`
    );
  } else {
    lines.push(STRUCTURAL_MODE[recallState] ?? STRUCTURAL_MODE.unknown);
  }
  // Configuration is a fact about the server whether or not a query ran, and
  // the evidence sentence disclaims that any arm answered — so this cannot
  // imply recall ran on a path where it did not.
  lines.push(`Recall arms: ${arms.evidence}`);
  if (scopeDrops.total > 0) {
    const by = Object.entries(scopeDrops.byProject)
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${p} ${n}`)
      .join(', ');
    lines.push(
      `Scope filter: dropped ${scopeDrops.total} semantic ${scopeDrops.total === 1 ? 'hit' : 'hits'} from other projects (${by}) — this server's recall/Hit refused the project filter (an older server), so this is applied client-side.`
    );
  }
  if (total === 0) {
    lines.push('');
    lines.push(
      `_No ${orList(searched)} rows in scope — nothing was ranked. Expected on a new project or a fresh store. The lines above describe how recall is configured, not a result it produced._`
    );
  }
  return lines;
}

// ---- Structural-only rendering (Increment 1 preserved) ----

/** Render Increment 1 structural-only output from fetched rows. Exported
 * for tests. */
export function renderStructural({
  rows,
  projectSlug,
  topK,
  halfLifeH,
  baseline,
  importanceWeights,
  ns,
  recallState = 'unknown',
  arms
}) {
  const { top, index } = partitionByScore(rows, Date.now(), {
    topK,
    halfLifeH,
    baseline,
    importanceWeights
  });
  const out = [];
  out.push(`## Agent Memory (from ${ns}/Memory — ${rows.length} total, ${top.length} top)`);
  out.push('');
  out.push(
    projectSlug === null
      ? `Project scope: **all projects** (SYNOPTIC_PROJECT_SCOPE=all).`
      : `Project scope: \`${projectSlug}\` + cross-cutting (project: null).`
  );
  // This branch renders BECAUSE recall did not fuse, so it must say so. Only Memory is queried here, so the empty
  // notice names only Memory.
  out.push(...renderRecallState({ recallState, arms, total: rows.length, searched: ['Memory'] }));
  out.push('');
  // Same fold as the hybrid path. The structural fallback renders when recall
  // is unavailable — a degraded server is when a bloated payload hurts most, so
  // it must not be the branch that skips the budget.
  out.push(
    ...renderIndexAndPull({
      top: top.map((r) => structuralEntry(r, ns)),
      index: index
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => structuralEntry(r, ns)),
      topHeading: '### Top recall (full bodies, scored by importance × recency)',
      indexHeading: `### Index (remaining — query \`${ns}/Memory\` by name to load body)`,
      foldLimit: MEMORY_BODY_LIMIT,
      foldReason: 'cold-start budget'
    })
  );
  out.push('');
  return out.join('\n');
}

/**
 * A structurally-scored Memory row as a context-render entry. The
 * formatting knowledge lives here: the shared renderer lays entries out and knows no cortext type.
 */
function structuralEntry(r, ns) {
  return {
    id: r.id,
    label: `${r.name}  \`${r.type}\``,
    synopsis: `**${r.name}** (\`${r.type}\`) — ${r.description?.slice(0, 120) ?? ''}`,
    tokens: null,
    score: null,
    ...(r.description ? { quote: r.description } : {}),
    body: r.body ?? '',
    pullHint: `\`${ns}/Memory\` \`${r.name}\``
  };
}

// ---- Unified hybrid rendering (I4) ----

function rankDisplay(r) {
  const sem =
    r.semanticRank === null || r.semanticRank === undefined ? '—' : String(r.semanticRank);
  // combinedRank is the global RRF-rank position; surfacing it lets the
  // reader spot floor-driven displacements (a #1-combined row in the Index
  // section means the min-floor reserved a slot for another type).
  const combined = r.combinedRank === undefined ? '—' : `#${r.combinedRank}`;
  return `[rank: combined ${combined}, struct ${r.structuralRank}, sem ${sem}]`;
}

function unifiedHeading(r) {
  const body = r.row.body ?? {};
  if (r.type === 'Memory') return `${body.name ?? r.row.id}  \`${body.type ?? '?'}\``;
  if (r.type === 'SessionLog') return `#${body.shortId ?? r.row.id}  branch=${body.branch ?? '?'}`;
  if (r.type === 'Decision')
    return `#${body.shortId ?? r.row.id}  topic="${body.topic ?? '?'}"  status=${body.status ?? '?'}`;
  return r.row.id;
}

/**
 * One RRF-ranked row as a context-render entry: the heading, quote,
 * body and index line each type renders. The shared renderer knows none of
 * these types; the per-type knowledge is all here.
 */
function unifiedEntry(r) {
  const body = r.row.body ?? {};
  const entry = {
    id: r.row.id,
    label: `${r.type}: ${unifiedHeading(r)}  ${rankDisplay(r)}`,
    synopsis: r.row.id,
    tokens: null,
    score: r.combined ?? null
  };
  if (r.type === 'Memory') {
    entry.synopsis = `${body.name ?? r.row.id} (\`${body.type ?? '?'}\`) — ${(body.description ?? '').slice(0, 120)}`;
    if (body.description) entry.quote = body.description;
    // Folded, not pushed verbatim: this was the uncapped branch, and the only
    // one of the three. See context-render's fold.js for the measurement.
    entry.body = body.body ?? '';
    const name = body.name ?? null;
    entry.pullHint = name === null ? '`cortext/Memory`' : `\`cortext/Memory\` \`${name}\``;
  } else if (r.type === 'SessionLog') {
    entry.synopsis = `SessionLog #${body.shortId ?? r.row.id} — ${(body.summary ?? '').slice(0, 120)}`;
    if (body.summary) {
      entry.quote = body.summary.length > 400 ? `${body.summary.slice(0, 400)}…` : body.summary;
    }
  } else if (r.type === 'Decision') {
    entry.synopsis = `Decision #${body.shortId ?? r.row.id} — ${(body.topic ?? '').slice(0, 120)}`;
    if (body.choice) entry.quote = body.choice;
  }
  return entry;
}

// The header when nobody established the arms. An omitted `arms` is
// the state this render was permanently in before the probe was wired, so the
// default has to be the modest claim, not the flattering one.
const UNVERIFIED_ARMS = describeRecallArms({ stats: null, namespace: '', types: [] });

const NO_SCOPE_DROPS = { total: 0, unknown: 0, byProject: {} };

/**
 * How the ranked set divides between this project and the fleet-wide rows.
 * Returns '' when there is no project to divide against.
 *
 * A single number would render a project contributing NOTHING identically to
 * one contributing everything — a slug that never existed still returns every
 * cross-cutting row. The empty-scope notice cannot reach that case, because
 * it fires only when nothing is ranked and here the borrowed rows carry the
 * presupposition themselves.
 *
 * A row whose `project` never arrived counts as `unknown`, never as
 * cross-cutting — folding absent into null would read absent as false.
 */
function projectSplit(ranked, projectSlug) {
  if (projectSlug === null || projectSlug === undefined) return '';
  let local = 0;
  let cross = 0;
  let unknown = 0;
  for (const r of [...ranked.top, ...ranked.index]) {
    const body = r.row?.body ?? {};
    if (!Object.hasOwn(body, 'project')) unknown += 1;
    else if (body.project === null || body.project === undefined) cross += 1;
    else if (body.project === projectSlug) local += 1;
    else unknown += 1;
  }
  const tail = unknown > 0 ? `, ${unknown} unknown` : '';
  return ` — ${local} for this project, ${cross} cross-cutting${tail}`;
}

/**
 * The anchor line, plus the staleness warning for a stale AnchorIntent.
 * Shared by the unified render and the memory pointer.
 */
function anchorLines(anchor, projectSlug) {
  const out = [];
  const anchorShortId = anchor.body?.shortId ?? anchor.id;
  const anchorSource = anchor.source ?? 'sessionlog'; // defensive for forward/back compat
  if (anchorSource === 'intent') {
    const text = anchor.body?.synopsis ?? anchor.body?.body ?? '';
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    const kind = anchor.body?.authoredBy?.kind ?? '?';
    const updatedAt = anchor.body?.updatedAt ?? '?';
    out.push(
      `Anchor: AnchorIntent #${anchorShortId} (intent, authored ${updatedAt} by ${kind} — "${preview}")`
    );
    // Staleness warning (Todo #f4e49558). resolveAnchorIntent returns
    // `stale: true` when ≥N SessionLogs have been filed since the anchor
    // was authored — a direct signal that work has moved past whatever
    // the anchor was tracking. Surface it visibly so the agent re-authors
    // before acting on stale focus.
    if (anchor.stale === true) {
      const since = anchor.sessionLogsSince ?? '?';
      const lastAt = anchor.lastSessionLogAt ?? '?';
      out.push(
        `⚠️  Anchor stale: ${since} SessionLogs filed since authored (most recent ${lastAt}). Audit + re-author before continuing.`
      );
    }
  } else {
    const anchorTime = anchor.body?.startedAt ?? anchor.body?.updatedAt ?? '?';
    const anchorBranch = anchor.body?.branch ?? '?';
    const scopeLabel = projectSlug === null ? 'across all projects' : `for project ${projectSlug}`;
    out.push(
      `Anchor: SessionLog #${anchorShortId} (fallback — no active AnchorIntent ${scopeLabel}, ${anchorTime}, branch ${anchorBranch})`
    );
  }
  return out;
}

/**
 * The default Agent Memory section: the anchor lines and how to recall
 * Memory, SessionLogs and Decisions, without preloading any of them.
 * `SYNOPTIC_COLD_START_MEMORY=full` selects the preloaded section instead.
 *
 * @param {{ anchor: object|null, projectSlug: string|null, ns: string }} p
 */
export function renderMemoryPointer({ anchor, projectSlug, ns }) {
  const out = ['## Agent Memory — not preloaded', ''];
  if (anchor) out.push(...anchorLines(anchor, projectSlug));
  else
    out.push(
      `No anchor: write an AnchorIntent (\`${ns}/createAnchorIntent\`) naming the current focus, so rule ranking has something to rank against.`
    );
  const where =
    projectSlug === null ? '' : `, \`where: { project: { in: ["${projectSlug}", null] } }\``;
  out.push('');
  out.push(
    `Memory, SessionLogs and Decisions live in \`${ns}\` and are not loaded here. When a task touches prior work, recall them: \`recall\` with \`namespace: "${ns}"\`, a topic \`query\`, \`type: "Memory"\` (or \`"SessionLog"\` / \`"Decision"\`; it defaults to Decision)${where}. Or query \`${ns}/Memory\` by \`name\`. Recall before writing a Memory, and update a matching row rather than duplicating it.`
  );
  return `${out.join('\n')}\n`;
}

/** Render unified hybrid output. Exported for tests.
 * @param {object} p
 * @param {object} p.result  From scoreHybrid: { mode, anchor, byType }.
 * @param {{ top: Array, index: Array }} p.ranked  From rankWithRRF.
 * @param {string} p.projectSlug
 * @param {number} p.k
 * @param {{ label: string, evidence: string }} [p.arms]  From `describeRecallArms`.
 *   Reaching this function means recall ANSWERED; it does not mean both arms
 *   ran. The header names only what the probe established, and defaults to
 *   `arms unverified` when nothing did.
 * @param {{ total: number, unknown: number, byProject: object }} [p.scopeDrops]
 *   From `buildScoredByType`. What the client-side project filter removed
 *   — reported only when it removed something.
 */
export function renderUnified({
  result,
  ranked,
  projectSlug,
  k,
  arms = UNVERIFIED_ARMS,
  scopeDrops = NO_SCOPE_DROPS
}) {
  const out = [];
  out.push(`## Agent Memory (${arms.label})`);
  out.push('');
  out.push(
    projectSlug === null
      ? `Project scope: **all projects** (SYNOPTIC_PROJECT_SCOPE=all).`
      : `Project scope: \`${projectSlug}\` + cross-cutting (project: null).`
  );
  out.push(...anchorLines(result.anchor, projectSlug));
  // A bare `hybrid` here would sit one line under a header that also says
  // `hybrid` — two different claims sharing a word. This one is about the
  // CLIENT-side fusion (structural rank + semantic rank through RRF) and is
  // true whenever this branch renders; the header's is about the SERVER's
  // retrieval arms and is not. Spelling this one out leaves the word to the
  // claim that has to be earned, without losing the env-flag mnemonic.
  // `renderTodos` below returns '' rather than head an empty list, and says so
  // in its own doc comment. With nothing ranked, this branch would otherwise
  // emit the header, this Mode line and the arms line, then stop — no section,
  // and no statement that there was none, while presupposing both that there
  // IS agent memory and that RRF fused a structural rank with a semantic one.
  //
  // The diagnostics stay rather than the section being withheld, because the
  // cold-start this fires on is a fresh store's first session — the one place
  // scope, anchor and arms are most worth seeing, and the one place an empty
  // list is most likely to be misread as recall being broken.
  const total = ranked.top.length + ranked.index.length;
  out.push(
    ...renderRecallState({
      recallState: 'fused',
      arms,
      scopeDrops,
      k,
      total,
      searched: RECALL_SEARCHED
    })
  );
  out.push('');

  if (total === 0) return `${out.join('\n')}\n`;

  out.push(
    ...renderIndexAndPull({
      top: ranked.top.map(unifiedEntry),
      index: ranked.index.map(unifiedEntry),
      topHeading: `### Top recall (${ranked.top.length} of ${total}${projectSplit(ranked, projectSlug)})`,
      indexHeading: `### Index (remaining ${ranked.index.length})`,
      foldLimit: MEMORY_BODY_LIMIT,
      foldReason: 'cold-start budget'
    })
  );
  out.push('');
  return out.join('\n');
}

// ---- Open Work + Agent Rules render ----

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const PRIORITY_EMOJI = { high: '🔴', medium: '🟡', low: '🟢' };

const hasText = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Which pile a row belongs in.
 *
 * A GATE OUTRANKS AN OWNER, and that ordering is the whole judgement here. A
 * row with both is not work someone is doing; it is work someone has put
 * their name to and which the world is not ready for. Sorting it under an
 * owner would present it as in-flight.
 */
export function classifyTodo(todo, myIdentityId) {
  // `status: 'blocked'` counts as waiting even with no gate prose. A row
  // marked blocked whose reason nobody wrote down is still not actionable,
  // and treating the absent prose as "no gate" would file the worst-recorded
  // rows under ready — exactly backwards.
  if (todo.status === 'blocked' || hasText(todo.blockedBy) || hasText(todo.revisitWhen))
    return 'waiting';
  const owner = todo.owner ?? null;
  if (owner === null) return 'ready';
  return myIdentityId !== null && owner === myIdentityId ? 'mine' : 'elsewhere';
}

const GROUPS = [
  { key: 'mine', heading: 'Claimed by me' },
  { key: 'ready', heading: 'Ready — unclaimed, no gate' },
  { key: 'elsewhere', heading: 'Owned elsewhere' },
  { key: 'waiting', heading: 'Waiting on a condition' }
];

/**
 * Render the open-work block as an ASSIGNMENT rather than an inventory.
 *
 * ## Why not a flat count
 *
 * A header of `N total — M open, 0 blocked` over one flat priority-sorted list
 * hides every gate someone wrote (`blockedBy`, `revisitWhen`) from anyone who
 * does not open the row by hand, so an agent reads a list of things to do most
 * of which are waiting on a condition that has not fired. An unread field
 * looks exactly like an unpopulated one.
 *
 * ## Why the headline count changed
 *
 * `N total — R ready` leads with the number a session can act on, because
 * that is the question being asked at cold start. The old leading number
 * counted rows that exist, which is only the same thing when nothing is
 * gated.
 *
 * Empty groups are omitted entirely rather than printed as `(0)`. A heading
 * with nothing under it spends budget to say nothing, and the totals in the
 * header already carry the fact.
 */
export function renderTodos(todos, { myIdentityId = null } = {}) {
  if (!Array.isArray(todos) || todos.length === 0) return '';

  const byGroup = { mine: [], ready: [], elsewhere: [], waiting: [] };
  for (const t of todos) byGroup[classifyTodo(t, myIdentityId)].push(t);

  const bySeverity = (a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return (a.shortId ?? 0) - (b.shortId ?? 0);
  };

  const actionable = byGroup.mine.length + byGroup.ready.length;
  const counts = [`${actionable} ready`];
  if (byGroup.elsewhere.length > 0) counts.push(`${byGroup.elsewhere.length} owned elsewhere`);
  if (byGroup.waiting.length > 0) counts.push(`${byGroup.waiting.length} waiting`);
  const lines = [`## Open Work (${todos.length} total — ${counts.join(', ')})`, ''];

  for (const { key, heading } of GROUPS) {
    const rows = byGroup[key];
    if (rows.length === 0) continue;
    lines.push(`### ${heading} (${rows.length})`, '');
    for (const t of rows.sort(bySeverity)) {
      const emoji = t.status === 'blocked' ? '🚫' : (PRIORITY_EMOJI[t.priority] ?? '⚪');
      const title = (t.title ?? '').slice(0, 80);
      const area = t.area ? ` (${t.area})` : '';
      // The gate itself, clipped. Naming the CONDITION is the difference
      // between "this is waiting" and "this is waiting for something you can
      // check" — and a gate nobody can see is one nobody re-derives.
      const gate = key === 'waiting' ? ` — ${flattenGate(t.revisitWhen ?? t.blockedBy ?? '')}` : '';
      lines.push(`- ${emoji} #${t.shortId} ${title}${area}${gate}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Enough of a gate to judge it by, clipped to protect the inline budget.
 *
 * Prefers the first sentence, but only when that sentence CARRIES something.
 * Found by rendering the live board: gates routinely open with a short
 * lead-in — `Signal-gated.`, `No producer.` — and a first-sentence rule
 * faithfully reproduced exactly the words the group heading had already said.
 * Below the floor it clips the flattened text instead, which reaches the
 * clause naming the actual condition.
 */
function flattenGate(text, maxChars = 90, minSentenceChars = 30) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const first = end >= 0 ? flat.slice(0, end + 1) : flat;
  const chosen = first.length >= minSentenceChars && first.length <= maxChars ? first : flat;
  return chosen.length <= maxChars ? chosen : `${chosen.slice(0, maxChars).trimEnd()}…`;
}

/** Truncate a rule body to a single skim-line. Stops at the first sentence
 *  boundary OR `maxChars`, whichever comes first. Keeps multi-paragraph
 *  rules from blowing the inline budget when rendered as `should`. */
function summarizeRule(body, maxChars = 160) {
  const flat = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length === 0) return '';
  // Stop at the first sentence boundary if it lands before maxChars.
  const sentenceEnd = flat.search(/[.!?](\s|$)/);
  if (sentenceEnd >= 0 && sentenceEnd + 1 <= maxChars) return flat.slice(0, sentenceEnd + 1);
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars).trimEnd()}…`;
}

/** Render the agent-rules block. Empty string when no rules.
 *  Tiered by severity — `must` rules render in full (load-bearing behaviour
 *  + safety boundaries; can't afford to be summarized away); `should` rules
 *  render as one-line bullets (preferences, efficiency tips, contextual best
 *  practices). Rules without a severity default to `should`.
 *
 *  Per CLAUDE.md these are operational directives the agent applies silently —
 *  surfacing them in the hook output so they're available in context, not so
 *  they're announced to the user. The render is positioned BEFORE memory so
 *  the always-applicable rules survive any inline-budget truncation. */
export function renderAgentRules(rules, opts = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  const {
    salience = false,
    sessionContext = '',
    topK = 5,
    anchorVector = null,
    ruleVectors = null,
    ns = 'cortext',
    only = 'all',
    onPromoted = null,
    // `headline` renders salient rules as skim lines; `full` renders their bodies.
    salientMode = 'headline'
  } = opts;

  // `only` exists so the caller can place the two severities INDEPENDENTLY in
  // the document. Partitioning inside one section deep in a large payload would
  // leave both halves below the fold together. Splitting the render is what
  // lets `must` lead.
  const selected = only === 'all' ? rules : rules.filter((r) => isMust(r) === (only === 'must'));
  if (selected.length === 0) return '';

  if (only === 'must') return renderMustRules(selected, ns);

  // Salience ranking never applies to `must`: ranking a binding rule out of
  // view is the failure this Todo is about. It is only ever offered the
  // `should` tail.
  if (salience) {
    return renderAgentRulesSalient(selected, {
      sessionContext,
      topK,
      anchorVector,
      ruleVectors,
      ns,
      tierLabel: only === 'should' ? ' — should' : '',
      onPromoted,
      salientMode
    });
  }
  return renderAgentRulesClassic(selected, ns);
}

/** `severity: 'must'` is the binding tier; everything else is advisory. */
function isMust(r) {
  return r?.severity === 'must';
}

/**
 * The binding rules in BRIEF, placed first so they survive truncation.
 *
 * ## The gap this closes
 *
 * Ordering by consequence-of-missing puts the `must` block first, and the
 * manifest above it says what exists. Neither is enough: the block can run past
 * 30 KB while the harness renders roughly 2 KB inline, so a session can read
 * the preview, proceed, and never read rules that were served and ranked
 * correctly.
 *
 * The manifest's job is telling a reader that content exists — but a NOTICE THAT A RULE EXISTS IS NOT THE RULE. An
 * agent that knows it has unread binding rules and proceeds anyway has been
 * told the truth and is still unconstrained.
 *
 * ## Why synopses rather than a shorter block
 *
 * The full rules cannot be made to fit without gutting them, so this does not
 * touch them. It emits each rule's `synopsis`, capped at two sentences BECAUSE
 * it is the indexed retrieval surface: roughly a 14x reduction, with every full
 * body still rendered below.
 *
 * The duplication is the point. What must survive truncation belongs in the
 * inline budget; what rewards a full read belongs further down.
 */
export function renderMustDigest(musts, ns = 'cortext') {
  if (!Array.isArray(musts) || musts.length === 0) return '';
  const lines = [
    `## Binding rules in brief — ${musts.length} \`must\` (full text below)`,
    '',
    '**Read these even if you read nothing else.** Missing one produces a ' +
      'violation you will not notice yourself committing, and it will usually ' +
      'be a harness default winning by absence. Full text and triggers render ' +
      `further down this document; query \`${ns}/AgentRule\` ` +
      'for anything not shown.',
    ''
  ];
  // Ordered like the full block below it, and for the same reason: this digest
  // occupies the strongest position in the whole payload, so the rule that
  // appears first here is the rule most likely to survive a partial read.
  // Leaving it in arrival order spent that position on whatever the query
  // happened to return first. Numbered because a bare list of twenty-four
  // reads as undifferentiated; a number is a cheap claim that the order means
  // something.
  const ordered = [...musts].sort((a, b) => {
    const d =
      categoryRank(a.category ?? 'uncategorised') - categoryRank(b.category ?? 'uncategorised');
    return d !== 0 ? d : compareWithinCategory(a, b);
  });
  let n = 0;
  for (const r of ordered) {
    // A rule with no synopsis still BINDS, so name it rather than drop it —
    // a digest that silently omits one lies about how many rules apply, which
    // is the "absence mistaken for nothing there" failure the manifest guards.
    const text =
      typeof r.synopsis === 'string' && r.synopsis.length > 0
        ? r.synopsis
        : '(no synopsis — read the full rule below)';
    const cat = r.category ? ` (${r.category})` : '';
    n += 1;
    lines.push(`${n}. **#${r.shortId}**${cat} — ${text}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * The `must` block, rendered standalone so it can lead the document.
 *
 * Carries its own framing because it does not sit under the combined
 * `## Agent Rules` heading, and because a reader
 * arriving at the top of a truncated payload needs to know both that these
 * bind and that more rules exist further down.
 */
function renderMustRules(musts, ns = 'cortext') {
  return renderRuleTiers(
    { must: musts.map((r) => toRuleEntry(r)) },
    {
      title: `## Agent Rules — must (${musts.length})`,
      intro: [
        '**Binding. These are not preferences.** Missing one produces a violation ' +
          'you will not notice yourself committing, which is why they lead this ' +
          `document rather than following the recoverable context below. The ` +
          `advisory \`should\` tier renders further down; query \`${ns}/AgentRule\` ` +
          'for anything not shown.',
        'Each rule renders in full. Its `rationale` — the incident history that ' +
          'makes the rule revisable — is recorded but not injected; fetch it by ' +
          'shortId when you are about to argue with a rule rather than follow ' +
          'one.'
      ],
      ...BY_COST
    }
  );
}

/**
 * Category order, most costly to get wrong first.
 *
 * Position in a long payload is not neutral — attention falls off in the middle
 * — so the order categories appear in is a real decision. It was being made by
 * SPELLING: this grouping sorted `Object.keys().sort()`, which put
 * `communication` and `git` at the head and `verification` and `tooling` at the
 * tail for no reason but their first letter.
 *
 * Ranked by what a violation COSTS, not by how often a rule fires:
 *   kernel    — silent data corruption; a reader cannot infer these
 *   identity     — writes attributed to the wrong principal, unfalsifiable later
 *   permissions  — secrets, destructive acts
 *   verification — a false "done"; the failure is believing a green
 *   process      — rework, scope drift; recoverable
 *   style        — legibility
 *
 * An unlisted category renders AFTER the ranked ones rather than silently at
 * the front, alphabetical among themselves so it stays deterministic. Adding a
 * category without ranking it is then visible as a demotion rather than a
 * random placement.
 */
const CATEGORY_ORDER = [
  'substrate',
  'identity',
  'permissions',
  'verification',
  'testing',
  'tooling',
  'git',
  'scope-discipline',
  'investigation',
  'process',
  'communication',
  'style'
];

function categoryRank(cat) {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/**
 * Within a category: `pinned` leads, `shortId` breaks ties.
 *
 * Deliberately NOT importance. No rule declares an intra-category rank, and
 * deriving one from insertion order would look like a judgement while being an
 * accident. `pinned` is the only importance signal a rule actually carries, so
 * it is the only one used; the remainder is stable rather than meaningful,
 * which is the honest arrangement until a rank field exists.
 */
function compareWithinCategory(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  return (a.shortId ?? 0) - (b.shortId ?? 0);
}

/** Category grouping for the must tier and the classic render: ranked by
 *  cost, counted, `pinned` then shortId within a category. */
const BY_COST = {
  level: '###',
  categoryOrder: CATEGORY_ORDER,
  counts: true,
  compare: compareWithinCategory
};

/** Classic severity-tiered render: `must` full, `should` skim. Not the
 *  cold-start default — the salient tier is on unless `RULE_SALIENCE=off`. Kept, and kept byte-stable, because it is
 *  what the escape hatch falls back to. */
function renderAgentRulesClassic(rules, ns = 'cortext') {
  const musts = [];
  const shoulds = [];
  for (const r of rules) {
    if (isMust(r)) musts.push(r);
    else shoulds.push(r);
  }
  // Heading names only the tiers actually present. When the caller has already
  // placed `must` at the top of the document via `only`, this render receives
  // shoulds alone and must not advertise "0 must" — a zero here would read as
  // "there are no binding rules", which is the opposite of true.
  const heading =
    musts.length === 0
      ? `## Agent Rules — should (${shoulds.length})`
      : shoulds.length === 0
        ? `## Agent Rules (${musts.length} must)`
        : `## Agent Rules (${musts.length} must, ${shoulds.length} should)`;
  const lines = [heading, ''];

  if (musts.length > 0) {
    lines.push('### must — load-bearing behaviour and safety boundaries');
    lines.push('');
    lines.push(
      ...renderRuleGroups(
        musts.map((r) => toRuleEntry(r)),
        { ...BY_COST, level: '####' }
      )
    );
  }

  if (shoulds.length > 0) {
    lines.push('### should — preferences, efficiency, contextual best practices');
    lines.push('');
    lines.push(
      `*Skim list. Query \`${ns}/AgentRule\` by shortId for the full body when one applies.*`
    );
    lines.push('');
    for (const r of shoulds) {
      const cat = r.category ? ` *(${r.category})*` : '';
      lines.push(`- **#${r.shortId}**${cat} — ${summarizeRule(r.rule)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Build the session-context string the rule scorer ranks against. Today this
 *  is the open-work signal (Todo titles + areas) — a strong "what is this
 *  session about" proxy available at the point AgentRules render (before the
 *  memory/anchor block). Enriching with the AnchorIntent + recent SessionLog
 *  synopsis is a noted follow-up. */
export function buildRuleSessionContext(todos) {
  if (!Array.isArray(todos)) return '';
  const parts = [];
  for (const t of todos) {
    if (t.title) parts.push(t.title);
    if (t.area) parts.push(t.area);
  }
  return parts.join(' ');
}

/** A rule renders `pinned` when `pinned === true`. Absent/null (pre-existing
 *  rows that predate the field) is treated as unpinned. */
function isPinned(rule) {
  return rule.pinned === true;
}

/**
 * An AgentRule row as a context-render rule entry — the full-body treatment
 * (`must`/pinned/salient) and the skim line both render from it.
 *
 * In the full form the rule body renders in full. `rationale` renders as a
 * POINTER (`note`), not inline.
 *
 * ## Why the evidence is not resident
 *
 * `rationale` is the evidence for a rule — the incident history, the falsified
 * diagnoses, the "this was restructured three times and it did not help" record
 * that makes a rule revisable rather than merely obeyed. It is what stops the
 * fleet re-litigating a settled rule, and it is genuinely worth having.
 *
 * It is not, however, what makes a rule FOLLOWABLE. Injected into every full
 * tier on every cold start, `*Why:*` prose is close to half the rule block: a
 * standing tax on the one section of this
 * document that must survive a truncated read, paid to carry text no rule
 * depends on.
 *
 * ## Why a pointer rather than silence
 *
 * A dropped field trains readers to assume there is nothing there — the same
 * "absence mistaken for nothing" failure the manifest and the must
 * digest both exist to prevent. The pointer costs ~58 B against a mean
 * rationale of ~935 B and keeps the evidence one query away.
 *
 * ## The one hazard, and why it is handled elsewhere
 *
 * This is safe ONLY while `rationale` carries no binding text. A live
 * directive to whoever edits a rule belongs in its `rule` body (for example a
 * `<maintenance>` block); past-tense narration must NOT be promoted (an
 * incident report injected as a directive is this same bug in the other
 * direction).
 *
 * If you author a rule whose rationale contains an instruction, it is in the
 * wrong field. Put it in `rule`.
 */
function toRuleEntry(r) {
  return {
    ref: `#${r.shortId}`,
    severity: r.severity ?? null,
    pinned: isPinned(r),
    category: r.category ?? null,
    body: r.rule,
    // The skim form prefers the authored synopsis (purpose-built short form)
    // and falls back to a derived summary for rows that predate the field.
    synopsis:
      typeof r.synopsis === 'string' && r.synopsis.length > 0 ? r.synopsis : summarizeRule(r.rule),
    // Carried for compareWithinCategory and onPromoted; not rendered.
    shortId: r.shortId,
    row: r
  };
}

/** Salience-tiered render (RULE_SALIENCE on). Three tiers, never-omit:
 *   - pinned   → full, always (safety + every-turn rules; exempt from ranking)
 *   - salient  → full, the top-K unpinned rules by relevance to this session
 *   - skim     → one-liner, the remaining unpinned rules (queryable by shortId)
 *  Every active rule lands in exactly one tier — the worst case under ranking
 *  is "summarized," never "omitted." */
function renderAgentRulesSalient(
  rules,
  {
    sessionContext,
    topK,
    anchorVector,
    ruleVectors,
    ns = 'cortext',
    tierLabel = '',
    onPromoted = null,
    salientMode = 'headline'
  }
) {
  // rankRules blends structural term-overlap with semantic anchor-cosine via
  // RRF; it falls back to structural-only when anchorVector/ruleVectors are
  // absent, so this same path serves both the semantic and structural modes.
  // Only unpinned rules are ranked; the order is handed to context-render as
  // the score, which keeps rankRules' shortId tie-break.
  const unpinned = rules.filter((r) => !isPinned(r));
  const ranked = rankRules(unpinned, { sessionContext, anchorVector, ruleVectors });
  const score = new Map(ranked.map((s, i) => [s.shortId, ranked.length - i]));

  // Every rule handed to this render is rankable: under `only: 'should'` there
  // are no musts, and the combined render (`only: 'all'`) has always ranked its
  // musts alongside the rest. Advisory severity says so to tierRules, which
  // would otherwise lift musts into a tier of their own.
  const tiers = tierRules(
    rules.map((r) => ({
      ...toRuleEntry(r),
      severity: 'should',
      score: score.get(r.shortId) ?? null
    })),
    { topK }
  );

  // Report the PROMOTED set. Promotion is the signal the salience
  // learning wants — reinforcing everything the ranker merely considered would
  // boost the whole rule set uniformly, which is the same as boosting nothing.
  // A callback rather than a return value keeps this a render function, and
  // mirrors onUnexpectedProjection / onFrameFailure elsewhere in this codebase.
  if (onPromoted !== null) onPromoted([...tiers.pinned, ...tiers.salient].map((e) => e.row));

  // The heading names its tier when this render is only PART of the rules
  // (`must` is its own leading section). Without it a salient render emits a
  // second `## Agent Rules` that looks like the whole set, silently missing
  // the binding rules.
  return renderRuleTiers(tiers, {
    title:
      `## Agent Rules${tierLabel} (${tiers.pinned.length} pinned, ${tiers.salient.length} salient, ` +
      `${tiers.skim.length} skim)`,
    labels: {
      pinned: '### pinned — always-on (safety boundaries + every-turn surface rules)',
      salient:
        salientMode === 'full'
          ? '### salient — most relevant to this session'
          : `### salient — most relevant to this session; query \`${ns}/AgentRule\` by shortId for the full body`,
      skim: `### skim — query \`${ns}/AgentRule\` by shortId for the full body when one applies`
    },
    skimTiers: salientMode === 'full' ? ['skim'] : ['salient', 'skim']
  });
}

/** Cost-ranked category order, then `pinned`, then shortId. */
export function compareRules(a, b) {
  const d =
    categoryRank(a.category ?? 'uncategorised') - categoryRank(b.category ?? 'uncategorised');
  return d !== 0 ? d : compareWithinCategory(a, b);
}
