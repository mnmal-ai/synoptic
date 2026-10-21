// HTTP anchor resolution for the cold-start hook. Over HTTP we don't need a vector
// (POST /substrate/v1/recall embeds the anchor text server-side). We fetch the
// newest non-archived AnchorIntent (its text) and compute staleness by
// counting SessionLogs created after it; fall back to the newest SessionLog.
//
// The returned `body` object is the raw row (with updatedAt lifted out of
// _metadata) so renderUnified can read anchor.body.{synopsis,shortId,
// authoredBy.kind,updatedAt,startedAt,branch}. `text` is the recall query.

import { projectWhere } from './scope.js';
import { substrateQuery } from './substrate-http.js';

const DEFAULT_STALE_THRESHOLD = 3;

function liftUpdatedAt(row) {
  return { ...row, updatedAt: row._metadata?.updatedAt ?? row.updatedAt ?? null };
}

// Recall query text: prefer the retrieval-tuned synopsis, then intent, then body.
function anchorText(body) {
  return body.synopsis ?? body.intent ?? body.body ?? '';
}

/**
 * Resolve the recall anchor over HTTP.
 * @returns {Promise<null | {
 *   id: string, text: string, source: 'intent'|'sessionlog',
 *   stale: boolean, sessionLogsSince: number, lastSessionLogAt: string|null,
 *   body: object
 * }>}
 */
export async function resolveAnchorHttp(opts) {
  const {
    substrateUrl,
    namespace,
    projectSlug,
    staleThreshold = DEFAULT_STALE_THRESHOLD,
    fetchImpl,
    onUnexpectedProjection = null,
    onFrameFailure = null
  } = opts;
  const where = projectWhere(projectSlug);

  const intentData = await substrateQuery(
    substrateUrl,
    {
      [`${namespace}/AnchorIntent`]: {
        params: { where, limit: 1, orderBy: [{ createdAt: 'desc' }] },
        fields: {
          id: true,
          shortId: true,
          // Legacy name, kept for the `synopsis ?? intent ?? body` fallback
          // below. AnchorIntent has not declared `intent` since the rename, so
          // it comes back null on every row — which is exactly what the
          // fallback expects, and why this is declared expected rather than
          // deleted. Single-type frame, so the cross-type check in
          // recall-scoring cannot cover it; the allowlist is the only guard.
          intent: true,
          synopsis: true,
          body: true,
          authoredBy: true,
          _metadata: true
        }
      }
    },
    { fetchImpl, expectUnknown: ['intent'], onUnexpectedProjection, onFrameFailure }
  );
  const intentRow = (intentData[`${namespace}/AnchorIntent`] ?? [])[0];

  if (intentRow) {
    const body = liftUpdatedAt(intentRow);
    const createdAt = intentRow._metadata?.createdAt;
    let sessionLogsSince = 0;
    let lastSessionLogAt = null;
    if (createdAt) {
      const sinceData = await substrateQuery(
        substrateUrl,
        {
          [`${namespace}/SessionLog`]: {
            params: {
              where: { ...where, createdAt: { gt: createdAt } },
              limit: 50,
              orderBy: [{ createdAt: 'desc' }]
            },
            fields: { id: true, _metadata: true }
          }
        },
        { fetchImpl, onUnexpectedProjection, onFrameFailure }
      );
      const sls = sinceData[`${namespace}/SessionLog`] ?? [];
      sessionLogsSince = sls.length;
      lastSessionLogAt = sls[0]?._metadata?.createdAt ?? null;
    }
    return {
      id: intentRow.id,
      text: anchorText(body),
      source: 'intent',
      sessionLogsSince,
      lastSessionLogAt,
      stale: sessionLogsSince >= staleThreshold,
      body
    };
  }

  const slData = await substrateQuery(
    substrateUrl,
    {
      [`${namespace}/SessionLog`]: {
        params: { where, limit: 1, orderBy: [{ createdAt: 'desc' }] },
        fields: {
          id: true,
          shortId: true,
          synopsis: true,
          summary: true,
          body: true,
          branch: true,
          startedAt: true,
          _metadata: true
        }
      }
    },
    { fetchImpl, onUnexpectedProjection, onFrameFailure }
  );
  const slRow = (slData[`${namespace}/SessionLog`] ?? [])[0];
  if (slRow) {
    const body = liftUpdatedAt(slRow);
    return {
      id: slRow.id,
      text: anchorText(body),
      source: 'sessionlog',
      sessionLogsSince: 0,
      lastSessionLogAt: null,
      stale: false,
      body
    };
  }

  return null;
}
