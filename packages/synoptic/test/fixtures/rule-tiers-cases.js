// Inputs for the rule-tier golden (rule-tiers-golden.test.js). The expected
// output was recorded from render.js BEFORE the tiering moved into
// @mnmal-ai/context-render, so the golden proves the move changed no byte.

const long =
  'Never print a line RANGE from a file that can hold secrets — judge by the ' +
  "file's CLASS (.env*, settings.local.json, ~/.store-keys/*, .npmrc, shell rc), " +
  'never a fixed list. Grep named keys instead. If a secret reaches the transcript, ' +
  'say so and name what rotating it needs.';

export const RULES = [
  {
    shortId: 3,
    rule: 'never commit to main; always branch',
    category: 'git',
    severity: 'must',
    pinned: true,
    synopsis: 'branch, never main',
    rationale: 'history'
  },
  {
    shortId: 53,
    rule: long,
    category: 'permissions',
    severity: 'must',
    pinned: false,
    synopsis: 'no secret line ranges',
    rationale: 'leak'
  },
  {
    shortId: 54,
    rule: 'an unattended process signs as itself',
    category: 'identity',
    severity: 'must',
    synopsis: 'sign as yourself'
  },
  { shortId: 10, rule: 'style must rule', category: 'style', severity: 'must' },
  { shortId: 11, rule: 'uncategorised must rule', severity: 'must', rationale: '' },
  {
    shortId: 20,
    rule: 'mcp call style: never echo payloads in chat',
    category: 'communication',
    severity: 'should',
    pinned: true,
    synopsis: 'no payload echo',
    rationale: 'noise'
  },
  {
    shortId: 21,
    rule: 'git pull request feature branch workflow for every change',
    category: 'git',
    severity: 'should',
    synopsis: 'PR every change'
  },
  { shortId: 22, rule: long, category: 'tooling', severity: 'should' },
  {
    shortId: 23,
    rule: 'run the store pg test suite against store_test only',
    category: 'testing',
    severity: 'should',
    synopsis: 'pg tests on store_test',
    rationale: 'prod wipe'
  },
  { shortId: 24, rule: 'widget gadget note', category: 'zeta-unranked', severity: 'should' },
  {
    shortId: 25,
    rule: 'keep responses concise',
    category: 'style',
    severity: 'should',
    pinned: true
  },
  { shortId: 26, rule: 'no severity set at all, about git branches', category: 'git' },
  {
    shortId: 27,
    rule: 'release branches are release/vX.Y.Z',
    category: 'git',
    severity: 'should',
    synopsis: 'release branch naming'
  }
];

const v = (...xs) => xs;
export const ANCHOR = v(1, 0, 0);
export const RULE_VECTORS = new Map([
  [21, v(0.1, 1, 0)],
  [22, v(0.2, 0, 1)],
  [23, v(1, 0.1, 0)],
  [24, v(0.9, 0.2, 0)],
  [27, v(0, 1, 0)]
]);

const CTX = 'git branch pull request release store test';

/** name → renderAgentRules options. Covers every production path plus the
 *  escape hatch and the combined (`only: 'all'`) salient render. */
export const CASES = {
  must: { only: 'must' },
  mustOtherNs: { only: 'must', ns: 'othernamespace' },
  shouldStructural: { only: 'should', salience: true, sessionContext: CTX, topK: 3 },
  shouldSemantic: {
    only: 'should',
    salience: true,
    sessionContext: CTX,
    topK: 2,
    anchorVector: ANCHOR,
    ruleVectors: RULE_VECTORS
  },
  shouldTopK0: { only: 'should', salience: true, sessionContext: CTX, topK: 0 },
  shouldTopKHuge: {
    only: 'should',
    salience: true,
    sessionContext: CTX,
    topK: 99,
    ns: 'othernamespace'
  },
  allSalient: { salience: true, sessionContext: CTX, topK: 2 },
  classic: {},
  classicShould: { only: 'should' }
};
