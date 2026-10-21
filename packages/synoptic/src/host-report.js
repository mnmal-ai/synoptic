// The cold-start's HostInstall writer. One upsert by `key`: query, then update
// or create; a create lost to a concurrent session (the kernel's unique
// index refuses it) re-queries and updates once.
//
// Never throws, and bounded by one shared budget across all its calls, so a
// slow server costs at most `budgetMs` however many steps the upsert takes.
// A transport failure or an exhausted budget is "offline" and silent, as the rest of the cold-start treats it. A refusal is reported
// through onFailure exactly once, with the server's own reason, so a runtime
// that predates HostInstall costs one diagnostic line, not one per attempt.

import { legacyHostInstallKey } from './host-install.js';
import { substrateMutate, substrateQuery } from './substrate-http.js';

/**
 * @returns {Promise<'created'|'updated'|'offline'|'refused'>}
 */
export async function reportHostInstall({
  substrateUrl,
  namespace,
  fetchImpl,
  record,
  onFailure = () => {},
  budgetMs = 3000
}) {
  const type = `${namespace}/HostInstall`;
  const until = Date.now() + budgetMs;
  // Each call gets what is left of the budget; none starts once it is spent.
  const opts = () => {
    const timeoutMs = until - Date.now();
    if (timeoutMs <= 0) throw new Error('host report budget spent');
    return { fetchImpl, timeoutMs, onFrameFailure: collect };
  };
  const refusals = [];
  const collect = (key, detail) => refusals.push([key, detail]);
  // substrate-http reports a refused frame twice: the server's error, then the
  // key's absence from `data`. The first entry of the failing step carries
  // the server's reason.
  const refused = (from = 0) => {
    const [key, detail] = refusals[from] ?? [type, 'refused with no error given'];
    onFailure(key, detail);
    return 'refused';
  };

  const findId = async () => {
    const data = await substrateQuery(
      substrateUrl,
      {
        [type]: { params: { where: { key: { eq: record.key } }, limit: 1 }, fields: { id: true } }
      },
      opts()
    );
    if (!Object.hasOwn(data, type)) return undefined; // refused
    return data[type][0]?.id ?? null; // null = no row
  };
  const update = async (id) => {
    const key = `${namespace}/updateHostInstall`;
    const { key: _key, ...fields } = record;
    const data = await substrateMutate(
      substrateUrl,
      { [key]: { params: { id, ...fields }, fields: { id: true } } },
      opts()
    );
    return Object.hasOwn(data, key);
  };

  // Rows written before the harness joined the key are keyed host/project.
  // The first create under the new key removes that row if it recorded this
  // same harness, so each host cleans up its own as it updates. Best effort
  // and silent: a leftover row only ages to stale in the audit.
  const removeLegacyRow = async () => {
    try {
      const silent = () => ({ ...opts(), onFrameFailure: null });
      const data = await substrateQuery(
        substrateUrl,
        {
          [type]: {
            params: {
              where: {
                key: { eq: legacyHostInstallKey(record.host, record.project) },
                harness: { eq: record.harness }
              },
              limit: 5
            },
            fields: { id: true }
          }
        },
        silent()
      );
      const deleteKey = `${namespace}/deleteHostInstall`;
      for (const { id } of data[type] ?? []) {
        await substrateMutate(
          substrateUrl,
          { [deleteKey]: { params: { id }, fields: { id: true } } },
          silent()
        );
      }
    } catch {
      /* best effort */
    }
  };

  try {
    const id = await findId();
    if (id === undefined) return refused();
    if (id !== null) return (await update(id)) ? 'updated' : refused();

    const createFrom = refusals.length;
    const createKey = `${namespace}/createHostInstall`;
    const created = await substrateMutate(
      substrateUrl,
      // Batched form on purpose: a unique-index violation on a single frame
      // fails the whole request, while a batched frame rolls back inside a
      // 200 envelope, which is what lets a lost race be told from an outage.
      { [createKey]: [{ params: record, fields: { id: true } }] },
      opts()
    );
    if (Object.hasOwn(created, createKey)) {
      await removeLegacyRow();
      return 'created';
    }

    // Most likely a concurrent session created it first. Re-query and update
    // ONCE; if there is still no row, the create's own refusal is the answer.
    const racedFrom = refusals.length;
    const raced = await findId();
    if (raced === undefined || raced === null) return refused(createFrom);
    return (await update(raced)) ? 'updated' : refused(racedFrom);
  } catch {
    return 'offline';
  }
}

/** The check fields, all null: written when the checks could not be recorded,
 *  so the previous session's verdicts do not read as current. */
export const NULL_CHECK_FIELDS = {
  pinState: null,
  pinNote: null,
  mcpJsonState: null,
  mcpJsonNote: null,
  authorityState: null,
  authorityNote: null,
  settingsState: null,
  settingsNote: null,
  settingsEnv: null
};

/**
 * Report a record with the cold-start's check fields added.
 *
 * If the full record is refused, it falls back once to the base record: with
 * no check fields when the runtime predates them (`unknown_field`), and with
 * them cleared for any other refusal, so stale verdicts never sit beside a
 * fresh refreshedAt. A fallback that lands still says the checks were not
 * recorded.
 *
 * @param {{ base: Record<string, unknown>,
 *   checks: () => Promise<Record<string, unknown>>,
 *   report: (record: Record<string, unknown>,
 *     onFailure: (key: string, detail: string) => void) => Promise<string> }} p
 * @returns {Promise<{ failure: [string, string]|null, checksNote: string|null }>}
 */
export async function reportHostWithChecks({ base, checks, report }) {
  let fields;
  try {
    fields = await checks();
  } catch {
    fields = NULL_CHECK_FIELDS;
  }
  let failure = null;
  const keep = (key, detail) => {
    failure ??= [key, detail];
  };
  if ((await report({ ...base, ...fields }, keep)) !== 'refused') {
    return { failure: null, checksNote: null };
  }
  const detail = failure?.[1] ?? 'refused with no error given';
  const predates = /^unknown_field\b/.test(detail);
  failure = null;
  const fallback = predates ? base : { ...base, ...NULL_CHECK_FIELDS };
  if ((await report(fallback, keep)) === 'refused') return { failure, checksNote: null };
  return {
    failure: null,
    checksNote: predates ? 'this runtime predates the check fields' : detail
  };
}
