#!/usr/bin/env node
// Evaluate what the SEMANTIC half of rule ranking actually changes.
//
//   node scripts/eval-rule-salience.mjs [--anchor <shortId>] [project] [substrateUrl]
//
// Turning RULE_SALIENCE on before the ranking is worth trusting ships a
// cosmetic change presenting itself as semantic relevance. This ranks the real
// rule set both ways against the real anchor and prints the DIFFERENCE.
//
// The structural caveat: THE ANCHOR EMBEDS WHAT
// A SESSION IS ABOUT, WHILE RULE USEFULNESS IS ABOUT WHAT YOU SHOULD DO. Topic
// and behaviour are different axes that correlate weakly, so anchor-cosine
// tends to promote topically-adjacent rules over behaviourally-apt ones.
//
// Re-run this before flipping the flag. Enable it when the promoted set is
// consistently better than the dropped set on a session you can judge.

import { createAgentAuth, makeSignedFetch } from '../packages/synoptic/src/agent-auth.js';
import { resolveAnchorHttp } from '../packages/synoptic/src/anchor.js';
import { buildRuleSessionContext } from '../packages/synoptic/src/render.js';
import {
  fetchRowVectors,
  toRefs,
  toShortIdVectors
} from '../packages/synoptic/src/rule-vectors.js';
import { rankRules } from '../packages/synoptic/src/scoring/rule-salience.js';
import { substrateQuery } from '../packages/synoptic/src/substrate-http.js';

// `--anchor <shortId>` pins the anchor instead of resolving the current one.
//
// With only the live anchor there is one sample per session. Pinning it lets
// you sweep anchors in one sitting: the rule set is fixed, so varying the
// anchor varies the only input that matters.
const rawArgs = process.argv.slice(2);
const anchorFlagAt = rawArgs.indexOf('--anchor');
const ANCHOR_SHORT_ID = anchorFlagAt === -1 ? null : Number(rawArgs[anchorFlagAt + 1]);
const positional = rawArgs.filter((a, i) => !a.startsWith('--') && i !== anchorFlagAt + 1);
const PROJECT = positional[0] ?? 'synoptic';
const URL = positional[1] ?? process.env.SUBSTRATE_URL;
if (!URL) {
  console.error(
    'usage: node scripts/eval-rule-salience.mjs [project] <substrateUrl> (or SUBSTRATE_URL)'
  );
  process.exit(2);
}
const NS = process.env.SUBSTRATE_NAMESPACE ?? 'cortext';

// SIGN, like the cold-start does: an evaluation harness that reaches the
// server differently from the thing it evaluates is measuring something else.
const auth = createAgentAuth(process.env);
if (auth.warning !== null) {
  console.error(`identity misconfigured: ${auth.warning}`);
  console.error('refusing to fall back to anonymous — see the note above.');
  process.exit(2);
}
const fetchImpl = makeSignedFetch(auth.getAuthHeader);

// Collected, not swallowed. `fetchRowVectors` degrades to an empty map by
// design — right for a cold-start, wrong here, because a MEASUREMENT TOOL AND A
// COLD-START HAVE OPPOSITE OBLIGATIONS on the same function: one must never
// fail, the other must never guess. The abort below is the same posture as the
// audit's `unknown` state — not verified is not a result.
/** @type {Array<string>} */
const frameFailures = [];
const onFrameFailure = (k, d) => frameFailures.push(`${k}: ${d}`);

// `substrateQuery` THROWS on transport failure (non-2xx, network, timeout) —
// unlike `fetchRowVectors`, which swallows. Caught below and reported as the
// same abort as every other could-not-measure case.
const data = await substrateQuery(
  URL,
  {
    [`${NS}/AgentRule`]: {
      params: {
        where: { archived: { eq: false }, active: { eq: true }, project: { in: [PROJECT, null] } },
        limit: 200
      },
      fields: {
        id: true,
        shortId: true,
        rule: true,
        category: true,
        severity: true,
        pinned: true,
        synopsis: true
      }
    },
    [`${NS}/Todo`]: {
      params: {
        where: {
          archived: { eq: false },
          project: { in: [PROJECT, null] },
          status: { nin: ['done', 'closed'] }
        },
        limit: 50
      },
      fields: { shortId: true, title: true, status: true, priority: true, area: true }
    }
  },
  { fetchImpl, onFrameFailure }
).catch((err) => {
  console.error(`CANNOT MEASURE — ${URL} did not answer: ${String(err?.message ?? err)}`);
  console.error('Nothing was compared. This is an aborted run, not a null result.');
  process.exit(2);
});
const rules = (data[`${NS}/AgentRule`] ?? []).filter(
  (r) => r.severity !== 'must' && r.pinned !== true
);
const todos = data[`${NS}/Todo`] ?? [];
async function pinnedAnchor(shortId) {
  for (const type of ['AnchorIntent', 'SessionLog']) {
    const key = `${NS}/${type}`;
    const d = await substrateQuery(
      URL,
      {
        [key]: {
          params: { where: { shortId: { eq: shortId } }, limit: 1 },
          fields: { id: true, shortId: true, synopsis: true }
        }
      },
      { fetchImpl, onFrameFailure }
    );
    const row = (Object.hasOwn(d, key) ? d[key] : [])[0];
    if (row !== undefined) return { anchor: { id: row.id, body: row }, anchorType: type };
  }
  console.error(`CANNOT MEASURE — no AnchorIntent or SessionLog #${shortId}.`);
  process.exit(2);
}

const resolved =
  ANCHOR_SHORT_ID === null
    ? await (async () => {
        const a = await resolveAnchorHttp({
          substrateUrl: URL,
          namespace: NS,
          projectSlug: PROJECT,
          fetchImpl,
          onFrameFailure
        });
        return {
          anchor: a,
          anchorType: (a?.source ?? 'sessionlog') === 'intent' ? 'AnchorIntent' : 'SessionLog'
        };
      })()
    : await pinnedAnchor(ANCHOR_SHORT_ID);
const { anchor, anchorType } = resolved;
const [aVecs, rVecs] = await Promise.all([
  fetchRowVectors(URL, toRefs([anchor], NS, anchorType), { fetchImpl, onFrameFailure }),
  fetchRowVectors(URL, toRefs(rules, NS, 'AgentRule'), { fetchImpl, onFrameFailure })
]);
const anchorVector = aVecs.get(anchor.id) ?? null;
const ruleVectors = toShortIdVectors(rules, rVecs);
const ctx = buildRuleSessionContext(todos);

// A missing vector on either side means the semantic branch SHORT-CIRCUITS and
// what follows would be structural twice over, so it is stated rather than
// left to be inferred from identical output.
if (anchorVector === null || ruleVectors.size === 0) {
  console.log('NO SEMANTIC RANKING POSSIBLE — anchor vector or rule vectors missing.');
  console.log('rankRules short-circuits to structural-only; any comparison below would be');
  console.log('the same list twice, which is why this aborts rather than printing one.');
  // Say WHY: a diagnostic naming the wrong component is worse than none.
  console.log(
    frameFailures.length > 0
      ? `\nframe failures:\n  ${frameFailures.join('\n  ')}`
      : '\nNo frame failure was reported, so the rows are most likely unembedded rather than' +
          '\nunreachable. Check that the embed hook runs for AgentRule and for the anchor type.'
  );
  process.exit(2);
}
// Non-fatal failures still get said. A partially embedded rule set degrades
// per-rule and the comparison below stays meaningful — but on a REDUCED
// population, which changes what the result licenses you to conclude.
if (frameFailures.length > 0) {
  console.log(`WARNING — ${frameFailures.length} frame failure(s) during fetch:`);
  for (const f of frameFailures) console.log(`  ${f}`);
}
console.log(
  `unpinned should-rules: ${rules.length} | vectors: ${ruleVectors.size}/${rules.length} | anchor vector: yes | signed as ${process.env.SUBSTRATE_AGENT_KEY_ID ?? '(anonymous)'}`
);
console.log(`anchor: ${anchorType} #${anchor.body?.shortId ?? anchor.id}`);
const s = rankRules(rules, { sessionContext: ctx }).map((r) => r.shortId);
const m = rankRules(rules, { sessionContext: ctx, anchorVector, ruleVectors }).map(
  (r) => r.shortId
);
const byId = new Map(rules.map((r) => [r.shortId, r]));
const short = (id) =>
  (byId.get(id)?.synopsis ?? byId.get(id)?.rule ?? '').replace(/\s+/g, ' ').slice(0, 68);
console.log(`\nTOP 5  structural-only -> semantic\n`);
for (let i = 0; i < 5; i++)
  console.log(
    `  ${i + 1}. #${String(s[i]).padEnd(3)} -> #${String(m[i]).padEnd(3)}  ${short(m[i])}`
  );
const promotedIn = m.slice(0, 5).filter((x) => !s.slice(0, 5).includes(x));
const droppedOut = s.slice(0, 5).filter((x) => !m.slice(0, 5).includes(x));
console.log(
  `\n  semantic PROMOTED into top5: ${promotedIn.map((x) => '#' + x).join(', ') || '(none)'}`
);
for (const x of promotedIn) console.log(`      #${x}  ${short(x)}`);
console.log(
  `  semantic DROPPED from top5:  ${droppedOut.map((x) => '#' + x).join(', ') || '(none)'}`
);
for (const x of droppedOut) console.log(`      #${x}  ${short(x)}`);
