// Vectors and salience reinforcement for the AgentRule salient tier.
//
// ## The gap this closes
//
// `rankRules` implements exactly the right thing — RRF over a structural
// keyword score and cosine(ruleVector, anchorVector) — and short-circuits to
// structural-only when either vector is missing:
//
//     if (!anchorVector || !(ruleVectors instanceof Map) || ruleVectors.size === 0)
//       return structural;
//
// Without this module the call site would pass NEITHER, the short-circuit
// would fire on every session, and AgentRule salience would never be
// reinforced.
//
// ## The transport: FRAME dispatch, not the kernel routes
//
// Both operations exist twice — as a kernel route and as a frame mutation,
// delegating to one core each. This module uses the FRAME half:
//
//     recall/fetchEmbeddings  { refs:    [{ namespace, type, id }], boost? }
//       -> { model, vectors: [{ namespace, type, id, row, vector, _salience }] }
//     recall/boost            { targets: [{ namespace, type, id }] }
//       -> { ok, requested, applied, missing: [{ namespace, type, id }] }
//
// Note `id` is the UUID. `rankRules` keys on `shortId`, so the mapping happens
// here rather than leaking a second identifier into the ranker.
//
// **The kernel routes cannot authenticate this caller.** They 401 a
// token the kernel itself accepts, because `mountKernelRoute` is handed the
// host's undecorated AuthConfig with no key registry attached, so an agent kid
// cannot be resolved and a valid token reads as "present-but-invalid". Both
// functions below sign and swallow failure by design, so on the kernel routes
// `rankRules` would short-circuit to structural on EVERY session and the
// write-back would never fire. See `substrateMutate` for the measurement.
//
// ## `applied` reports EFFECT, and reports it before the effect lands
//
// The server reports `applied` and `missing[]` alongside `requested`, so a
// boost is confirmable: `requested !== applied` is a real, diagnosable state
// — a rule that exists but has no embedding row, created and never embedded —
// and it is surfaced rather than swallowed.
//
// One hazard: the store write is fire-and-forget
// (`void store.boostSalience(...)`), so `applied: 1` returns SYNCHRONOUSLY for
// a write that has not landed yet. Reading the column immediately afterwards
// shows the old value and looks like a failed boost. It is not; it is in
// flight. `applied` is honest about intent-to-write, which is one step
// better than `requested` and one step short of observed.
//
// ## Boost-on-fetch is opt-IN
//
// A fetch does not reinforce unless the caller passes `boost: true`, because
// ranking is not use. This module fetches EVERY active rule in order to rank
// them, so a reinforce-everything-considered default would drown the reinforce-what-was-promoted that `boostSalience` exists
// to perform. Neither call below passes `boost`, deliberately — promotion is
// the signal, and it is written explicitly, once, after the render.
//
// ## And the write is a no-op for RANKING until someone sets a weight
//
// substrate's recall-side blend is `score * (1 + weight * log(1 + salience))` with
// weight defaulting to 0, and `rankRules` has no salience term at all. So
// populating the column changes no ordering anywhere yet. Wiring the write without the read
// is a no-op that looks like progress. What it DOES buy is a real signal
// accumulating now, so the read has something to switch on later.

import { substrateMutate } from './substrate-http.js';

/**
 * Fetch stored embedding vectors for rows.
 *
 * Never throws — a cold-start must degrade to less context, never to none, and
 * the salient tier degrades to structural-only exactly as it does today.
 *
 * @param {string} substrateUrl
 * @param {ReadonlyArray<{namespace: string, type: string, id: string}>} refs
 * @param {{ fetchImpl?: typeof fetch, onFrameFailure?: ((key: string, detail: string) => void)|null }} [opts]
 * @returns {Promise<Map<string, number[]>>} id -> vector. Empty on any failure.
 */
export async function fetchRowVectors(
  substrateUrl,
  refs,
  { fetchImpl = fetch, onFrameFailure = null } = {}
) {
  const out = new Map();
  if (!Array.isArray(refs) || refs.length === 0) return out;
  const key = 'recall/fetchEmbeddings';
  try {
    const data = await substrateMutate(
      substrateUrl,
      { [key]: { params: { refs }, fields: { model: true, vectors: true } } },
      { fetchImpl, onFrameFailure }
    );
    const vectors = Array.isArray(data?.[key]?.vectors) ? data[key].vectors : [];
    for (const v of vectors) {
      if (typeof v?.id === 'string' && Array.isArray(v?.vector)) out.set(v.id, v.vector);
    }
  } catch {
    /* structural-only, which is the current behaviour anyway */
  }
  return out;
}

/**
 * Reinforce salience on the rows that were PROMOTED.
 *
 * Promotion, not consideration — these are different signals and promotion is the one the learning wants. Boosting everything
 * the ranker looked at would reinforce the whole rule set uniformly, which is
 * the same as reinforcing nothing.
 *
 * @returns {Promise<{requested: number, applied: number,
 *   missing: Array<{namespace: string, type: string, id: string}>}|null>}
 *   null on failure OR on a refused frame. `applied` is the number that
 *   reflects EFFECT; `requested` reflects intent and is kept only so a caller
 *   can spot the difference.
 */
export async function boostSalience(
  substrateUrl,
  targets,
  { fetchImpl = fetch, onFrameFailure = null } = {}
) {
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const key = 'recall/boost';
  try {
    const data = await substrateMutate(
      substrateUrl,
      {
        [key]: {
          params: { targets },
          fields: { ok: true, requested: true, applied: true, missing: true }
        }
      },
      { fetchImpl, onFrameFailure }
    );
    // A refused frame arrives as 200 with the key ABSENT. Returning null for it
    // is right — the audit reports `unknown`, not `ok` — and a refusal is the
    // CORRECT outcome for an anonymous caller on a writes=identity namespace.
    const json = data?.[key];
    if (json === undefined || json === null) return null;
    const requested = typeof json.requested === 'number' ? json.requested : targets.length;
    // `applied` absent means an older deployment. Reporting `applied: requested`
    // there would manufacture a confirmation the server never gave, so it stays
    // null and callers can tell "not supported" from "supported, zero applied".
    const applied = typeof json.applied === 'number' ? json.applied : null;
    const missing = Array.isArray(json.missing) ? json.missing : [];
    return { requested, applied, missing };
  } catch {
    return null;
  }
}

/**
 * Build the `shortId -> vector` map `rankRules` expects.
 *
 * Rows without a stored vector are simply absent, which is what the ranker
 * already handles: it skips them when scoring semantically, so a partially
 * embedded rule set degrades per-rule rather than collapsing to structural.
 *
 * @param {ReadonlyArray<{id?: string, shortId?: number}>} rules
 * @param {Map<string, number[]>} byId
 * @returns {Map<number, number[]>}
 */
export function toShortIdVectors(rules, byId) {
  const out = new Map();
  for (const r of rules) {
    if (typeof r?.id !== 'string' || r?.shortId === undefined || r?.shortId === null) continue;
    const v = byId.get(r.id);
    if (Array.isArray(v)) out.set(r.shortId, v);
  }
  return out;
}

/** `{namespace, type, id}` refs for rows that have an id. */
export function toRefs(rows, namespace, type) {
  return rows.filter((r) => typeof r?.id === 'string').map((r) => ({ namespace, type, id: r.id }));
}
