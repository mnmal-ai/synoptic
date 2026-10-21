// Hard budget trim for a rendered document.
//
// Moved from synoptic's cold-start `truncateToBudget`. It exists because
// some harnesses enforce a hook-output ceiling by KILLING the hook rather than
// truncating it (one terminates the process tree past 16384 bytes and parses
// nothing), so an over-budget document is not a long
// document, it is no document.
//
// Two ceilings, either or both:
//
//   maxBytes   UTF-8 bytes, via TextEncoder. No Node built-ins: the package has
//              to run where `Buffer` does not exist.
//   maxTokens  model tokens, counted by the CALLER's `countTokens`. Token counts
//              depend on the model, so this package never guesses at one.
//
// The cut lands on a newline so nothing is split mid-line, and a pointer is
// appended saying the sections below the cut are PRESENT, not empty. A reader
// who cannot tell a trimmed document from a short one will act on absence.

const encoder = new TextEncoder();

/**
 * UTF-8 byte length of a string.
 * @param {string} text
 * @returns {number}
 */
export function byteLength(text) {
  return encoder.encode(text).length;
}

export const DEFAULT_POINTER =
  '\n<!-- truncated for a context budget: the sections below the cut are PRESENT, not empty -->\n';

const isLimit = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Cap `text` at a byte and/or token ceiling, cutting at a newline.
 *
 * Pass-through when the text fits every active ceiling, or when no ceiling is
 * a positive finite number. The result never exceeds an active ceiling.
 *
 * @param {string} text
 * @param {object} budget
 * @param {number} [budget.maxBytes]
 * @param {number} [budget.maxTokens] Requires `countTokens`.
 * @param {(s: string) => number} [budget.countTokens]
 * @param {string} [budget.pointer=DEFAULT_POINTER] Appended after the cut.
 * @returns {string}
 */
export function truncateToBudget(text, budget = {}) {
  if (typeof text !== 'string') return text;
  const { maxBytes, maxTokens, countTokens, pointer = DEFAULT_POINTER } = budget;
  const bytesOn = isLimit(maxBytes);
  const tokensOn = isLimit(maxTokens);
  if (tokensOn && typeof countTokens !== 'function') {
    throw new TypeError('truncateToBudget: maxTokens needs a countTokens function');
  }
  if (!bytesOn && !tokensOn) return text;

  const fits = (s) =>
    (!bytesOn || byteLength(s) <= maxBytes) && (!tokensOn || countTokens(s) <= maxTokens);
  if (fits(text)) return text;

  const lines = text.split('\n');
  let head = '';
  for (const line of lines) {
    const next = head === '' ? line : `${head}\n${line}`;
    if (!fits(next + pointer)) break;
    head = next;
  }
  if (head !== '') return head + pointer;
  // Not even one line fits beside the pointer. Return as much of the pointer as
  // the byte ceiling allows: a truncated notice still says "truncated", which
  // is the one thing that must survive.
  if (!bytesOn) return fits(pointer) ? pointer : '';
  // `stream: true` holds back a multi-byte character cut in half instead of
  // decoding it to U+FFFD, which is 3 bytes and would break the ceiling.
  return new TextDecoder().decode(encoder.encode(pointer).subarray(0, maxBytes), { stream: true });
}

/**
 * Decide what to PULL within a token budget, using the counts the caller put
 * on each entry. Everything not pulled goes to the index.
 *
 * Walks the entries in the order given (already ranked) and stops at the first
 * one that does not fit. It does not skip ahead to a smaller entry: that would
 * pull a lower-ranked entry over a higher-ranked one, an inversion the reader
 * cannot see.
 *
 * Entries with `pinned: true` are always pulled, and they spend the budget
 * before anything else. If they alone exceed it, they are still pulled and
 * `over` says so: dropping a required entry to honour a budget is the worse
 * failure, and a silent one.
 *
 * @template {{ tokens?: number|null, pinned?: boolean }} T
 * @param {ReadonlyArray<T>} entries
 * @param {{ maxTokens: number, reserve?: number }} opts
 *   `reserve` holds tokens back, e.g. for the index lines that will follow.
 * @returns {{ top: T[], index: T[], spent: number, over: boolean }}
 */
export function splitByTokens(entries, { maxTokens, reserve = 0 }) {
  const budget = maxTokens - reserve;
  const cost = (e) => {
    if (typeof e.tokens !== 'number' || !Number.isFinite(e.tokens)) {
      throw new TypeError('splitByTokens: every entry needs a numeric `tokens` count');
    }
    return e.tokens;
  };
  for (const e of entries) cost(e);
  const top = [];
  const index = [];
  let spent = 0;
  for (const e of entries) {
    if (e.pinned) {
      top.push(e);
      spent += cost(e);
    }
  }
  let open = true;
  for (const e of entries) {
    if (e.pinned) continue;
    if (open && spent + cost(e) <= budget) {
      top.push(e);
      spent += cost(e);
    } else {
      open = false;
      index.push(e);
    }
  }
  return { top, index, spent, over: spent > budget };
}
