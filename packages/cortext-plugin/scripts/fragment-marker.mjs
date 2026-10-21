/**
 * Shared vocabulary for the conventions-fragment marker, so the stamper
 * (`sync-fragment-version.mjs`) and its guard (`test/fragment-version.test.js`)
 * can never disagree about the format or the digest input.
 *
 * Marker shape (line 1 of `fragments/substrate-conventions.md`):
 *
 *     <!-- substrate-conventions vsynoptic-<version>+<sha8> — plugin-owned; ... -->
 *
 * `<sha8>` is the first 8 hex chars of sha256 over the fragment BODY — every
 * byte after the marker line. Excluding the marker line is what keeps the
 * digest from being self-referential.
 */
import { createHash } from 'node:crypto';

/** Matches the marker and captures version (1) and, when present, digest (2). */
export const MARKER_RE =
  /^<!-- substrate-conventions vsynoptic-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+([0-9a-f]{8}))?/;

/**
 * Split a fragment into its marker line and the body the digest covers.
 * Returns `null` when line 1 is not a marker (structurally broken file).
 */
export function splitFragment(text) {
  const newline = text.indexOf('\n');
  if (newline === -1) return null;
  const markerLine = text.slice(0, newline);
  if (!MARKER_RE.test(markerLine)) return null;
  return { markerLine, body: text.slice(newline + 1) };
}

/** The digest half of the marker, computed over the fragment body. */
export function digestOf(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 8);
}

/** Rebuild line 1 for `version` + `body`, preserving the trailing marker prose. */
export function buildMarkerLine(markerLine, version, body) {
  return markerLine.replace(
    MARKER_RE,
    `<!-- substrate-conventions vsynoptic-${version}+${digestOf(body)}`
  );
}
