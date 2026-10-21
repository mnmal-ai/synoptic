// Build the `scoredByType` structure rankWithRRF expects, sourced over HTTP.
// For each recall type we fetch structural candidates (POST /substrate/v1/query, with
// _metadata.updatedAt) and semantic scores (POST /substrate/v1/recall), and join by id.
// structural = scoreMemory(body) (importance × recency, computed locally);
// semantic = the server's recall cosine, or null if the row wasn't in the recall
// results (or recall is unavailable). When recall is unavailable for ALL types,
// recallAvailable is false and every semantic is null — the caller renders
// structural-only (and rankWithRRF naturally degrades to structural ordering).

import { unknownEverywhere } from './projection-audit.js';
import { projectWhere } from './scope.js';
import { scoreMemory } from './scoring/memory-scorer.js';
import { recall, substrateQuery } from './substrate-http.js';

export const RECALL_TYPES = ['Memory', 'SessionLog', 'Decision'];
const DEFAULT_CANDIDATE_LIMIT = 200;

/**
 * Is a recall row in project scope?
 *
 * Recall is ASKED for its scope (`recallWhere` below), and a server that
 * honours it sends only in-scope rows, so on a current server this drops
 * nothing. It still runs on every row because a server that predates the
 * filter refuses it, and the retry without it returns rows from every project;
 * those have to be filtered here, on rows the server already sent.
 *
 * `undefined` is NOT `foreign`. A row we cannot prove is out of scope is kept
 * and counted, because dropping on absent evidence is the same conflation as
 * reading a missing `lexicalEnabled` as `off`.
 *
 * @returns {'in' | 'foreign' | 'unknown'}
 */
function scopeVerdict(row, projectSlug) {
  if (projectSlug === null || projectSlug === undefined) return 'in';
  if (!Object.hasOwn(row ?? {}, 'project')) return 'unknown';
  const p = row.project;
  if (p === null || p === undefined) return 'in';
  return p === projectSlug ? 'in' : 'foreign';
}

/**
 * Ask the store about recall rows whose `project` never arrived.
 *
 * A server that returns recall rows without their promoted columns (anything
 * on older servers, where a row's `project` can live only in its column) sends
 * some rows with no `project` key. A current server always sends the key, so
 * on one this finds nothing unresolved and sends no query.
 *
 * Keeping such a row is right — absent is not evidence of foreignness — but it
 * leaves the filter under-applied when the evidence is one query away. So it is
 * fetched rather than guessed at, in ONE call across the types that need it.
 *
 * Anything the store does not answer for stays unknown and stays IN: a frame
 * that was refused, or a row that has since been deleted, is not evidence
 * either. Mutates each entry's `bodyById` in place.
 */
async function resolveScopes({
  substrateUrl,
  namespace,
  projectSlug,
  staged,
  fetchImpl,
  onFrameFailure,
  noteDrop,
  noteUnknown
}) {
  const pending = staged.filter((s) => s.unresolved.length > 0);
  if (pending.length === 0) return;

  const payload = {};
  for (const { type, unresolved } of pending) {
    payload[`${namespace}/${type}`] = {
      params: { where: { id: { in: unresolved } }, limit: unresolved.length },
      fields: { id: true, project: true }
    };
  }

  let data = {};
  try {
    data = await substrateQuery(substrateUrl, payload, { fetchImpl, onFrameFailure });
  } catch {
    // Best effort, exactly like recall itself. A resolution that could not run
    // leaves every deferred row where it already is.
    data = {};
  }

  for (const { type, unresolved, bodyById } of pending) {
    const key = `${namespace}/${type}`;
    // Presence, not emptiness — a refused frame must not read as "no such rows",
    // which would mark every deferred row resolved-and-absent.
    const rows = Object.hasOwn(data, key) && Array.isArray(data[key]) ? data[key] : null;
    const answered = new Map((rows ?? []).map((r) => [r.id, r]));
    for (const id of unresolved) {
      const row = answered.get(id);
      if (row === undefined) {
        noteUnknown();
        continue;
      }
      if (scopeVerdict(row, projectSlug) === 'foreign') {
        bodyById.delete(id);
        noteDrop(row.project);
      }
    }
  }
}

/** The recall/Hit row filter for a scope, or undefined when the scope is all projects. */
function recallWhere(projectSlug) {
  if (projectSlug === null || projectSlug === undefined) return undefined;
  return { project: { in: [projectSlug, null] } };
}

/**
 * Recall scoped server-side, falling back to an unscoped ask when the scoped one
 * is refused (a server that predates the filter), so an older runtime keeps its
 * recall and the client-side scope filter does the work instead. The scoped ask
 * reports no frame failure: if recall itself is unavailable, the fallback is
 * refused too and reports it, once.
 *
 * Only a REFUSAL is retried. A transport failure (timeout, network) also returns
 * null, and asking again would spend a second full timeout on a server that is
 * not answering — so that null is returned as-is, as an unscoped ask's would be.
 */
async function scopedRecall(substrateUrl, opts, projectSlug) {
  const where = recallWhere(projectSlug);
  if (where === undefined) return recall(substrateUrl, opts);
  let refused = false;
  const rows = await recall(substrateUrl, {
    ...opts,
    where,
    onFrameFailure: () => {
      refused = true;
    }
  });
  return rows === null && refused ? recall(substrateUrl, opts) : rows;
}

// The `body` object render + scoring read: flat row fields + updatedAt lifted
// out of the server-managed _metadata projection.
function toBody(row) {
  const { _metadata, ...fields } = row;
  return { ...fields, updatedAt: _metadata?.updatedAt ?? fields.updatedAt ?? null };
}

// The handle fields projected as ONE union across all three RECALL_TYPES.
// Each type declares a different subset, so substrate reports the others as
// undeclared on every call — three `_diagnostics` per cold-start, all correct.
// Declaring the union as expected silences that, and the cross-type check
// below is what keeps the silence honest. Keep in sync with the `fields` block.
const HANDLE_FIELDS = [
  'name',
  'type',
  'description',
  'body',
  'topic',
  'choice',
  'status',
  'branch',
  'summary'
];

async function fetchCandidates(
  substrateUrl,
  namespace,
  type,
  projectSlug,
  fetchImpl,
  onDiagnostics
) {
  const key = `${namespace}/${type}`;
  const data = await substrateQuery(
    substrateUrl,
    {
      [key]: {
        params: {
          where: projectWhere(projectSlug),
          limit: DEFAULT_CANDIDATE_LIMIT,
          orderBy: [{ updatedAt: 'desc' }]
        },
        fields: {
          id: true,
          name: true,
          type: true,
          description: true,
          body: true,
          topic: true,
          choice: true,
          status: true,
          branch: true,
          summary: true,
          shortId: true,
          // Declared on all three RECALL_TYPES, so it is not part of the
          // HANDLE_FIELDS union above. Projected because the render reports
          // the project / cross-cutting split and cannot compute it
          // from rows that never carried the field.
          project: true,
          _metadata: true
        }
      }
    },
    {
      fetchImpl,
      expectUnknown: HANDLE_FIELDS,
      onUnexpectedProjection: onDiagnostics?.onUnexpected ?? null,
      onFrameFailure: onDiagnostics?.onFailure ?? null,
      onDiagnostics: (d) => onDiagnostics?.observe(key, d?.[key]?.unknownProjectionFields ?? [])
    }
  );
  return data[key] ?? [];
}

/**
 * @returns {Promise<{ byType: { Memory: Array, SessionLog: Array, Decision: Array }, recallAvailable: boolean }>}
 *   Each entry: { type, row: { id, body }, structural: number, semantic: number|null }.
 *   `scopeDrops` reports what the client-side project filter removed:
 *   `{ total, unknown, byProject }`.
 */
export async function buildScoredByType(opts) {
  const {
    substrateUrl,
    namespace,
    projectSlug,
    anchorText,
    nowMs,
    importanceWeights,
    halfLifeByType,
    recencyFloor,
    k = 60,
    fetchImpl,
    projectionAudit = null
  } = opts;

  // Per-type unknown sets, collected so the union projection can be checked
  // the only way it usefully can be. `expectUnknown: HANDLE_FIELDS` mutes the
  // per-call noise (all of it legitimate), which on its own would mute a
  // genuine rename too — the allowlist necessarily contains every field that
  // could go missing. What it cannot contain is a field missing on ALL THREE
  // types at once, which is what a rename, a removal or a typo looks like.
  // Currently empty, because every one of the nine union fields is declared by at least one type.
  /** @type {Array<{ key: string, unknown: Array<string> }>} */
  const observed = [];
  const diagSink =
    projectionAudit === null
      ? null
      : {
          onUnexpected: (entries) => projectionAudit.record(entries),
          onFailure: (k, d) => projectionAudit.recordFailure(k, d),
          observe: (key, unknown) => observed.push({ key, unknown })
        };

  const perType = await Promise.all(
    RECALL_TYPES.map(async (type) => {
      const [candidates, recallRows] = await Promise.all([
        fetchCandidates(substrateUrl, namespace, type, projectSlug, fetchImpl, diagSink),
        scopedRecall(
          substrateUrl,
          {
            query: anchorText,
            namespace,
            type,
            k,
            fetchImpl,
            onFrameFailure: diagSink?.onFailure ?? null
          },
          projectSlug
        )
      ]);
      return { type, candidates, recallRows };
    })
  );

  if (projectionAudit !== null) {
    projectionAudit.recordEverywhere(unknownEverywhere(observed));
  }

  const recallAvailable = perType.some((p) => p.recallRows !== null);

  const byType = { Memory: [], SessionLog: [], Decision: [] };
  const drops = { total: 0, unknown: 0, byProject: {} };
  const noteDrop = (project) => {
    const p = String(project);
    drops.byProject[p] = (drops.byProject[p] ?? 0) + 1;
    drops.total += 1;
  };

  // Fold recall-only rows in, deferring the ones whose scope the recall payload
  // could not answer for. `unresolved` is what the second pass asks the store.
  const staged = perType.map(({ type, candidates, recallRows }) => {
    const scoreById = new Map();
    if (recallRows) {
      for (const r of recallRows) {
        const id = r.row?.id;
        if (id !== undefined) scoreById.set(id, r.score);
      }
    }

    const bodyById = new Map();
    for (const row of candidates) bodyById.set(row.id, toBody(row));
    const unresolved = [];
    if (recallRows) {
      for (const r of recallRows) {
        const id = r.row?.id;
        if (id === undefined || bodyById.has(id)) continue;
        const verdict = scopeVerdict(r.row, projectSlug);
        if (verdict === 'foreign') {
          noteDrop(r.row.project);
          continue;
        }
        bodyById.set(id, toBody(r.row));
        if (verdict === 'unknown') unresolved.push(id);
      }
    }
    return { type, scoreById, bodyById, unresolved };
  });

  await resolveScopes({
    substrateUrl,
    namespace,
    projectSlug,
    staged,
    fetchImpl,
    onFrameFailure: diagSink?.onFailure ?? null,
    noteDrop,
    noteUnknown: () => {
      drops.unknown += 1;
    }
  });

  for (const { type, scoreById, bodyById } of staged) {
    byType[type] = Array.from(bodyById.entries()).map(([id, body]) => {
      const structural = scoreMemory(body, nowMs, {
        importanceWeights,
        halfLifeByType,
        forType: type,
        baseline: recencyFloor
      });
      const semantic = scoreById.has(id) ? scoreById.get(id) : null;
      return { type, row: { id, body }, structural, semantic };
    });
  }

  return { byType, recallAvailable, scopeDrops: drops };
}
