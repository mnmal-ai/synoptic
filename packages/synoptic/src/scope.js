// Which repository a session belongs to, and which rows that scopes it to.
// One copy of each rule: the cold-start, the anchor, recall scoring,
// the audit and the inbox hooks all have to agree, or a session sees one
// project's rules and another's mail.

import { basename } from 'node:path';
import { findRepoRoot } from './repo-root.js';

/** The repository root for a session started in `start`, or `start` itself outside one. */
export function sessionRoot(start) {
  return findRepoRoot(start) ?? start;
}

/** The project slug for a root: its basename, or null (all projects) under SYNOPTIC_PROJECT_SCOPE=all. */
export function projectSlug(root, env) {
  if (env.SYNOPTIC_PROJECT_SCOPE === 'all') return null;
  return basename(root);
}

/** The `where` for live rows in a project plus cross-cutting rows; unscoped for a null slug. */
export function projectWhere(slug) {
  if (slug === null || slug === undefined) return { archived: { eq: false } };
  return { archived: { eq: false }, project: { in: [slug, null] } };
}
