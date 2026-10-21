// What only the server can answer: the identity directory, this credential's
// own grant (whoami), and whether the salient tier and recall rank semantically.

import { auditSalientTier, auditSemanticRecall, check, credentialIsTargets } from '../audit.js';
import { fetchRowVectors, toRefs } from '../rule-vectors.js';
import { projectSlug as slugFor, projectWhere as whereFor } from '../scope.js';
import { probeWhoami, recall, substrateQuery } from '../substrate-http.js';

// The directory is the one fact needing the server. Unreachable -> null ->
// `unknown`, never "unregistered": reporting a missing row when the server was
// simply down invites deleting a good identity.
// The directory read does not page. A full page means identities may be
// missing, which would surface as false "unregistered" and "never reported"
// findings, so it is reported rather than trusted.
export const DIRECTORY_LIMIT = 200;

/**
 * The AgentIdentity directory. All three are null when there is no server or
 * it did not answer: `unknown`, never "unregistered".
 */
export async function readDirectory({ substrateUrl, env, fetchImpl }) {
  let directoryKids = null;
  let directoryRows = null;
  let activeKids = null;
  if (substrateUrl !== null) {
    try {
      const ns = env.SUBSTRATE_NAMESPACE ?? 'cortext';
      const key = `${ns}/AgentIdentity`;
      const fields = { kid: true, active: true, description: true, project: true, host: true };
      const readDirectory = (f) =>
        substrateQuery(
          substrateUrl,
          { [key]: { params: { limit: DIRECTORY_LIMIT }, fields: f } },
          { fetchImpl }
        );
      // `roaming` arrived with cortext 2.13.0. An older runtime projects it as
      // null with a diagnostic, so no identity is roaming there; the re-read
      // covers one that refuses the frame outright instead.
      let data = await readDirectory({ ...fields, roaming: true });
      if (!Object.hasOwn(data, key)) data = await readDirectory(fields);
      // Presence of the key, not `?? []` — a rejected frame must not read as an
      // empty directory.
      // Carry `active` through rather than discarding it — the query was
      // already paying for the field and dropping it made orphans.hosts count
      // retired identities as live hosts.
      directoryRows = Object.hasOwn(data, key) ? data[key] : null;
      directoryKids = directoryRows === null ? null : directoryRows.map((r) => r.kid);
      activeKids =
        directoryRows === null
          ? null
          : directoryRows.filter((r) => r.active !== false).map((r) => r.kid);
    } catch {
      directoryKids = null;
    }
  }
  return { directoryRows, directoryKids, activeKids };
}

/**
 * whoami plus the salient-tier and recall probes, read-only. Without a server
 * each answers `unknown` with the reason.
 *
 * @param {{ substrateUrl: string|null, env: Record<string, string|undefined>,
 *           targetDir: string, fetchImpl: typeof fetch, kid: string|null,
 *           declaredKid?: string|null }} p
 */
export async function probeServer({
  substrateUrl,
  env,
  targetDir,
  fetchImpl,
  kid,
  declaredKid = null
}) {
  // Does the salient tier RANK SEMANTICALLY, and does recall ANSWER?
  //
  // Both are live probes rather than reports on a previous cold-start, because
  // the audit is a separate process and never has the cold-start's result to read.
  //
  // Read-only, and that is a property of the server rather than of care taken
  // here: a fetch does not reinforce unless the caller passes `boost: true`, and
  // recall takes an explicit `boost: false`.
  let salientFindings = [
    check(
      'salient.rank',
      'unknown',
      'SUBSTRATE_URL is not set, so the salient tier could not be probed',
      'the audit cannot reach a server to ask whether ranking is semantic'
    )
  ];
  let recallFindings = [
    check(
      'recall.available',
      'unknown',
      'SUBSTRATE_URL is not set, so semantic recall could not be probed',
      'the audit cannot reach a server to ask whether recall answers'
    )
  ];
  // What this credential actually HOLDS. Nothing on the local filesystem
  // and nothing in the AgentIdentity directory can answer this — see
  // auditAuthority. Left as the ok:false default when SUBSTRATE_URL is unset, which
  // renders as an unknown with a reason rather than as a passing check.
  let whoami = { ok: false, failed: 'SUBSTRATE_URL is not set, so the server could not be asked' };

  if (substrateUrl !== null) {
    const ns = env.SUBSTRATE_NAMESPACE ?? 'cortext';
    whoami = await probeWhoami(substrateUrl, { fetchImpl });
    const ruleKey = `${ns}/AgentRule`;
    const anchorKey = `${ns}/AnchorIntent`;

    // The salient-tier probe must measure the rows the COLD-START would rank.
    // An unscoped `{ limit: 1 }` would let the server's first row stand in for
    // "the anchor", and under `--target-dir` report on another project's anchor.
    //
    // `projectWhere` + newest-first is exactly what resolveAnchor does, so the
    // probe measures the row the render will actually use.
    const projectSlug = slugFor(targetDir, env);
    const projectWhere = whereFor(projectSlug);
    let activeRuleIds = [];
    let anchorId = null;
    let anchorHistory = null;
    let failed = null;
    try {
      const data = await substrateQuery(
        substrateUrl,
        {
          [ruleKey]: {
            params: { where: { ...projectWhere, active: { eq: true } }, limit: 200 },
            fields: { id: true }
          },
          [anchorKey]: {
            params: { where: projectWhere, limit: 1, orderBy: [{ createdAt: 'desc' }] },
            fields: { id: true }
          }
        },
        { fetchImpl, onFrameFailure: (k, d) => (failed = `${k}: ${d}`) }
      );
      activeRuleIds = (Object.hasOwn(data, ruleKey) ? data[ruleKey] : [])
        .map((r) => r.id)
        .filter((id) => typeof id === 'string');
      anchorId = (Object.hasOwn(data, anchorKey) ? data[anchorKey] : [])[0]?.id ?? null;

      // "No anchor" has two causes with different fixes — never had one
      // (the normal state after onboarding, which seeds none) versus had one and
      // archived it. Same project scope, archived filter dropped: an empty result
      // means no anchor has EVER existed for this project.
      //
      // A SECOND CALL, not a second frame. One payload object cannot carry the
      // same key twice, and an aliased key is not a thing the server accepts —
      // `cortext/AnchorIntent#ever` is rejected with `unknown name`, which lands
      // as a missing key rather than an error a caller notices.
      if (anchorId === null && projectSlug !== null) {
        let everFailed = null;
        const ever = await substrateQuery(
          substrateUrl,
          {
            [anchorKey]: {
              // `project: { eq: slug }` — NOT the `in: [slug, null]` the live
              // query uses. A live cross-cutting anchor legitimately serves any repo, so the live
              // query includes nulls; but for "did THIS project ever have one",
              // including them makes every repo in the fleet look like it had an
              // anchor and retired it. Two questions, two scopes.
              params: { where: { project: { eq: projectSlug } }, limit: 1 },
              fields: { id: true }
            }
          },
          { fetchImpl, onFrameFailure: (k, d) => (everFailed = `${k}: ${d}`) }
        );
        // Presence of the key is the fact, not the emptiness of its value — a
        // rejected frame comes back with the key ABSENT, and reading that as an
        // empty list would report "never had an anchor" about a query that never
        // ran.
        anchorHistory =
          everFailed !== null || !Object.hasOwn(ever, anchorKey)
            ? null
            : ever[anchorKey].length > 0
              ? 'archived'
              : 'none';
      }
    } catch (err) {
      failed = String(err?.message ?? err);
    }

    if (failed === null) {
      // AnchorIntent rows live under their own type, so the anchor is fetched as
      // its own ref rather than riding along in the AgentRule list — a ref with
      // the wrong `type` simply matches nothing, which would read as "the anchor
      // is unembedded" and send someone off to re-embed a fine row.
      const ruleRefs = toRefs(
        activeRuleIds.map((id) => ({ id })),
        ns,
        'AgentRule'
      );
      const anchorRefs = anchorId === null ? [] : toRefs([{ id: anchorId }], ns, 'AnchorIntent');
      let probeFailed = null;
      const vectors = new Map();
      for (const group of [ruleRefs, anchorRefs]) {
        if (group.length === 0) continue;
        const got = await fetchRowVectors(substrateUrl, group, {
          fetchImpl,
          onFrameFailure: (k, d) => (probeFailed = `${k}: ${d}`)
        });
        for (const [id, v] of got) vectors.set(id, v);
      }
      // An empty map with no reported failure is ambiguous — nothing embedded, or
      // a transport error that `fetchRowVectors` swallowed by design. Say so
      // rather than reporting "0 embedded" as if it were measured.
      if (probeFailed === null && vectors.size === 0 && ruleRefs.length > 0) {
        probeFailed = 'the vector fetch returned nothing and reported no reason';
      }
      salientFindings = auditSalientTier({
        probe: { vectors, failed: probeFailed },
        activeRuleIds,
        anchorId,
        anchorHistory
      });
    } else {
      salientFindings = auditSalientTier({
        probe: { vectors: new Map(), failed },
        activeRuleIds: [],
        anchorId: null
      });
    }

    // `boost: false` keeps this read-only. Recall still reinforces what it
    // matched by default and that is right for a real session — but
    // an audit's probe query is not use, and reinforcing on it would make the
    // instrument alter what it measures.
    let recallReason = null;
    const rows = await recall(substrateUrl, {
      query: 'audit probe: is semantic recall reachable',
      namespace: ns,
      type: 'Memory',
      k: 1,
      boost: false,
      fetchImpl,
      onFrameFailure: (k, d) => (recallReason = `${k}: ${d}`)
    });
    recallFindings = auditSemanticRecall({
      answered: rows !== null,
      // The probe above signed with THIS process's credential. Saying
      // whether recall answers for the target requires that they be the same one.
      credentialAttributed: credentialIsTargets({
        whoami,
        resolvedKid: kid,
        declaredKid
      }),
      // The rule query above is the reachability witness: it uses the same
      // transport, so if it came back the server is up and a null recall is a
      // real refusal rather than a dead box.
      reachable: failed === null,
      reason: recallReason ?? failed ?? 'the recall frame did not answer and gave no reason'
    });
  }
  return { whoami, salientFindings, recallFindings };
}
