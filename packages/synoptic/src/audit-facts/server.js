// What only the server can answer: the identity directory, this credential's
// own grant (whoami), and whether semantic recall answers.

import { auditSemanticRecall, check, credentialIsTargets } from '../audit.js';
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
 * whoami plus the recall probe, read-only. Without a server each answers
 * `unknown` with the reason.
 *
 * @param {{ substrateUrl: string|null, env: Record<string, string|undefined>,
 *           fetchImpl: typeof fetch, kid: string|null,
 *           declaredKid?: string|null }} p
 */
export async function probeServer({ substrateUrl, env, fetchImpl, kid, declaredKid = null }) {
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
    // whoami is the reachability witness: any HTTP answer, even a 404 or 401,
    // means the server is up, so a null recall is a real refusal.
    const reachable = whoami.ok || /^whoami \d/.test(whoami.failed ?? '');

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
      reachable,
      reason:
        recallReason ??
        (reachable ? 'the recall frame did not answer and gave no reason' : whoami.failed)
    });
  }
  return { whoami, recallFindings };
}
