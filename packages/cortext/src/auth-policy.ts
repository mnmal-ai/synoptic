/**
 * Auth-posture → policy mapping.
 *
 * The posture knob deliberately lives OUTSIDE the autoCRUD type definitions —
 * it maps onto plugin-level policy combinators at compose time, which is what
 * makes it retrofit-capable: a deployment can start fully open and tighten to
 * identity-gated writes (or full lockdown) later by config alone. No schema
 * migration, no client changes — consumers that already sign never notice the
 * flip. The wire mechanism for this is attribute-mode auth: tokens are
 * verified and attributed whenever present, so credential adoption can run
 * ahead of enforcement.
 *
 * Monotonicity: strictness must be non-decreasing along reads → writes →
 * deletes. "Anonymous may write but not read" has no coherent threat model;
 * rejecting it keeps the mapping a simple ladder.
 *
 * Read-surface coverage: substrate's /substrate/v1/recall route and its
 * recall MCP tool honour these same policies via
 * `engine.evaluateReadPolicy` — recall is not a side-channel
 * around `reads: 'identity'`. Any future embeddings-fetch route must inherit
 * the same check.
 */

import type { Policy } from '@mnmal-ai/substrate/sdk';
import { denyAll, denyVerbs, or, requireIdentity } from '@mnmal-ai/substrate/sdk';
import type { CortextAuthConfig, CortextAuthMode } from './config.js';

/**
 * The default: anonymous read/create/update under
 * attribute mode, identity-gated hard-deletes. Archive stays the open soft path.
 */
export const DEFAULT_AUTH: CortextAuthConfig = Object.freeze({
  reads: 'open',
  writes: 'open',
  deletes: 'identity'
});

const rank = (mode: CortextAuthMode): number => (mode === 'identity' ? 1 : 0);

/** Strictness must be non-decreasing along reads → writes → deletes. */
export function isMonotonicAuth(auth: CortextAuthConfig): boolean {
  return rank(auth.reads) <= rank(auth.writes) && rank(auth.writes) <= rank(auth.deletes);
}

/**
 * Map a posture to the plugin-level policy list. Combinator order matters:
 * `or()` returns the LAST deny verbatim, so the deny arm's actionable reason
 * surfaces on denial instead of requireIdentity's terse default.
 *
 * Monotonicity makes the mapping a ladder — the strictest gated surface
 * determines the single composed policy:
 *   reads gated   → everything requires identity
 *   writes gated  → create/update/delete require identity, reads stay open
 *   deletes gated → only the destructive verbs require identity
 *   fully open    → no policy contributed at all
 */
export function buildAuthPolicies(auth: CortextAuthConfig): Policy[] {
  if (!isMonotonicAuth(auth)) {
    throw new Error(
      'cortext: auth posture must be monotonic (reads ≤ writes ≤ deletes in strictness); ' +
        `got reads=${auth.reads}, writes=${auth.writes}, deletes=${auth.deletes}`
    );
  }
  if (auth.reads === 'identity') {
    return [
      or(
        requireIdentity(),
        denyAll('cortext: all access requires an authenticated identity (auth.reads=identity)')
      )
    ];
  }
  if (auth.writes === 'identity') {
    return [
      or(
        requireIdentity(),
        denyVerbs(
          ['create', 'update', 'delete'],
          'cortext: writes require an authenticated identity (auth.writes=identity; reads stay open)'
        )
      )
    ];
  }
  if (auth.deletes === 'identity') {
    return [
      or(
        requireIdentity(),
        denyVerbs(
          ['delete'],
          'cortext: deletes require an authenticated identity (auth.deletes=identity)'
        )
      )
    ];
  }
  return [];
}
