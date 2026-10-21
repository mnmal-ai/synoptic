// Reciprocal Rank Fusion over typed entries, with per-type minimum floors.
//
// Moved from synoptic's scoring/ranker.js. The algorithm is unchanged;
// what moved out are the three places it knew synoptic's types (Memory,
// SessionLog, Decision): the tie-break order, the `updatedAt` recency read, and
// the fixed list of groups to flatten. Each is now caller-supplied.
//
// Rows are `{ type, structural, semantic, ...anything }`. `type` is the GROUP a
// row belongs to (it keys `minFloors`), not a schema name, and nothing here
// interprets it beyond that. `semantic` is null when that arm did not score the
// row; RRF then counts the structural term alone.

/**
 * @typedef {object} RankRow
 * @property {string} type
 * @property {number} structural
 * @property {number|null} [semantic]
 * @property {number} [structuralRank]
 * @property {number|null} [semanticRank]
 * @property {number} [combined]
 * @property {number} [combinedRank]
 */

/** @typedef {(a: RankRow, b: RankRow) => number} TieBreak */

/** RRF: 1/(k + rank) per arm, summed. A missing semantic rank contributes nothing. */
export function combineRRF({ structuralRank, semanticRank, k }) {
  const structTerm = 1 / (k + structuralRank);
  if (semanticRank === null || semanticRank === undefined) return structTerm;
  const semTerm = 1 / (k + semanticRank);
  return structTerm + semTerm;
}

/** @type {TieBreak} */
const NO_TIE_BREAK = () => 0;

/**
 * A tie-break comparator: group order first, then most recent first.
 *
 * @param {object} p
 * @param {ReadonlyArray<string>} [p.groupOrder=[]] Types in priority order; unlisted sort last.
 * @param {(row: RankRow) => (string|number|null|undefined)} [p.timeOf]
 *   A row's timestamp (ISO string or epoch ms). Rows without a valid one sort after rows with one.
 * @returns {TieBreak}
 */
export function makeTieBreak({ groupOrder = [], timeOf = () => null } = {}) {
  const order = new Map(groupOrder.map((t, i) => [t, i]));
  const ms = (r) => {
    const t = timeOf(r);
    if (typeof t === 'number') return t;
    return Date.parse(t ?? '');
  };
  return (a, b) => {
    const ta = order.get(a.type) ?? 99;
    const tb = order.get(b.type) ?? 99;
    if (ta !== tb) return ta - tb;
    const aUp = ms(a);
    const bUp = ms(b);
    const aValid = !Number.isNaN(aUp);
    const bValid = !Number.isNaN(bUp);
    if (aValid && bValid && aUp !== bUp) return bUp - aUp; // later first
    if (aValid && !bValid) return -1;
    if (!aValid && bValid) return 1;
    return 0;
  };
}

/**
 * Assign 1-based `structuralRank` to every row and `semanticRank` to rows the
 * semantic arm scored. Returns NEW row objects; the input is not mutated.
 *
 * @param {ReadonlyArray<RankRow>} scoredRows
 * @param {{ tieBreak?: TieBreak }} [opts]
 * @returns {RankRow[]}
 */
export function assignRanks(scoredRows, { tieBreak = NO_TIE_BREAK } = {}) {
  if (!Array.isArray(scoredRows) || scoredRows.length === 0) return [];
  const withStruct = scoredRows.map((r) => ({ ...r, structuralRank: 0, semanticRank: null }));
  withStruct.sort((a, b) => {
    if (b.structural !== a.structural) return b.structural - a.structural;
    return tieBreak(a, b);
  });
  withStruct.forEach((r, i) => {
    r.structuralRank = i + 1;
  });
  const withSem = withStruct.filter((r) => r.semantic !== null && r.semantic !== undefined);
  withSem.sort((a, b) => {
    if (b.semantic !== a.semantic) return b.semantic - a.semantic;
    return tieBreak(a, b);
  });
  withSem.forEach((r, i) => {
    r.semanticRank = i + 1;
  });
  return withStruct;
}

/**
 * Pick `totalK` rows by `combined`, reserving `minFloors[type]` slots per type
 * first. Floors that over-subscribe `totalK` are scaled down proportionally,
 * and `onWarn` is told. Everything not picked is the `index`, best first.
 *
 * @param {ReadonlyArray<RankRow>} rankedRows Rows carrying `combined`.
 * @param {{ totalK: number, minFloors?: Record<string, number>, onWarn?: (message: string) => void }} opts
 * @returns {{ top: RankRow[], index: RankRow[] }}
 */
export function selectWithMinFloors(rankedRows, { totalK, minFloors = {}, onWarn }) {
  if (!Array.isArray(rankedRows) || rankedRows.length === 0) {
    return { top: [], index: [] };
  }
  const globalSorted = [...rankedRows].sort((a, b) => b.combined - a.combined);
  const floorSum = Object.values(minFloors).reduce((a, b) => a + b, 0);
  let floors = minFloors;
  if (floorSum > totalK) {
    if (onWarn)
      onWarn(
        `min-floors over-subscribed (sum=${floorSum} > totalK=${totalK}); scaling proportionally`
      );
    const scale = totalK / floorSum;
    floors = Object.fromEntries(
      Object.entries(minFloors).map(([type, f]) => [type, Math.floor(f * scale)])
    );
  }
  const picked = new Set();
  for (const [type, floor] of Object.entries(floors)) {
    if (floor <= 0) continue;
    const typeRows = globalSorted.filter((r) => r.type === type);
    for (const r of typeRows.slice(0, floor)) picked.add(r);
  }
  for (const r of globalSorted) {
    if (picked.size >= totalK) break;
    if (picked.has(r)) continue;
    picked.add(r);
  }
  const topArr = [...picked].sort((a, b) => b.combined - a.combined);
  const index = globalSorted.filter((r) => !picked.has(r));
  return { top: topArr, index };
}

/**
 * Rank grouped rows by RRF and split them into `top` (pulled in full) and
 * `index` (one line each).
 *
 * `groups` maps a type to its rows. `groupOrder`, when given, fixes both which
 * groups are read and the order they are flattened in — that order is the
 * input order to a stable sort, so it decides ties the tie-break leaves equal.
 * Omitted, every group is read in insertion order.
 *
 * Every returned row carries `structuralRank`, `semanticRank`, `combined` and a
 * 1-based global `combinedRank`.
 *
 * @param {Record<string, ReadonlyArray<RankRow>>} groups
 * @param {object} opts
 * @param {number} opts.k RRF constant.
 * @param {number} opts.totalK How many rows to pull.
 * @param {Record<string, number>} [opts.minFloors]
 * @param {ReadonlyArray<string>} [opts.groupOrder]
 * @param {TieBreak} [opts.tieBreak]
 * @param {(message: string) => void} [opts.onWarn]
 * @returns {{ top: RankRow[], index: RankRow[] }}
 */
export function rankWithRRF(
  groups,
  { k, totalK, minFloors = {}, groupOrder, tieBreak = NO_TIE_BREAK, onWarn }
) {
  const keys = groupOrder ?? Object.keys(groups ?? {});
  const flat = keys.flatMap((t) => groups?.[t] ?? []);
  if (flat.length === 0) return { top: [], index: [] };
  const ranked = assignRanks(flat, { tieBreak });
  for (const r of ranked) {
    r.combined = combineRRF({ structuralRank: r.structuralRank, semanticRank: r.semanticRank, k });
  }
  ranked.sort((a, b) => b.combined - a.combined);
  for (let i = 0; i < ranked.length; i++) ranked[i].combinedRank = i + 1;
  return selectWithMinFloors(ranked, { totalK, minFloors, onWarn });
}

/**
 * @typedef {object} Fused
 * @property {string} id
 * @property {number} rrf        Sum of 1/(k + rank) over the lists the id appears in. 0 when pinned and unranked.
 * @property {Array<number|null>} ranks  1-based rank in each input list, null where absent.
 * @property {boolean} pinned
 */

/**
 * Plain Reciprocal Rank Fusion over any number of ranked lists: no named arms, no groups, no recency.
 *
 * Each list is `{ id, score }[]` and is ranked by ITS OWN score, highest first —
 * the order it arrives in is not trusted, because a caller sorting by the wrong
 * key is a silent ranking bug. An id absent from a list contributes nothing for
 * that list.
 *
 * `pinned` ids come first, in exactly the given order, whether or not any list
 * ranked them (a caller's required core instructions). Every other id follows once,
 * by fused score; exact ties break by id so the output is deterministic.
 *
 * @param {ReadonlyArray<ReadonlyArray<{ id: string, score: number }>>} lists
 * @param {{ k?: number, pinned?: ReadonlyArray<string> }} [opts]
 * @returns {Fused[]}
 */
export function fuseRRF(lists, { k = 60, pinned = [] } = {}) {
  const n = lists.length;
  /** @type {Map<string, Fused>} */
  const byId = new Map();
  const at = (id) => {
    let f = byId.get(id);
    if (f === undefined) {
      f = { id, rrf: 0, ranks: Array(n).fill(null), pinned: false };
      byId.set(id, f);
    }
    return f;
  };
  lists.forEach((list, li) => {
    const ranked = [...list].sort((a, b) => b.score - a.score);
    ranked.forEach((item, i) => {
      const f = at(item.id);
      if (f.ranks[li] !== null) return; // first (best) occurrence in a list wins
      f.ranks[li] = i + 1;
      f.rrf += 1 / (k + i + 1);
    });
  });
  const head = [];
  for (const id of pinned) {
    const f = at(id);
    if (f.pinned) continue;
    f.pinned = true;
    head.push(f);
  }
  const rest = [...byId.values()]
    .filter((f) => !f.pinned)
    .sort((a, b) => b.rrf - a.rrf || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...head, ...rest];
}
