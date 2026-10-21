// Folding a stored row's markdown into the cold-start. The mechanics now
// live in @mnmal-ai/context-render, shared with other consumers;
// this wrapper keeps synoptic's signature and its cortext-specific wording — the
// "cold-start budget" reason and a `ns/Type` `name` pull hint.

import {
  closeOpenFence,
  cutAtLineBoundary,
  flattenHeadings,
  foldBody as foldGeneric
} from '@mnmal-ai/context-render';

export { closeOpenFence, cutAtLineBoundary, flattenHeadings };

/**
 * @param {string|null|undefined} text
 * @param {object} [opts]
 * @param {number} [opts.limit=1200] Character budget for the body.
 * @param {string} [opts.ns='cortext'] Namespace, for the recovery hint.
 * @param {string} [opts.type='Memory'] Type name, for the recovery hint.
 * @param {string|null} [opts.name=null] Row handle, for the recovery hint.
 * @returns {string} '' for empty input, so callers can skip the push.
 */
export function foldBody(text, opts = {}) {
  const { limit = 1200, ns = 'cortext', type = 'Memory', name = null } = opts;
  const pullHint = name === null ? `\`${ns}/${type}\`` : `\`${ns}/${type}\` \`${name}\``;
  return foldGeneric(text, { limit, pullHint, reason: 'cold-start budget' });
}
