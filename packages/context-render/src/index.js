// @mnmal-ai/context-render — type-generic index-and-pull rendering, body
// folding, budget trim, RRF ranking and rule tiering, shared by synoptic's cold-start and
// other context renderers so they cannot drift.
//
// No runtime dependencies and no Node built-ins: it runs anywhere TextEncoder does.

export { byteLength, DEFAULT_POINTER, splitByTokens, truncateToBudget } from './budget.js';
export { closeOpenFence, cutAtLineBoundary, flattenHeadings, foldBody } from './fold.js';
export { renderIndexAndPull, renderIndexLine, renderPulled } from './index-pull.js';
export {
  assignRanks,
  combineRRF,
  fuseRRF,
  makeTieBreak,
  rankWithRRF,
  selectWithMinFloors
} from './rank.js';
export {
  renderRuleFull,
  renderRuleGroups,
  renderRuleSkim,
  renderRuleTiers,
  tierRules
} from './rules.js';

/** @typedef {import('./index-pull.js').Entry} Entry */
/** @typedef {import('./rank.js').RankRow} RankRow */
/** @typedef {import('./rank.js').TieBreak} TieBreak */
/** @typedef {import('./rank.js').Fused} Fused */
/** @typedef {import('./rules.js').RuleEntry} RuleEntry */
/** @typedef {import('./rules.js').RuleTiers} RuleTiers */
