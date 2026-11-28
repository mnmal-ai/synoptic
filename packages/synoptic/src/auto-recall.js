// Memory for the prompt at hand, found without the model asking: a search of
// the store on the user's prompt, rendered as handles (number and one line),
// never bodies. Opt-in, read-only, and silent on any failure.

import { recall } from './substrate-http.js';

/** A recall on every prompt must not hold the turn. */
const TIMEOUT_MS = 2000;
const DEFAULT_MAX = 3;
/** Shorter prompts ("yes", "go on") carry nothing to search on. */
const MIN_PROMPT_CHARS = 12;
const MAX_QUERY_CHARS = 500;
const LINE_MAX = 160;

const oneLine = (v) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LINE_MAX);

/**
 * The context to add for `prompt`, or '' for nothing. `seen` holds the row ids
 * already shown this session and is added to. Never throws.
 *
 * `SYNOPTIC_RECALL_AUTO=on` enables it. `SYNOPTIC_RECALL_MAX` caps the hits
 * (default 3) and `SYNOPTIC_RECALL_MIN_SCORE` drops weaker ones; it has no
 * default because a useful floor depends on the store and its embedder.
 */
export async function autoRecallContext({ env, prompt, project, fetchImpl, seen = new Set() }) {
  if (env.SYNOPTIC_RECALL_AUTO !== 'on' || !env.SUBSTRATE_URL) return '';
  const query = typeof prompt === 'string' ? prompt.trim().slice(0, MAX_QUERY_CHARS) : '';
  if (query.length < MIN_PROMPT_CHARS) return '';
  const max =
    Number.parseInt(env.SYNOPTIC_RECALL_MAX ?? '', 10) > 0
      ? Number.parseInt(env.SYNOPTIC_RECALL_MAX, 10)
      : DEFAULT_MAX;
  const floor = Number.parseFloat(env.SYNOPTIC_RECALL_MIN_SCORE ?? '');
  try {
    const hits = await recall(env.SUBSTRATE_URL, {
      query,
      namespace: env.SUBSTRATE_NAMESPACE ?? 'cortext',
      type: 'Memory',
      // Room to skip rows already shown.
      k: max + seen.size,
      where: { project: { in: [project, null] } },
      rowFields: { id: true, shortId: true, name: true, description: true },
      // A search nobody asked for must not count as the memory being used.
      boost: false,
      fetchImpl,
      timeoutMs: TIMEOUT_MS
    });
    if (hits === null) return '';
    const fresh = hits
      .filter((h) => typeof h?.row?.id === 'string' && !seen.has(h.row.id))
      .filter((h) => Number.isNaN(floor) || h.score >= floor)
      .slice(0, max);
    if (fresh.length === 0) return '';
    for (const h of fresh) seen.add(h.row.id);
    const lines = fresh.map(
      (h) => `#${h.row.shortId} ${oneLine(h.row.name)}: ${oneLine(h.row.description)}`
    );
    return (
      `[cortext memory, found automatically for this prompt; not from the user. ${fresh.length} possibly related:]\n` +
      `${lines.join('\n')}\n` +
      'Read one in full with the substrate query tool if it matters; ignore any that do not.\n'
    );
  } catch {
    return '';
  }
}
