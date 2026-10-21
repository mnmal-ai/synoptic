// Body folding for @mnmal-ai/context-render: folding a stored row's own
// markdown into the cold-start document. Two hazards.
//
// ## 1. Budget
//
// Uncapped Memory bodies can be the largest section of the payload, and Memory
// DEGRADES GRACEFULLY when unread — you lose context and recover. The `must`
// rules do not degrade: missing one produces a violation the agent never sees.
// Spending the budget on the recoverable half is the wrong allocation.
//
// ## 2. A row body can forge document structure
//
// Stored content can emit its own `## ` headings into a document whose
// sections ARE `## ` headings. To anything reading the document by section — a
// human skimming, or a tool splitting on `^## ` — they are indistinguishable
// from sections the projector emitted.
//
// So headings are flattened to bold rather than demoted to a deeper level.
// Demotion keeps them in the heading namespace and only moves the collision;
// bold removes them from it. Nesting is not worth preserving here — the body is
// already nested under its own `####` entry, and a reader wants emphasis, not
// an outline six levels deep.
//
// ## Why the marker is not optional
//
// A silent truncation reads as a complete body: absence must not be
// mistakable for "nothing there". Every cut
// says so, says how much was cut, and names the query that returns the rest.

/** Lines that open or close a fenced code block. */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * Advance a fence state over one line. A fence closes only on the
 * SAME character, at least as long as its opener, as CommonMark has it: a
 * ``` line inside a ~~~ block is content, not a close. Treating any fence
 * line as a toggle got both cases wrong.
 *
 * @param {string|null} open the opener in force ('```', '~~~~', …), or null
 * @param {string} line
 * @returns {string|null} the opener in force after this line
 */
function nextFence(open, line) {
  const m = FENCE_RE.exec(line);
  if (m === null) return open;
  const fence = m[1];
  if (open === null) return fence;
  return fence[0] === open[0] && fence.length >= open.length ? null : open;
}

/** ATX heading: 1-6 `#` followed by a space. */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Flatten ATX headings to bold so stored content cannot forge document
 * structure. Headings inside fenced code blocks are left alone — there they are
 * comments, shell prompts or diff markers, not structure, and rewriting them
 * would corrupt a snippet the reader may copy.
 *
 * @param {string} text
 * @returns {string}
 */
export function flattenHeadings(text) {
  let open = null;
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const wasOpen = open;
      open = nextFence(open, line);
      if (wasOpen !== null || open !== null) return line;
      const m = HEADING_RE.exec(line);
      if (m === null) return line;
      const heading = m[2].trim();
      // A heading with no text is structure with nothing to emphasise; drop it
      // rather than emitting an empty `****`.
      return heading.length === 0 ? '' : `**${heading}**`;
    })
    .join('\n');
}

/**
 * Cut `text` to at most `limit` characters at a line boundary.
 *
 * Prefers the last line break at or before the limit so a cut never lands
 * mid-sentence or, worse, mid-fence. When a single line already exceeds the
 * limit there is no boundary to prefer and it is cut hard.
 *
 * Returns the original string and `cut: 0` when nothing needed removing, so the
 * caller can tell "fit" from "fit exactly at the limit".
 *
 * @param {string} text
 * @param {number} limit
 * @returns {{ text: string, cut: number }}
 */
export function cutAtLineBoundary(text, limit) {
  const s = String(text ?? '');
  if (s.length <= limit) return { text: s, cut: 0 };
  const window = s.slice(0, limit);
  const br = window.lastIndexOf('\n');
  // Only honour the boundary if it retains a useful majority of the budget —
  // otherwise a body whose first line is enormous would collapse to almost
  // nothing on the strength of one early newline.
  const kept = br > limit * 0.5 ? window.slice(0, br) : window;
  return { text: kept.trimEnd(), cut: s.length - kept.length };
}

/**
 * Close an unterminated code fence.
 *
 * A cut inside a fenced block leaves the fence open, and an open fence swallows
 * every following section of the document into one code block — turning a
 * budget trim into a rendering failure for content that was never truncated.
 *
 * @param {string} text
 * @returns {string}
 */
export function closeOpenFence(text) {
  let open = null;
  for (const line of String(text ?? '').split('\n')) open = nextFence(open, line);
  // Close with the opener itself: a ``` cannot end a ~~~ block.
  return open === null ? text : `${text}\n${open}`;
}

/**
 * Fold one stored body into the document: flatten its headings, cap it at
 * `limit`, and say so explicitly when anything was removed.
 *
 * The note names WHY it was cut and, when the caller can say, WHERE the rest
 * lives. A silent cut reads as the end of the body, which is the failure this
 * function exists to prevent; the pull hint is what turns "truncated" into
 * something the reader can act on.
 *
 * @param {string|null|undefined} text
 * @param {object} [opts]
 * @param {number} [opts.limit=1200] Character budget for the body. <= 0 means uncapped.
 * @param {string|null} [opts.pullHint=null] Where the full body can be fetched,
 *   rendered verbatim after "query" (e.g. "`cortext/Memory` `name`").
 * @param {string} [opts.reason='the context budget'] What the cut was for.
 * @returns {string} '' for empty input, so callers can skip the push.
 */
export function foldBody(text, opts = {}) {
  const { limit = 1200, pullHint = null, reason = 'the context budget' } = opts;
  const flattened = flattenHeadings(text).trim();
  if (flattened.length === 0) return '';
  if (limit <= 0 || flattened.length <= limit) return flattened;

  const { text: kept, cut } = cutAtLineBoundary(flattened, limit);
  const pull = pullHint === null ? '' : ` — query ${pullHint} for the rest`;
  return (
    `${closeOpenFence(kept)}\n\n` +
    `> *… ${cut.toLocaleString('en-US')} more characters not shown. This body was ` +
    `TRUNCATED for ${reason}, not ended${pull}.*`
  );
}
