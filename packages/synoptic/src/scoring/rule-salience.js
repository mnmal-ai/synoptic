// AgentRule salience scorer for the SessionStart cold-start hook.
//
// Ranks UNPINNED rules by relevance to the current session so the renderer can
// promote the top-K to full text and collapse the rest to skim one-liners,
// reducing the always-on rule wall as the corpus grows. Pure + deterministic;
// no I/O. The signal is structural/lexical (term overlap) — semantic embedding
// of rules is a deferred follow-up (see the design spec).
//
// Pinned rules are filtered by the CALLER before scoring; this module only
// ranks what it is given.
//
// Note: cosine() is inlined here from lib/hybrid-scorer.js to avoid pulling in
// the PG-dependent async functions in that module.

/** Cosine similarity between two Float32Arrays. Returns 0 on zero-magnitude
 * inputs (avoids NaN). Throws on dimension mismatch. Range: [-1, 1]. */
function cosine(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Small, high-frequency function words that carry no topical signal. Kept
// deliberately short — the length floor (< 3 chars) handles most noise.
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'any',
  'can',
  'her',
  'was',
  'one',
  'our',
  'out',
  'has',
  'had',
  'his',
  'how',
  'its',
  'who',
  'did',
  'yes',
  'use',
  'via',
  'per',
  'when',
  'with',
  'this',
  'that',
  'from',
  'into',
  'your',
  'them',
  'they',
  'then',
  'than',
  'some',
  'such',
  'over',
  'only',
  'each',
  'also',
  'most',
  'more',
  'must',
  'should',
  'will',
  'just',
  'dont',
  'doesnt'
]);

/** Small additive boost so a load-bearing `must` rule edges out a `should`
 *  rule of equal lexical overlap. Tuned below 1 so it never overrides a real
 *  one-term topical match. */
const MUST_BOOST = 0.5;

/**
 * Split text into significant lowercase terms: drop stopwords, drop tokens
 * shorter than 3 chars, dedupe. Returns a string[] (order preserved by first
 * occurrence; callers that need membership build a Set).
 */
export function tokenize(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Lexical overlap: number of distinct rule terms present in the context. */
function overlap(ruleTokens, contextSet) {
  let n = 0;
  for (const t of ruleTokens) {
    if (contextSet.has(t)) n++;
  }
  return n;
}

/**
 * Score + rank unpinned rules against the session context.
 *
 * @param {Array<{shortId:number, rule:string, category?:string, severity?:string}>} rules
 * @param {string} sessionContext  Concatenated anchor + recent SessionLog + Todo terms.
 * @returns {Array<{shortId:number, score:number}>}  Sorted by score desc, then
 *          shortId asc (deterministic — never relies on input order).
 */
export function scoreRules(rules, sessionContext) {
  const contextSet = new Set(tokenize(sessionContext));
  const scored = rules.map((r) => {
    const ruleTokens = tokenize(`${r.rule ?? ''} ${r.category ?? ''}`);
    const lexical = overlap(ruleTokens, contextSet);
    const boost = r.severity === 'must' ? MUST_BOOST : 0;
    return { shortId: r.shortId, score: lexical + boost };
  });
  scored.sort((a, b) => b.score - a.score || a.shortId - b.shortId);
  return scored;
}

/** RRF constant, mirroring MEMORY_RRF_K — the rank-offset that damps the
 *  contribution of low-ranked items in the reciprocal-rank-fusion blend. */
const RRF_K = 60;

/**
 * Rank unpinned rules by structural (term-overlap) × semantic (anchor cosine)
 * relevance, combined via reciprocal rank fusion — mirroring the memory-type
 * hybrid recall. Semantic only ever SHARPENS the order; it never omits.
 *
 * Falls back to pure structural ranking (identical to `scoreRules`) when:
 *   - no anchor vector is available (anchorless cold-start), or
 *   - no rule carries a stored embedding.
 * A rule missing only its own vector contributes via structural rank alone.
 *
 * @param {Array<{shortId:number, rule:string, category?:string, severity?:string}>} rules
 * @param {{ sessionContext:string, anchorVector:(Float32Array|number[]|null),
 *           ruleVectors:Map<number,(Float32Array|number[])>, k?:number }} opts
 * @returns {Array<{shortId:number, score:number}>} sorted desc, shortId tiebreak.
 */
export function rankRules(rules, { sessionContext, anchorVector, ruleVectors, k = RRF_K } = {}) {
  const structural = scoreRules(rules, sessionContext);

  if (!anchorVector || !(ruleVectors instanceof Map) || ruleVectors.size === 0) {
    return structural;
  }

  const semanticScored = [];
  for (const r of rules) {
    const v = ruleVectors.get(r.shortId);
    if (v == null) continue;
    const sim = cosine(v, anchorVector);
    semanticScored.push({ shortId: r.shortId, sim: Number.isFinite(sim) ? sim : 0 });
  }
  if (semanticScored.length === 0) return structural;

  semanticScored.sort((a, b) => b.sim - a.sim || a.shortId - b.shortId);

  const structuralRank = new Map(structural.map((r, i) => [r.shortId, i + 1]));
  const semanticRank = new Map(semanticScored.map((r, i) => [r.shortId, i + 1]));

  const combined = rules.map((r) => {
    const sr = structuralRank.get(r.shortId);
    const mr = semanticRank.get(r.shortId);
    const score = (sr ? 1 / (k + sr) : 0) + (mr ? 1 / (k + mr) : 0);
    return { shortId: r.shortId, score };
  });
  combined.sort((a, b) => b.score - a.score || a.shortId - b.shortId);
  return combined;
}
