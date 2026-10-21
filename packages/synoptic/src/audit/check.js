// One audit check line and its three states; see ../audit.js for why there are three.

/** @typedef {{ id: string, state: 'ok'|'warn'|'unknown', text: string, detail?: string }} Check */

/** One check line. `unknown` requires a reason — a hole with no explanation is not reportable. */
export function check(id, state, text, detail) {
  if (state === 'unknown' && (detail === undefined || detail === null || detail === '')) {
    throw new Error(`audit check '${id}' is unknown without a reason`);
  }
  return detail === undefined ? { id, state, text } : { id, state, text, detail };
}
