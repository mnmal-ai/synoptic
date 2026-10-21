/**
 * Todo lifecycle and outcome, split. A single `status` doing both jobs makes
 * `done` vs `closed` a grey distinction nobody can apply consistently.
 *
 * LIFECYCLE (`status`): is it live? OUTCOME (`resolution`): why did it stop?
 * The same split GitHub (state + state_reason) and Jira (status + resolution)
 * make.
 *
 * The pg CHECK admits exactly the lifecycle set; `done` / `not_started` are
 * aliases the schema canonicalises on write.
 */
export const TODO_LIFECYCLE_VOCAB = [
  'open',
  'in_progress',
  'blocked',
  'deferred',
  'closed'
] as const;

/** Why a closed Todo stopped. `unspecified` is for migrated rows with no clear cue. */
export const TODO_RESOLUTION_VOCAB = [
  'completed',
  'wont_do',
  'superseded',
  'duplicate',
  'obsolete',
  'unspecified'
] as const;

export const TODO_PRIORITY_VOCAB = ['low', 'medium', 'high'] as const;

/** AgentMessage delivery state; the pg CHECK and the field enum share it. */
export const AGENT_MESSAGE_STATUS_VOCAB = ['unread', 'read', 'acked'] as const;
