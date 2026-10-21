// capability — the NORTHBOUND seam of the Synoptic host. The host owns the
// harness (southbound) seam; a capability owns these northbound contributions:
//   - namespaces        : the Substrate namespaces it reads/writes, as a list of
//                         names (read on each) or { ns: [caps] }
//   - requiresIdentity  : whether its writes need a signed <agent>@<host> identity
//   - conventions       : its interaction conventions (harness-agnostic markdown)
//   - coldStart(ctx)    : the cold-start payload — WHAT to load at session start
//
// The host's southbound projector adapts the DELIVERY of these per harness tier
// (inject via hook / embed in an auto-loaded file / embed + prime); the
// capability owns the CONTENT. This split is what lets one host deliver many
// capabilities (Cortext first) to many harnesses without either side knowing
// about the other.

/**
 * `namespaces` takes two forms. A list of names means `read` on each,
 * which is all the authority audit ever checked, so existing capabilities audit
 * exactly as before. `{ ns: ['read', 'mutate'] }` declares what the capability
 * does to each namespace, so the audit can warn on a key that can read
 * somewhere this capability writes. The normalised `namespaces` is always the
 * list of names; the per-namespace needs are in `needs`.
 *
 * @param {{ name: string, namespaces: string[] | Record<string, string[]>,
 *           conventions: string, coldStart: (ctx: { project: string }) => string,
 *           requiresIdentity?: boolean }} spec
 */
export function defineCapability(spec) {
  for (const field of ['name', 'namespaces', 'conventions', 'coldStart']) {
    if (spec[field] === undefined) {
      throw new Error(`defineCapability: missing required field '${field}'`);
    }
  }
  const needs = normaliseNeeds(spec.namespaces);
  if (typeof spec.coldStart !== 'function') {
    throw new Error('defineCapability: `coldStart` must be a function (ctx) => string');
  }
  return {
    name: spec.name,
    namespaces: Object.keys(needs),
    needs,
    requiresIdentity: spec.requiresIdentity ?? true,
    conventions: spec.conventions,
    coldStart: spec.coldStart
  };
}

/** `namespaces` in either form, as `{ ns: caps }`. Throws on an empty or malformed spec. */
function normaliseNeeds(namespaces) {
  if (Array.isArray(namespaces)) {
    if (namespaces.length === 0) {
      throw new Error('defineCapability: `namespaces` must be a non-empty array or object');
    }
    return Object.fromEntries(namespaces.map((ns) => [ns, ['read']]));
  }
  if (
    namespaces === null ||
    typeof namespaces !== 'object' ||
    Object.keys(namespaces).length === 0
  ) {
    throw new Error('defineCapability: `namespaces` must be a non-empty array or object');
  }
  for (const [ns, caps] of Object.entries(namespaces)) {
    if (!Array.isArray(caps) || caps.length === 0) {
      throw new Error(`defineCapability: namespace '${ns}' must list at least one capability`);
    }
  }
  return { ...namespaces };
}
