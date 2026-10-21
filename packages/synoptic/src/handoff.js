// handoff — cross-agent handoff over the shared Cortext store. A handoff is a
// structured BREADCRUMB an agent leaves ("what I'm on, what's done, what's
// next") that the NEXT agent picks up — attributed, no copy-paste. Two modes,
// both harness-NEUTRAL (plain MCP frames, no Claude-Code-specific hook):
//
//   - async (pickup-on-start): the next agent's cold-start RESUMES from the
//     latest breadcrumb (`resumeQuery`). Works for every harness because every
//     onboarded agent runs a cold-start. Cortext wires this in.
//   - live (notify-running-agent): a running agent SUBSCRIBES (`watchFrame`) and
//     is notified the instant a breadcrumb lands — passed to substrate-client
//     `watch()` over a WS subscription. This is the harness-neutral alternative
//     to the Claude-Code inbox (which needs a host-side hook and can't generalise).
//
// The breadcrumb vehicle is an `AnchorIntent` ("what I'm focused on right now") —
// already the anchor cold-start resolves — so async handoff is almost free. The
// writer is attributed via `_metadata.createdBy`; never name yourself in the
// payload (server-managed fields are rejected on write).

/**
 * Mutation frame to LEAVE a handoff breadcrumb.
 * @param {{ project: string, synopsis: string, body?: string, ns?: string }} h
 *   synopsis = the indexed one-liner ("on X; next: Y") recall + anchor
 *   resolution surface; body = the detail (done / next / refs). ns = the
 *   coordination namespace (default `cortext`).
 */
export function handoffFrames({ project, synopsis, body, ns = 'cortext' } = {}) {
  if (!project) throw new Error('handoffFrames: project is required');
  if (!synopsis) throw new Error('handoffFrames: synopsis is required');
  return {
    [`${ns}/createAnchorIntent`]: {
      params: { synopsis, project, archived: false, ...(body !== undefined ? { body } : {}) },
      fields: { shortId: true, synopsis: true }
    }
  };
}

/** Query frame to RESUME: the newest live breadcrumb for `project`. */
export function resumeQuery(project, ns = 'cortext') {
  return {
    [`${ns}/AnchorIntent`]: {
      params: {
        where: { project: { eq: project }, archived: { eq: false } },
        orderBy: [{ createdAt: 'desc' }],
        limit: 1
      },
      fields: { synopsis: true, body: true, _metadata: true }
    }
  };
}

/** Subscribe frame for LIVE handoff — pass to substrate-client `watch()` to be
 *  notified when a breadcrumb lands for `project`. Single qualified key. */
export function watchFrame(project, ns = 'cortext') {
  return {
    [`${ns}/AnchorIntent`]: {
      params: { where: { project: { eq: project }, archived: { eq: false } } },
      fields: { synopsis: true, body: true }
    }
  };
}
