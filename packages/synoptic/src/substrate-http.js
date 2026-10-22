// HTTP client for the synoptic cold-start hook. No postgres dependency.
// All calls accept an injectable fetchImpl for testing.

import { frameErrors, unansweredFrames, unexpectedProjections } from './projection-audit.js';

const DEFAULT_TIMEOUT_MS = 3000;

function withTimeout(timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

/**
 * POST /substrate/v1/query. Returns the `data` map. Throws on non-2xx / network / timeout.
 *
 * The return shape deliberately ignores the server's `_diagnostics` sidecar.
 * Handing it back
 * alongside `data` would churn every caller and, worse, let the projection and
 * the statement of what it expects drift apart in different files. Instead the
 * call site declares `expectUnknown` right beside its `fields` block, and only
 * the residue reaches `onUnexpectedProjection`. See projection-audit.js for why
 * the residue — not the raw diagnostic — is the unit of alarm.
 *
 * `onDiagnostics` is the raw escape hatch, for callers that need the per-type
 * unknown sets to do their own cross-type comparison.
 *
 * `onPagination` receives the server's per-frame `_pagination` map
 * (`{ [key]: { hasMore, nextCursor } }`, `{}` when absent). A caller whose
 * answer depends on completeness pages on `nextCursor` until `hasMore` is false.
 */
export async function substrateQuery(substrateUrl, payload, opts = {}) {
  const {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    expectUnknown = [],
    onUnexpectedProjection = null,
    onDiagnostics = null,
    onFrameFailure = null,
    onPagination = null
  } = opts;
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${substrateUrl}/substrate/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });
    if (!res.ok) throw new Error(`substrate/query ${res.status}`);
    const json = await res.json();
    // Auditing must never cost a read. A malformed sidecar is a reason to
    // return the rows anyway, not to fail the cold-start.
    try {
      // A 200 is not success. A rejected frame arrives here with its key ABSENT
      // from `data` and the reason in `errors`, so `data[key] ?? []` downstream
      // renders an empty section and says nothing. Report
      // the server's reason where there is one, and fall back to this client's
      // own requested-vs-answered check where there is not.
      if (onFrameFailure !== null) {
        for (const e of frameErrors(json)) {
          onFrameFailure(e.key, `${e.code}: ${e.message}`);
        }
        for (const key of unansweredFrames(payload, json)) {
          onFrameFailure(key, 'requested but absent from `data`, with no error given');
        }
      }
      if (onDiagnostics !== null) onDiagnostics(json?._diagnostics ?? null);
      if (onUnexpectedProjection !== null) {
        const residue = unexpectedProjections(json, expectUnknown);
        if (residue.length > 0) onUnexpectedProjection(residue);
      }
    } catch {
      /* audit is best-effort */
    }
    // Outside the best-effort block: a caller paging for completeness must see its own errors.
    if (onPagination !== null) onPagination(json._pagination ?? {});
    return json.data ?? {};
  } finally {
    done();
  }
}

/**
 * Semantic recall. Returns hits[] (`{ id, score }`) when recall answered, or null when it did
 * not (semantic unavailable) — the contract callers already depend on.
 *
 * ## Why this is a frame query and not `POST /substrate/v1/recall`
 *
 * The kernel route 401s a valid agent token (see `substrateMutate`), and this
 * function's own `if (!res.ok) return null` turned that into "semantic
 * unavailable". The old comment named the hazard exactly — *"a persistent
 * misconfig (e.g. 401) looks the same as a transient gap"* — and then the
 * misconfig arrived and looked exactly like a transient gap, every session,
 * for as long as the hook has been signing.
 *
 * It was observable the whole time and nobody was reading the instrument: the
 * Agent Memory heading renders as `(from cortext/Memory — N total, M top)`
 * when recall is unavailable and `(hybrid recall — RRF, unified)` when it is
 * not. Live cold-starts have been printing the former.
 *
 * `recall/Hit` runs through frame dispatch, which authenticates correctly.
 *
 * ## Two shape notes that will bite anyone editing this
 *
 * The frame names the query parameter `to`, not `query`. And a REJECTED frame
 * arrives as HTTP 200 with its key absent from `data` — so the null return
 * below is driven by key PRESENCE, never by an empty array, which is a true
 * negative and must stay distinguishable from a refusal.
 *
 * `boost` is left unset by default, which means the server's default — ON.
 * Recall reinforcing what it MATCHED is the founding "recall what you use"
 * signal, and unlike a ranking fetch, the result set here really
 * is the evidence. So restoring this restores real salience accumulation on
 * Memory / SessionLog / Decision, absent for the same reason. A caller that is
 * DIAGNOSING rather than using passes `boost: false` — the audit's probe does,
 * because an instrument that reinforces what it matched would alter the signal
 * it is reporting on.
 */
export async function recall(substrateUrl, opts = {}) {
  const {
    query,
    namespace,
    type,
    k = 60,
    threshold,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onFrameFailure = null,
    boost,
    where
  } = opts;
  const key = 'recall/Hit';
  const params = { to: query, namespace, type, k };
  if (threshold !== undefined) params.threshold = threshold;
  // A row filter applied inside every candidate source, so k fills with rows in
  // scope. A server that predates it refuses the frame; the caller decides
  // whether to ask again without it.
  if (where !== undefined) params.where = where;
  // Passed ONLY when a caller asks. Omitted, the server's default applies, and
  // for a real session that default is what we want. `boost: false` exists for
  // probes — a diagnostic that reinforces what it matched would alter the very
  // signal it is reporting on.
  if (boost !== undefined) params.boost = boost;
  try {
    const data = await substrateQuery(
      substrateUrl,
      { [key]: { params, fields: { id: true, score: true } } },
      { fetchImpl, timeoutMs, onFrameFailure }
    );
    // Presence, not emptiness. `data[key] ?? []` would read a refusal — no
    // embedder, a denied read scope, an unauthenticated caller — as "nothing
    // matched", which is the whole class of bug this transport swap fixes.
    if (!Object.hasOwn(data, key)) return null;
    return Array.isArray(data[key]) ? data[key] : null;
  } catch {
    // Transport-level failure (non-2xx, network, timeout). Recall is a
    // best-effort enhancement and must never break a cold-start, so this still
    // degrades to structural — but a FRAME-level refusal no longer lands here
    // silently; it reaches onFrameFailure with the server's own reason.
    return null;
  }
}

/**
 * GET /substrate/v1/embed-stats. Returns the parsed body plus `reachable: true`, or
 * `{ reachable: false, reason }` when the probe could not run.
 *
 * ## Why `reachable` and not the old `{ enabled: false }`
 *
 * This returned `{ enabled: false }` on every failure path — a timeout, a
 * dead box, a 503 and a server that genuinely has the embedder switched off
 * all produced the same object. That is the conflation `auditSemanticRecall`
 * already refuses one module over: *"recall does not answer" is a verified
 * fault; "the server is down" is a check that could not run, and those must
 * never render alike.*
 *
 * It cost nothing while nothing called this. It stops costing nothing the
 * moment the cold-start header reads it, because "dense arm off" would then be
 * printed on the evidence of a dropped connection — trading the overclaim this
 * probe was wired up to fix for an underclaim of equal dishonesty.
 *
 * The body is spread UNCHANGED: a field the server did not send stays absent,
 * so `describeRecallArms` can tell a server predating `lexicalEnabled` from one
 * reporting the arm off. Do not default the lexical fields in here.
 */
export async function probeEmbedStats(substrateUrl, opts = {}) {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${substrateUrl}/substrate/v1/embed-stats`, { signal });
    if (!res.ok) return { reachable: false, reason: `embed-stats ${res.status}` };
    return { reachable: true, ...(await res.json()) };
  } catch (err) {
    return { reachable: false, reason: err?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    done();
  }
}

/**
 * GET /substrate/v1/whoami — what this credential ACTUALLY holds.
 *
 * ## Why the server has to be asked
 *
 * The obvious shortcut is to read our own token, and it does not work.
 * `agent-auth.js` mints `ns: ['*'], capabilities: ['read','mutate']` as a fixed
 * CLAIM, and substrate intersects that claim with what the kid's _system/Key row
 * actually grants. whoami returns the POST-INTERSECTION view — substrate's own
 * comment on the route says it exists because *"a caller currently cannot
 * distinguish 'my key is registered but scoped to a different namespace' from
 * 'the peer is down'"*.
 *
 * So the one artifact held locally is precisely the one that cannot answer the
 * question, because it is the request rather than the grant. A client that
 * trusted its own token would report `*` for every identity in the fleet,
 * including the one that is scoped to a single namespace and silently losing
 * hybrid recall.
 *
 * ## The shape changed too, and the new field is the valuable half
 *
 * Old: a bare `authenticated: false` meaning BOTH "this deployment verifies
 * nothing" and "auth is on and your credential never arrived". New:
 *
 *     { authEnabled: boolean, identity: null | { id, capabilities, namespaces } }
 *
 * Those two states have completely different fixes — a deployment posture the
 * caller cannot change, versus env vars that never took effect — and the old
 * shape could not express the second at all — and on a reads-open stack, where
 * an authenticated read and an anonymous one are byte-identical, that state
 * can persist unnoticed.
 *
 * This function maps the response onto flat `authenticated` / `id` /
 * `capabilities` / `namespaces` fields. A response without `authEnabled` maps
 * it to `null` — never `false`, which would report a verifying deployment as
 * one that verifies nothing.
 *
 * ## Failure shapes are kept distinct on purpose
 *
 * The point is that a check which cannot tell "did not ask" from
 * "asked, and the answer is bad" reports the second as the first:
 *
 *   { ok: true,  authEnabled: true,  authenticated: true,  ... }
 *                                             the credential answered
 *   { ok: true,  authEnabled: false, authenticated: false }
 *                                             auth is DISABLED here; nothing is
 *                                             verified and presenting a
 *                                             credential would change nothing
 *   { ok: true,  authEnabled: true,  authenticated: false }
 *                                             auth is ON and this request
 *                                             carried no credential — OUR
 *                                             wiring, not the server's
 *   { ok: false, failed: '<reason>' }         unreachable, non-2xx, malformed
 *
 * A 401 lands in the last with `failed: 'whoami 401'`, and that is a POSITIVE
 * signal worth reading: a token was presented and REJECTED. substrate keeps that
 * distinct from anonymous deliberately — no token answers 200 with a null
 * identity, a bad token 401s — so this is the one case a revoked key produces.
 *
 * ## `capabilities: null` is now TWO different answers
 *
 * The grant is two-dimensional: a key holds
 * capabilities PER NAMESPACE, `{ cortext: ['read','mutate'], plane: ['read'] }`,
 * and `'*'` is a legal key. The flat `capabilities` field survives as a
 * compatibility view, and the whoami route sets it to `null` whenever no flat
 * list can be honest — the union would say the holder can `mutate` when they
 * can only mutate somewhere, and the intersection would under-report.
 *
 * So a `null` here means EITHER "this response shape is version skew" (the old
 * reading, still correct when nothing else arrived) OR "the grant is
 * per-namespace, and it is in the field beside this one". Those are opposite
 * findings: the first is a hole, the second is a more precise answer than the
 * flat field could ever carry. `grants` is what tells them apart, so it is
 * carried through rather than dropped — dropping it is what made the audit
 * report a correctly-answering 5.23.0 server as a shape it did not understand.
 *
 * `grants` is `null` when ABSENT, which is its own real state and not a
 * failure: substrate attaches it only to a dataset-backed verification, so a
 * file-registry key legitimately has none and its flat `capabilities` is the
 * whole truth about it.
 *
 * @returns {Promise<{ ok: boolean, authEnabled?: boolean|null,
 *                     authenticated?: boolean, id?: string|null,
 *                     capabilities?: string[]|null, namespaces?: string[]|null,
 *                     grants?: Record<string, string[]>|null,
 *                     failed?: string }>}
 */
export async function probeWhoami(substrateUrl, opts = {}) {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${substrateUrl}/substrate/v1/whoami`, { signal });
    // A 404 is a VERSION fact, not a credential fact, and the two must not
    // share a branch — `whoami 404` and `whoami 401` differ by one character
    // and by everything else.
    if (res.status === 404) {
      return { ok: false, failed: 'whoami 404: this server has no /substrate/v1/whoami route' };
    }
    if (!res.ok) return { ok: false, failed: `whoami ${res.status}` };
    const json = await res.json();
    const identity = json?.identity ?? null;
    if (identity === null) {
      return {
        ok: true,
        // Absent is not `false`. A server that answered without the field is a
        // shape this client does not understand, and reporting it as "verifies
        // nothing" would manufacture a security finding out of version skew.
        authEnabled: typeof json?.authEnabled === 'boolean' ? json.authEnabled : null,
        authenticated: false
      };
    }
    return {
      ok: true,
      authEnabled: typeof json?.authEnabled === 'boolean' ? json.authEnabled : null,
      authenticated: true,
      id: typeof identity.id === 'string' ? identity.id : null,
      // Absent is NOT empty. The route defaults both to `[]` itself, so an
      // absent field here means a response shape this client does not
      // understand — surfaced as a failure rather than as "holds nothing",
      // which would read as a maximally-scoped identity.
      //
      // `capabilities` has a SECOND null, and it is not a
      // failure — see the `grants` note below.
      capabilities: Array.isArray(identity.capabilities) ? identity.capabilities : null,
      namespaces: Array.isArray(identity.namespaces) ? identity.namespaces : null,
      grants: asGrants(identity.grants)
    };
  } catch (e) {
    return { ok: false, failed: e?.message ?? 'whoami unreachable' };
  } finally {
    done();
  }
}

/**
 * The per-namespace grant, or `null` if this response does not carry one.
 *
 * Validated rather than trusted, because a HALF-understood grant is worse than
 * none: every caller below decides `read` per namespace from this map, so one
 * entry arriving as a non-array would either throw mid-render or, worse, read
 * as "no capabilities there". Anything not of the exact `{ ns: string[] }`
 * shape is rejected WHOLE and falls back to the flat reading, which is the
 * behaviour that predates grants and is never wrong — only coarser.
 *
 * An empty object is deliberately NOT rejected. `intersectGrants` drops a
 * namespace that resolves to no capability, so `{}` is the real and reportable
 * state of a key whose claim and row share nothing.
 */
function asGrants(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const out = {};
  for (const [ns, caps] of Object.entries(raw)) {
    if (!Array.isArray(caps) || caps.some((c) => typeof c !== 'string')) return null;
    out[ns] = caps;
  }
  return out;
}

/**
 * POST /substrate/v1/mutate. Returns the `data` map. Throws on non-2xx / network / timeout.
 *
 * Exists because the plugin KERNEL ROUTES cannot authenticate an agent.
 * `mountKernelRoute` receives the host's undecorated `AuthConfig`, which has no
 * key registry, so a registry-resolved kid cannot be looked up and a perfectly
 * valid agent token is rejected as "present-but-invalid". Frame dispatch runs
 * inside `compose()`, which derives an auth config that DOES carry the registry
 * — so the same credential that 401s on `/substrate/v1/embeddings/fetch` verifies here.
 *
 * Measured, with a control that rules out a bad key:
 *
 *     /substrate/v1/query             GOOD token     200
 *     /substrate/v1/query             CORRUPT token  401   <- the verifier works
 *     /substrate/v1/embeddings/fetch  GOOD token     401
 *     /substrate/v1/embeddings/fetch  NO token       200
 *
 * The frame surface and the kernel routes delegate to ONE core per operation,
 * so this is a transport swap and not a behaviour change — verified against the
 * live server for all three: byte-identical response shapes, `boost: false` is
 * honoured, and a nonexistent ref still reports `applied: 0` with `missing[]`.
 *
 * Shares `substrateQuery`'s partial-success handling deliberately. A mutate frame
 * is rejected exactly the way a query frame is — 200, key ABSENT from `data`,
 * reason in `errors` — so a caller reading `data[key] ?? null` cannot tell a
 * refusal from a no-op. `onFrameFailure` is the seam that keeps that visible.
 */
export async function substrateMutate(substrateUrl, payload, opts = {}) {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, onFrameFailure = null } = opts;
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${substrateUrl}/substrate/v1/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });
    if (!res.ok) throw new Error(`substrate/mutate ${res.status}`);
    const json = await res.json();
    try {
      if (onFrameFailure !== null) {
        for (const e of frameErrors(json)) onFrameFailure(e.key, `${e.code}: ${e.message}`);
        for (const key of unansweredFrames(payload, json)) {
          onFrameFailure(key, 'requested but absent from `data`, with no error given');
        }
      }
    } catch {
      /* audit is best-effort */
    }
    return json.data ?? {};
  } finally {
    done();
  }
}
