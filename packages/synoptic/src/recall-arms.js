// What the cold-start is ENTITLED to say about hybrid recall.
//
// ## Why
//
// `recall-scoring.js` derives one boolean from three `recall/Hit` frames:
//
//     const recallAvailable = perType.some((p) => p.recallRows !== null);
//
// A header claiming `hybrid recall` on that boolean asserts WHICH ARMS RAN
// from a fact that only establishes that rows came back: with the dense arm
// dark and the lexical arm answering, it would claim hybrid over a
// lexical-only ranker. A degradation path that is correct, silent
// and permanent is indistinguishable from working software; so is an
// instrument that names a branch it did not check.
//
// ## What this can and cannot establish
//
// `GET /substrate/v1/embed-stats` reports which arms are WIRED and which types they
// are DECLARED for. It does not report which arms answered a given query, and
// nothing on the frame surface does either. A per-request `arms` envelope
// would not help here: three recall frames collapse into the one boolean
// above, so there is no per-query decision to feed. Coverage (are the rows
// actually indexed) is not reported either.
//
// So the honest claim is about configuration, and `evidence` says so in the
// render rather than leaving the reader to assume otherwise.
//
// ## The rule that keeps it honest
//
// An arm is reported `wired` only when the server said so. Every other state
// is `unknown`, NEVER `off`. A missing `lexicalEnabled` means a server that
// predates the field — and reading absent as false would be the
// same conflation this module exists to remove.

/** An arm is only `wired` when the server said so; absent evidence is `unknown`. */
function armState(enabledFlag, declared, namespace, types) {
  // Absent, not false. A server predating the field reports neither.
  if (enabledFlag === undefined || enabledFlag === null) return 'unknown';
  if (enabledFlag !== true) return 'off';
  if (!Array.isArray(declared)) return 'unknown';
  const have = new Set(declared.filter((d) => d?.namespace === namespace).map((d) => d?.type));
  const covered = types.filter((t) => have.has(t)).length;
  if (covered === 0) return 'off';
  return covered === types.length ? 'wired' : 'partial';
}

/**
 * `only` answers WHICH arm is wired, and a reader takes it to mean that arm
 * covered the query — so a `partial` arm has to say so where it is named.
 * Wired and partial do not share these branches: shared, they would disclose
 * `partial` in the header for `partial + wired` and swallow it for
 * `partial + off`.
 */
function onlyLabel(arm, state) {
  return state === 'partial'
    ? `recall — RRF, ${arm} arm only, partial coverage`
    : `recall — RRF, ${arm} arm only`;
}

function labelFor(dense, lexical) {
  if (dense === 'unknown' || lexical === 'unknown') return 'recall — RRF, arms unverified';
  if (dense === 'wired' && lexical === 'wired') return 'hybrid recall — RRF, unified';
  if (dense === 'off' && lexical === 'off') return 'recall — RRF, no arm reported wired';
  // Past the guards above, neither arm is unknown and at most one is off — so
  // the arm that is not off is wired or partial, with no third possibility.
  if (lexical === 'off') return onlyLabel('dense', dense);
  if (dense === 'off') return onlyLabel('lexical', lexical);
  return 'recall — RRF, arms partial';
}

function evidenceFor(dense, lexical, namespace, types) {
  if (dense === 'unknown' && lexical === 'unknown') {
    // No clause about whether recall ran: the same sentence reaches both the
    // unified path and the structural fallback, which exists because recall
    // did not. The sentence describes
    // the PROBE, and the caller's situation is the caller's to state.
    return `arms not established — /substrate/v1/embed-stats did not answer, or predates the lexical fields. Which arms are wired is unverified. This says nothing about configuration, only that it could not be read.`;
  }
  const scope = `${namespace}: ${types.join(', ')}`;
  // Names the TERRITORY, not the instrument. "this probe only shows
  // configuration" implies a better probe would settle it, and none exists or
  // is coming — see the header comment. A permanent bound stated as an
  // instrument limitation is a false implicature: nothing untrue, and it sends
  // the reader looking for a measurement that is not there.
  return `dense ${dense}, lexical ${lexical} for ${scope} — from GET /substrate/v1/embed-stats. Nothing records which arm answered a given query, so configuration is the strongest claim available, not a gap awaiting a better probe.`;
}

/**
 * Describe the recall arms the cold-start may honestly name.
 *
 * @param {object} p
 * @param {object|null} p.stats      `probeEmbedStats` result, or null if not probed.
 * @param {string} p.namespace       Namespace the cold-start queries.
 * @param {string[]} p.types         Types the cold-start sends recall frames for.
 * @returns {{ dense: string, lexical: string, label: string, evidence: string }}
 *   `dense`/`lexical` are one of `wired` | `partial` | `off` | `unknown`.
 *   `label` is the header text; it says `hybrid` only when both arms are wired
 *   for every queried type. `evidence` states what the probe established.
 */
export function describeRecallArms({ stats, namespace, types }) {
  const unreachable = stats === null || stats === undefined || stats.reachable === false;
  const dense = unreachable
    ? 'unknown'
    : armState(stats.enabled, stats.embeddedTypes, namespace, types);
  const lexical = unreachable
    ? 'unknown'
    : armState(stats.lexicalEnabled, stats.lexicalTypes, namespace, types);
  return {
    dense,
    lexical,
    label: labelFor(dense, lexical),
    evidence: evidenceFor(dense, lexical, namespace, types)
  };
}
