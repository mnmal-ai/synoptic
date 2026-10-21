// Ranker for the SessionStart memory-load hook: RRF over structural and
// semantic ranks, with per-type min-floors.
//
// The algorithm now lives in @mnmal-ai/context-render, shared with
// other consumers. What stays here is everything that knows synoptic's
// recall types — the three groups and their order, and the tie-break that reads
// a cortext row's `updatedAt` — bound so existing callers see no change.

import {
  assignRanks as assignGeneric,
  combineRRF,
  makeTieBreak,
  rankWithRRF as rankGeneric,
  selectWithMinFloors
} from '@mnmal-ai/context-render';

export { combineRRF, selectWithMinFloors };

// Flatten order is load-bearing: it is the input order to a stable sort, so it
// decides ties the tie-break leaves equal.
const RECALL_GROUPS = ['Memory', 'SessionLog', 'Decision'];

// Type order, then most recently updated first.
const tieBreak = makeTieBreak({
  groupOrder: RECALL_GROUPS,
  timeOf: (r) => r.row?.body?.updatedAt
});

/** @param {ReadonlyArray<object>} scoredRows */
export function assignRanks(scoredRows) {
  return assignGeneric(/** @type {any} */ (scoredRows), { tieBreak });
}

/**
 * @param {{ Memory?: object[], SessionLog?: object[], Decision?: object[] }} scoredByType
 * @param {{ k: number, totalK: number, minFloors: Record<string, number>, onWarn?: (m: string) => void }} opts
 */
export function rankWithRRF(scoredByType, { k, totalK, minFloors, onWarn }) {
  return rankGeneric(/** @type {any} */ (scoredByType), {
    k,
    totalK,
    minFloors,
    onWarn,
    groupOrder: RECALL_GROUPS,
    tieBreak
  });
}
