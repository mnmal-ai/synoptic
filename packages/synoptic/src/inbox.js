// Agent-mailbox inbox for cold-start. Two-step recipient-keyed lookup: the session
// kid (SUBSTRATE_AGENT_KEY_ID) resolves to its <ns>/AgentIdentity row id, then the
// inbox is a single `recipient = me, status = unread, archived = false`
// filter — no broadcast branch, because broadcasts fan out one directed row
// per identity. This is deliberately NOT the
// project-scoped query path: AgentMessage has no project field; an inbox is
// scoped by addressee, orthogonal to which repo the session is in.

import { substrateQuery } from './substrate-http.js';

/** One page of unread mail. A full page renders as "50+": the read does not
 *  page, so exactly this many means there may be more. */
export const INBOX_LIMIT = 50;

/** The unread count as shown: a full page is a lower bound. */
export function unreadCount(n) {
  return n >= INBOX_LIMIT ? `${n}+` : String(n);
}

/**
 * The session kid's AgentIdentity row id, or null (no kid, or no row).
 */
export async function resolveIdentityId({
  substrateUrl,
  namespace = 'cortext',
  agentKid,
  fetchImpl = fetch
}) {
  if (!agentKid) return null;
  const dir = await substrateQuery(
    substrateUrl,
    {
      [`${namespace}/AgentIdentity`]: {
        params: { where: { kid: { eq: agentKid } }, limit: 1 },
        fields: { id: true }
      }
    },
    { fetchImpl }
  );
  return (dir[`${namespace}/AgentIdentity`] ?? [])[0]?.id ?? null;
}

/**
 * Fetch the session identity's unread messages.
 * @returns {Promise<Array<object>|null>} null when no kid is configured or the
 *   kid has no directory row (nothing to render, not an error). Throws on
 *   transport failure — the caller degrades visibly.
 */
export async function loadInbox({
  substrateUrl,
  namespace = 'cortext',
  agentKid,
  fetchImpl = fetch
}) {
  const meId = await resolveIdentityId({ substrateUrl, namespace, agentKid, fetchImpl });
  if (meId === null) return null;

  const data = await substrateQuery(
    substrateUrl,
    {
      [`${namespace}/AgentMessage`]: {
        params: {
          where: { recipient: { eq: meId }, status: { eq: 'unread' }, archived: { eq: false } },
          limit: INBOX_LIMIT,
          orderBy: [{ createdAt: 'asc' }]
        },
        fields: {
          id: true,
          shortId: true,
          subject: true,
          body: true,
          inReplyTo: true,
          instance: true,
          tags: true,
          _metadata: true
        }
      }
    },
    { fetchImpl }
  );
  return data[`${namespace}/AgentMessage`] ?? [];
}

/**
 * The inbox as one count line. Bodies are not rendered: mid-turn push and the
 * Stop check deliver them. Empty → ''.
 */
export function renderInbox(messages, { ns = 'cortext' } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  // Bounded so a full inbox cannot push the cold-start past its budget.
  const shown = messages.slice(0, 5).map((m) => `#${m.shortId}`);
  const ids = messages.length > 5 ? `${shown.join(', ')}, …` : shown.join(', ');
  return `Inbox: ${unreadCount(messages.length)} unread — ${ids} (close or reply via \`${ns}/ackAgentMessage\`, \`markAgentMessageRead\`, \`sendAgentMessage\`).`;
}
