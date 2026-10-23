// Surfacing for substrate's `_diagnostics.unknownProjectionFields` sidecar.
// `substrateQuery` returns `json.data`, so without this module no caller could
// see it even in principle.
//
// WHY THIS IS NOT JUST "WARN ON EVERY DIAGNOSTIC", which is what the upstream
// reference implementation (substrate-client) does: a single cold-start produces FOUR diagnostics, and THREE OF THEM ARE THE
// SYSTEM WORKING.
//
//   cortext/AnchorIntent  [intent]
//   cortext/Memory        [topic, choice, status, branch, summary]
//   cortext/Decision      [name, type, description, body, branch, summary]
//   cortext/SessionLog    [name, type, description, topic, choice, status]
//
// `recall-scoring.js` deliberately projects ONE union of handle fields across
// three heterogeneous types and keeps whichever come back non-null. Each type
// necessarily reports the other two's fields as unknown. `AnchorIntent.intent`
// is a legacy name feeding `synopsis ?? intent ?? body ?? ''`, where the null
// is what the fallback expects.
//
// A sink that warns on all four would print on every cold start for code that
// is correct — the failure this repo keeps re-learning (a warning that fires
// when nothing is wrong is one people learn to skip; see the fragment-drift
// digest check, which chose content over version for the same reason). So the
// unit of alarm here is the RESIDUE: diagnostics minus what the call site
// declared it expects.
//
// THE SHARP CHECK IS THE CROSS-TYPE ONE. An allowlist alone has no teeth on a
// union projection, because the allowlist necessarily contains every field
// that could legitimately go missing. What it cannot contain is a field that
// goes missing on EVERY type at once — a rename or a typo. Verified against
// the live data above: of the nine distinct union fields, every one is
// declared by at least one of the three types, so `unknownEverywhere` is
// currently empty and only stops being empty if something really moved.

/**
 * Residue for one response: fields substrate reported as undeclared that the call
 * site did not say to expect.
 *
 * @param {unknown} envelope Parsed /substrate/v1/query response.
 * @param {ReadonlyArray<string>} expectUnknown Field names this call site
 *   knowingly projects on types that may not declare them.
 * @returns {Array<{ key: string, fields: Array<string> }>}
 */
export function unexpectedProjections(envelope, expectUnknown = []) {
  const diagnostics =
    envelope !== null && typeof envelope === 'object' ? envelope._diagnostics : null;
  if (diagnostics === null || diagnostics === undefined || typeof diagnostics !== 'object') {
    return [];
  }
  const expected = new Set(expectUnknown);
  const out = [];
  for (const [key, entry] of Object.entries(diagnostics)) {
    const unknown = entry?.unknownProjectionFields;
    if (!Array.isArray(unknown)) continue;
    const residue = unknown.filter((f) => !expected.has(f));
    if (residue.length > 0) out.push({ key, fields: residue });
  }
  return out;
}

/**
 * Fields reported unknown by EVERY type observed, across a set of responses.
 *
 * The teeth of a union projection: a field absent from one type is the union
 * doing its job; a field absent from all of them was renamed, removed or
 * misspelled. Returns empty when fewer than two types were observed — a single
 * type cannot distinguish the two cases, which is what `expectUnknown` is for.
 *
 * @param {ReadonlyArray<{ key: string, unknown: ReadonlyArray<string> }>} observed
 * @returns {Array<string>}
 */
export function unknownEverywhere(observed) {
  if (observed.length < 2) return [];
  const [first, ...rest] = observed;
  let acc = new Set(first.unknown);
  for (const o of rest) {
    const here = new Set(o.unknown);
    acc = new Set([...acc].filter((f) => here.has(f)));
    if (acc.size === 0) break;
  }
  return [...acc].sort();
}

/**
 * Collector for one cold-start. Dedupes, and renders nothing at all when the
 * residue is empty — which is the normal case and the point of the design.
 *
 * Rendered as an HTML comment into the injected context rather than to stderr,
 * matching `agent-auth`'s `warning` and the backup/fragment watchdogs: the
 * reader who can act on it is the agent, and nobody reads a hook's stderr.
 */
export function createProjectionAudit() {
  /** @type {Map<string, Set<string>>} */
  const byKey = new Map();
  /** @type {Map<string, string>} */
  const failures = new Map();

  return {
    /** Sink for `substrateQuery`'s `onUnexpectedProjection`. */
    record(entries) {
      for (const { key, fields } of entries) {
        const set = byKey.get(key) ?? new Set();
        for (const f of fields) set.add(f);
        byKey.set(key, set);
      }
    },
    /** Record a cross-type finding, which has no single frame key. */
    recordEverywhere(fields) {
      if (fields.length === 0) return;
      const set = byKey.get('(all recall types)') ?? new Set();
      for (const f of fields) set.add(f);
      byKey.set('(all recall types)', set);
    },
    /**
     * Sink for a frame the server rejected, or one this client asked for and
     * did not get back. No allowlist: neither is ever correct by design.
     */
    recordFailure(key, detail) {
      // First reason wins — the server's own message beats our inferred
      // "unanswered", which is the weaker observation of the same event.
      if (!failures.has(key)) failures.set(key, detail);
    },
    /** @returns {string} '' when clean. */
    render() {
      if (byKey.size === 0 && failures.size === 0) return '';
      let out = '';
      // Failures first and unmissable. A dropped frame means a WHOLE SECTION is
      // absent from everything below, so it outranks the content it is missing
      // from — and unlike projection drift it is never expected.
      if (failures.size > 0) {
        const f = [...failures.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, detail]) => `${key} — ${detail}`);
        out +=
          `> ⚠️  **Cold-start is INCOMPLETE.** ${failures.size} ` +
          `${failures.size === 1 ? 'query was' : 'queries were'} rejected, so the ` +
          `corresponding ${failures.size === 1 ? 'section is' : 'sections are'} ` +
          `MISSING below rather than empty. Do not read their absence as "nothing ` +
          `recorded": ${f.join(' | ')}\n\n`;
      }
      if (byKey.size > 0) {
        const lines = [...byKey.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, fields]) => `${key}: ${[...fields].sort().join(', ')}`);
        out += `<!-- projection drift: fields the schema does not declare, beyond those this cold-start expects — ${lines.join(' | ')} -->\n`;
      }
      return out;
    }
  };
}

// ---------------------------------------------------------------------------
// Frame errors — the SECOND thing this client was dropping, and the worse one.
//
// substrate returns a GraphQL-shaped partial-success envelope: one frame in a
// multi-frame query can fail while its siblings succeed, so a single status
// code cannot carry the answer. That is a deliberate and defensible design.
//
// The hazard is on the READER. A rejected frame comes back as:
//
//     HTTP 200
//     data:   { }                 <- the key is ABSENT, not empty
//     errors: [{ code, message, path }]
//
// and this repo's every call site does `data[key] ?? []`. One sabotaged
// frame's orderBy would drop the rule index while the cold-start still
// rendered as though nothing had happened.
//
// WHY THIS NEEDS NO ALLOWLIST, unlike the projection diagnostics above. Three
// of the four diagnostics a cold-start produces are correct by design, so the
// unit of alarm there had to be the residue. A frame error is never correct by
// design — it means a query this code sent was rejected. Every one is worth
// surfacing, so there is nothing to declare and nothing to tune.
//
// AND THE PRIMARY CHECK IS THE POSITIVE ONE. `errors` is the server telling
// you; `unansweredFrames` is this client checking its own work — every key it
// ASKED for should come back in `data`. That catches a dropped frame even if
// the envelope carried no error at all (an `in` on a crossRef can return `[]`,
// no error, and read as a true negative). Same instinct as preferring a resolved-version
// enumeration over `grep -c`: assert what should be there, don't count what
// should be gone.

/**
 * Frame keys the request asked for that the response did not answer.
 *
 * @param {Record<string, unknown>} payload The query frame that was sent.
 * @param {unknown} envelope The parsed response.
 * @returns {Array<string>}
 */
export function unansweredFrames(payload, envelope) {
  if (payload === null || typeof payload !== 'object') return [];
  const data = envelope !== null && typeof envelope === 'object' ? (envelope.data ?? null) : null;
  const answered =
    data !== null && typeof data === 'object' ? new Set(Object.keys(data)) : new Set();
  return Object.keys(payload).filter((k) => !answered.has(k));
}

/**
 * The envelope's `errors`, normalised to `{ key, code, message }`.
 *
 * `path[0]` is the frame key for a frame-scoped rejection; an error without one
 * is envelope-level and reported under '(request)'.
 *
 * @param {unknown} envelope
 * @returns {Array<{ key: string, code: string, message: string }>}
 */
export function frameErrors(envelope) {
  const errs = envelope !== null && typeof envelope === 'object' ? envelope.errors : null;
  if (!Array.isArray(errs)) return [];
  return errs.map((e) => ({
    key: typeof e?.path?.[0] === 'string' ? e.path[0] : '(request)',
    code: typeof e?.code === 'string' ? e.code : 'error',
    message: typeof e?.message === 'string' ? e.message : String(e)
  }));
}
