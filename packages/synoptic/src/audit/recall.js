// Whether recall and the salient rule tier actually rank semantically on this box.

import { check } from './check.js';

/**
 * Does the salient tier actually RANK SEMANTICALLY — right now, on this box?
 *
 * ## Why a live read rather than the cold-start's boost result
 *
 * The audit runs in a separate process from the cold-start and never has a
 * boost result to read. So this asks the question the other way round. Instead
 * of reporting
 * on a write that happened elsewhere, it performs the READ half live and checks
 * whether the ranker's inputs are actually obtainable. That is a measurement of
 * the current box rather than a claim about a past run, and — boost-on-fetch
 * being opt-in — fetching vectors writes nothing, so it belongs in a read-only
 * mode.
 *
 * ## Why "wired" was never the question
 *
 * `rankRules` short-circuits to structural when either the anchor vector or the
 * rule vectors are missing, and returns a perfectly good structural ranking
 * when it does. Nothing downstream can tell the two apart: a signed call the
 * server refuses, swallowed by design, leaves every instrument individually
 * correct while the feature is dead.
 *
 * So the assertion has to be about EFFECT, not configuration. Same distinction
 * as `applied` against `requested`, and as frame PRESENCE against emptiness.
 *
 * @param {{ probe: { vectors: Map<string, number[]>, failed: string|null },
 *           activeRuleIds: ReadonlyArray<string>,
 *           anchorId: string|null }} p
 *   `probe.failed` carries the server's own reason when the fetch could not be
 *   performed, and null when it was. An empty `vectors` map with `failed: null`
 *   is a real answer — nothing is embedded — and must not read as a hole.
 */
export function auditSalientTier({ probe, activeRuleIds, anchorId, anchorHistory = null }) {
  if (probe.failed !== null) {
    return [
      check(
        'salient.rank',
        'unknown',
        'could not fetch rule vectors, so whether ranking is semantic is unknown',
        `${probe.failed} — the fetch fails, the ranker silently falls back to structural, and the render looks fine`
      )
    ];
  }

  const out = [];
  const withVector = activeRuleIds.filter((id) => probe.vectors.has(id));
  const unembedded = activeRuleIds.filter((id) => !probe.vectors.has(id));

  if (activeRuleIds.length === 0) {
    out.push(
      check(
        'salient.rank',
        'unknown',
        'no active rules to rank',
        'nothing to measure — an empty rule set cannot demonstrate that ranking works'
      )
    );
    return out;
  }

  // The load-bearing line. Both inputs, or the ranker short-circuits.
  const anchorVectorPresent = anchorId !== null && probe.vectors.has(anchorId);
  if (withVector.length > 0 && anchorVectorPresent) {
    out.push(
      check(
        'salient.rank',
        'ok',
        `ranking is SEMANTIC: ${withVector.length}/${activeRuleIds.length} rules and the anchor both have vectors`
      )
    );
  } else if (anchorId === null) {
    // "No anchor" has two causes with different remediations, and the
    // single WARN read as a fault in both. A repo that has NEVER had one is in
    // the normal post-onboarding state — /substrate-setup does not seed an anchor —
    // so the reader needs to know this is an outstanding onboarding step rather
    // than something that broke. A repo whose anchors are all archived had one
    // and retired it, which is a different thing to fix.
    //
    // Neither is fixed by seeding a placeholder, and the detail says so:
    // rankRules scores rules against the ANCHOR'S OWN VECTOR, so a generic
    // "onboarded this repo" anchor is not a neutral default — it is semantic
    // noise aimed at the whole rule set, trading a visible accurate WARN for a
    // silent degraded ranker.
    const base =
      'rankRules needs an anchor vector to score against — with none, the semantic half cannot run even when every rule is embedded';
    const notPlaceholder =
      'Write a real one describing what this repo is actually for; a placeholder is worse than none, because the ranker scores against the anchor’s own vector and would then rank against noise instead of falling back honestly';
    if (anchorHistory === 'none') {
      out.push(
        check(
          'salient.rank',
          'warn',
          'this project has NEVER had an anchor, so ranking falls back to structural',
          `${base}. /substrate-setup does not seed one, so this is an outstanding onboarding step rather than a fault. ${notPlaceholder}`
        )
      );
    } else if (anchorHistory === 'archived') {
      out.push(
        check(
          'salient.rank',
          'warn',
          'every anchor for this project is ARCHIVED, so ranking falls back to structural',
          `${base}. This repo had an anchor and retired it — the focus it described is over and nothing replaced it. ${notPlaceholder}`
        )
      );
    } else {
      out.push(
        check(
          'salient.rank',
          'warn',
          'no anchor, so ranking falls back to structural regardless of the rule vectors',
          `${base} — and whether this project ever had one was not established, so it is unclear if this is a fresh repo or a retired focus`
        )
      );
    }
  } else if (!anchorVectorPresent) {
    out.push(
      check(
        'salient.rank',
        'warn',
        'the anchor has no embedding row, so ranking falls back to structural',
        'the whole rule set can be embedded and this still short-circuits — the anchor is the other half of the comparison, and it is the half nobody thinks to check'
      )
    );
  } else {
    out.push(
      check(
        'salient.rank',
        'warn',
        `no active rule has an embedding row (0/${activeRuleIds.length}), so ranking is structural-only`,
        'the corpus was never embedded, or the embed hook is not running for AgentRule'
      )
    );
  }

  // Subsumes what the old write-side `missing[]` reported, and detects the same
  // population — a row with no embedding row cannot be boosted and cannot be
  // fetched — but without performing a write to find out.
  if (unembedded.length > 0 && withVector.length > 0) {
    out.push(
      check(
        'salient.embedded',
        'warn',
        `${unembedded.length} active rule(s) have NO embedding row: ${unembedded.join(', ')}`,
        'a rule that exists but was never embedded can still be promoted and can never be ranked semantically — it sits in the structural half invisibly'
      )
    );
  }

  return out;
}

/**
 * Is semantic recall reachable at all?
 *
 * One line. The cold-start
 * already renders the answer — `## Agent Memory (hybrid recall — RRF, unified)`
 * when recall answers, `## Agent Memory (from <ns>/Memory — N total, M top)`
 * when it does not — but nobody reads the heading.
 *
 * A degradation path that is correct, silent, and permanent is indistinguishable
 * from working software. The only fix is an instrument that states which branch
 * was taken, rather than one that reports faults.
 *
 * ## Why this needs `reachable` and cannot infer it
 *
 * `recall` returns null for a refusal AND for an unreachable server — the
 * two are deliberately merged there, because a cold-start's response to both is
 * the same: degrade to structural. An audit's response is NOT the same. "Recall
 * does not answer" is a verified fault; "the server is down" is a check that
 * could not run, and this module's one rule is that those must never render
 * alike. Reported as a warn on an unreachable box, this line would assert a
 * defect it never observed — the false-confidence bug inverted, which is no
 * better for being loud instead of quiet.
 *
 * With the server up this branch is unreachable, so test it against a dead
 * port.
 *
 * @param {{ answered: boolean, reachable: boolean, reason: string|null }} p
 */
export function auditSemanticRecall({ answered, reachable, reason, credentialAttributed = true }) {
  // Recall answering is a fact about the CREDENTIAL that asked. A repo
  // whose grant omits `recall` degrades silently while the auditor's
  // credential answers fine, so a probe signed by someone else reports the
  // auditor's ranker as the target's — in whichever direction flatters.
  if (!credentialAttributed) {
    return [
      check(
        'recall.available',
        'unknown',
        'recall was probed with a credential that is not established as this target’s',
        'whether hybrid recall answers depends on the asking credential’s namespace grant, so this probe answers for the auditor. See the authority section — the same substitution, one section up.'
      )
    ];
  }
  if (answered) {
    return [
      check('recall.available', 'ok', 'semantic recall answers — Agent Memory renders hybrid')
    ];
  }
  if (!reachable) {
    return [
      check(
        'recall.available',
        'unknown',
        'could not reach the server, so whether recall answers is unknown',
        `${reason ?? 'no reason given'} — an unreachable server is a check that did not run, not a recall fault`
      )
    ];
  }
  return [
    check(
      'recall.available',
      'warn',
      'semantic recall does NOT answer — Agent Memory silently degrades to structural',
      `${reason ?? 'no reason given'} — this is a correct, silent, permanent fallback, which is why it went unnoticed: the render looks complete and simply carries a different heading`
    )
  ];
}
