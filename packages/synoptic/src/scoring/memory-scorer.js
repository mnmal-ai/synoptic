// Pure scoring functions for the SessionStart memory-load hook.
// Inputs are plain row objects (as returned by Substrate's claude/Memory query);
// outputs are numeric scores or partitioned row sets. No I/O.

export const DEFAULT_IMPORTANCE_WEIGHTS = Object.freeze({
  user: 1.0,
  feedback: 1.0,
  project: 0.7,
  reference: 0.4
});

export const DEFAULT_UNKNOWN_WEIGHT = 0.5;
export const DEFAULT_HALFLIFE_H = 720;
export const DEFAULT_RECENCY_FLOOR = 0.2;
export const DEFAULT_TOP_K = 20;

export function importanceByType(type, weights = DEFAULT_IMPORTANCE_WEIGHTS) {
  if (type == null) return DEFAULT_UNKNOWN_WEIGHT;
  const w = weights[type];
  return typeof w === 'number' ? w : DEFAULT_UNKNOWN_WEIGHT;
}

export function recencyDecay(
  updatedAtIso,
  nowMs,
  { halfLifeH = DEFAULT_HALFLIFE_H, baseline = DEFAULT_RECENCY_FLOOR } = {}
) {
  if (updatedAtIso == null) return baseline;
  const t = Date.parse(updatedAtIso);
  if (Number.isNaN(t)) return baseline;
  const ageH = Math.max(0, (nowMs - t) / 3_600_000);
  if (ageH === 0) return 1.0;
  const decayFactor = Math.exp((-Math.LN2 * ageH) / halfLifeH);
  return baseline + (1 - baseline) * decayFactor;
}

/** Resolve halfLife for a scoring call. Priority:
 *  1. opts.halfLifeByType[opts.forType]
 *  2. opts.halfLifeH
 *  3. DEFAULT_HALFLIFE_H */
function resolveHalfLife(opts) {
  if (
    opts.forType &&
    opts.halfLifeByType &&
    typeof opts.halfLifeByType[opts.forType] === 'number'
  ) {
    return opts.halfLifeByType[opts.forType];
  }
  return opts.halfLifeH ?? DEFAULT_HALFLIFE_H;
}

export function scoreMemory(row, nowMs, opts = {}) {
  const importance = importanceByType(row?.type, opts.importanceWeights);
  const recency = recencyDecay(row?.updatedAt, nowMs, {
    halfLifeH: resolveHalfLife(opts),
    baseline: opts.baseline ?? DEFAULT_RECENCY_FLOOR
  });
  return importance * recency;
}

export function partitionByScore(rows, nowMs, opts = {}) {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { top: [], index: [] };
  }
  const scored = rows.map((row) => ({ row, score: scoreMemory(row, nowMs, opts) }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aT = Date.parse(a.row?.updatedAt ?? '');
    const bT = Date.parse(b.row?.updatedAt ?? '');
    if (!Number.isNaN(aT) && !Number.isNaN(bT) && aT !== bT) return bT - aT;
    return String(a.row?.name ?? '').localeCompare(String(b.row?.name ?? ''));
  });
  return {
    top: scored.slice(0, topK).map((s) => s.row),
    index: scored.slice(topK).map((s) => s.row)
  };
}

/**
 * Parse a JSON-encoded importance-weights map from an env var string.
 * Returns DEFAULT_IMPORTANCE_WEIGHTS when raw is null/undefined/empty,
 * when JSON.parse throws, when the value is an array (arrays pass
 * `typeof === 'object'` but aren't a weights map), or when the value is
 * a primitive/null. Only a plain object is accepted.
 *
 * Extracted from load-agent-memory.js so the hook stays thin and the
 * defensive branches are unit-testable without process.env stubbing.
 */
export function parseImportanceWeights(raw) {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_IMPORTANCE_WEIGHTS;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to default
  }
  return DEFAULT_IMPORTANCE_WEIGHTS;
}
