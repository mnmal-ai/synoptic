// The part of a SessionStart hook every entry must agree on: a hard
// time limit, the SYNOPTIC_COLD_START_MAX_BYTES cap, and never throwing. The
// Claude Code entry had none of the three while the neutral entry had all of
// them, because each entry carried its own copy.
import { truncateToBudget } from './cold-start.js';

/** End-to-end budget for one cold-start render. Below the hook timeout the
 *  plugin manifests set, so a slow Substrate degrades to a note instead of the
 *  harness killing the hook with nothing printed. */
export const SESSION_START_BUDGET_MS = 9000;

const TIMEOUT_NOTE = '<!-- synoptic cold-start unavailable (timeout) -->\n';

/** Positive-finite byte budget from env, or null for uncapped. Blank and
 *  malformed values mean uncapped: a typo must not silence the cold-start. */
export function parseMaxBytes(raw) {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Run a cold-start render under the shared budget and cap. Never throws: a
 * failure becomes a one-line note, so the session still starts.
 *
 * @param {{ render: () => Promise<string>, env: Record<string, string|undefined>,
 *   authWarning?: string|null, budgetMs?: number }} p
 * @returns {Promise<string>}
 */
export async function renderSessionStart({
  render,
  env,
  authWarning = null,
  budgetMs = SESSION_START_BUDGET_MS
}) {
  let timer = null;
  try {
    const doc = await Promise.race([
      render(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_NOTE), budgetMs);
      })
    ]);
    return truncateToBudget(
      (authWarning ?? '') + doc,
      parseMaxBytes(env.SYNOPTIC_COLD_START_MAX_BYTES)
    );
  } catch (err) {
    return `<!-- synoptic cold-start failed: ${String(err?.message ?? err).replace(/\s+/g, ' ')} -->\n`;
  } finally {
    // A pending loser timer would keep the process alive past the answer.
    if (timer !== null) clearTimeout(timer);
  }
}
