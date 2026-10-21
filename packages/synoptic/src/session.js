// The session discriminator.
//
// ## The defect
//
// Agent identity is bound to the repo, not the session. Sessions are not. Several concurrent Claude
// sessions in one repo all sign with the same key, and `AgentMessage` has no
// sender field at all — the sender is `_metadata.createdBy`, which the server
// derives from that key. So every session in a repo is, on the wire,
// indistinguishable from every other.
//
// So a correction can reach the session that did not make the error while
// the one doing the work never sees it, and a reply can address a continuity
// that does not exist.
//
// ## Why this stamps rather than addresses
//
// Per-session ADDRESSING would make the primary job worse. Repo-scoped
// delivery means a message reaches whoever is next active in that repo.
// Addressed to a specific session that has since ended, it would go to a dead
// mailbox, and the intended session has often stopped being the active one.
//
// Delivery stays repo-scoped. Only provenance becomes session-scoped.
//
// ## Why `tags` and not a new field
//
// `tags` is already client-settable, indexed and nullable on `AgentMessage`,
// and null on every message written to date. A stamp there costs no schema
// change, no cortext release and no runtime deploy — where a real field would
// take the heaviest propagation path this repo has (npm tarball -> runtime
// deploy). Deferred until the tag proves insufficient.
//
// The stamp is therefore ADVISORY: client-supplied, so it can be omitted or
// wrong, unlike `createdBy` which is signed. That is adequate for telling
// honest concurrent sessions apart and is not a security boundary. Making it
// unforgeable would require substrate to have a concept of a session, which it does
// not (tracked separately).
//
// ## The compaction wrinkle, which is a feature
//
// Claude Code's session id appears to change on compaction — the scratchpad
// can sit under one id and later task outputs under another. So
// "same session" is not stable across a compaction.
//
// That reads like a weakness and is not: the id changes exactly when context
// continuity breaks. The confused message above is entirely consistent with a
// post-compaction session that had lost its own history, and a discriminator
// that flips at that moment is reporting something true.

/** Short, readable form of a session id — enough to discriminate, not to page. */
export function shortSessionId(sessionId) {
  const s = String(sessionId ?? '').trim();
  if (s.length === 0) return null;
  // UUID-shaped ids carry their entropy up front; anything else is truncated
  // the same way rather than special-cased.
  const head = s.replace(/-/g, '').slice(0, 8);
  return head.length === 0 ? null : head;
}

/** The tag an outgoing message carries. */
export function sessionTag(sessionId) {
  const short = shortSessionId(sessionId);
  return short === null ? null : `session:${short}`;
}

/**
 * The cold-start block telling this session who it is and what to stamp.
 *
 * Deliberately tiny and placed high: it is an instruction that applies to
 * WRITES, so it has to be read before the session starts writing, and it
 * competes for the same budget as everything else.
 *
 * Renders nothing without a session id — instructing an agent to stamp a value
 * it does not have would produce a literal `session:undefined` on the wire,
 * which is worse than no stamp because it looks like a discriminator and
 * discriminates nothing.
 *
 * @param {{ sessionId?: string|null, kid?: string|null }} opts
 * @returns {string} '' when there is nothing useful to say.
 */
export function renderSessionBlock({ sessionId = null, kid = null } = {}) {
  const tag = sessionTag(sessionId);
  if (tag === null) return '';
  const who = kid === null || kid === '' ? 'this repo’s agent identity' : `\`${kid}\``;
  return [
    '## This session',
    '',
    `You are ${who}, session \`${shortSessionId(sessionId)}\`.`,
    '',
    `**That identity is shared.** It is bound to the repo, not to you — concurrent ` +
      'sessions here sign identically, and `AgentMessage` has no sender field to ' +
      'tell you apart (the sender is derived from the signing key). So when you ' +
      'send, stamp it:',
    '',
    '```',
    `tags: ["${tag}"]`,
    '```',
    '',
    '**And say what you DID, not what you read.** The stamp is advisory — a ' +
      'reader cannot verify it. What actually establishes that a message came ' +
      'from a session that did the work is the message carrying the work: a ' +
      'measurement, a file and line, a command and its output. A reply that ' +
      'only restates what it was sent is indistinguishable from one written ' +
      'by a session that has lost its context.',
    ''
  ].join('\n');
}
