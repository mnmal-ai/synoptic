// Write-contract digest for the cold-start.
//
// The cold-start carried Concepts, Memory, Open Work and Rules — everything
// about the CONTENT of the store and nothing about how to write to it. So each
// unfamiliar mutation got guessed and the guess got corrected by a rejection.
// Typical avoidable round-trips:
//
//     priority: "med"                    enum is low|medium|high
//     no `area`                          required, non-nullable, no default
//     orderBy: { createdAt: "desc" }     must be an ARRAY of { field: dir }
//     shortId: { in: ["#869"] }          shortId is a NUMBER; "#869" is display
//
// None of those was a bad error message. The waste is that a round-trip was the
// only way to learn the shape. `schema` has always returned exactly this,
// but nothing prompts an agent to consult it BEFORE the first write. A digest
// turns a reactive tool into ambient knowledge.
//
// WHY A DIGEST AND NOT THE SCHEMA. `/substrate/v1/schema/cortext` is 65 kB and the
// federated view is 109 kB — most of it mutation signatures that restate the
// field block three times over. The digest below is ~1 kB for thirteen types.
// Injecting the raw schema would cost more context than the round-trips it saves.
//
// THE REQUIRED-FIELD RULE IS DERIVED, NOT LISTED — nullable, defaulted,
// readonly and server-set fields are all optional on create, and everything
// else is required. Validated against a real rejection sequence: creating a
// SessionLog is rejected for `branch`, then `startedAt`, one at a time, and the
// full set the server demands is branch, startedAt, summary, decisionsCount,
// packages. The rule reproduces exactly those five. That matters because
// `missing_required_field` reports only the FIRST missing field, so the server
// will never show you the whole set — which is the deeper reason this digest
// earns its place.

const DEFAULT_TIMEOUT_MS = 3000;

// Types an agent writes to routinely, in the order the conventions introduce
// them. Everything else still appears, just after these — the point is that the
// common cases are readable without scanning.
const WRITE_ORDER = [
  'Todo',
  'Decision',
  'SessionLog',
  'AnchorIntent',
  'Memory',
  'AgentMessage',
  'Concept',
  'AgentRule'
];

/**
 * GET the namespace-scoped schema. Never throws — returns null on any failure,
 * because a missing digest must cost the session nothing.
 *
 * Scoped by path segment (`/substrate/v1/schema/<ns>`), not `?namespace=` — that form
 * is a pre-federation compatibility surface serving `default` only, and returns
 * 404 with an `availableNamespaces` list on a federated deployment.
 *
 * Signing is NOT done here: the request rides the `fetchImpl` seam, which every
 * entry point builds with `makeSignedFetch`. `onRefused(status)` fires for any
 * non-2xx answer so the caller can decide which ones to surface — the
 * null return alone cannot tell a gated route from a missing one.
 */
export async function fetchNamespaceSchema(substrateUrl, namespace, opts = {}) {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, onRefused = () => {} } = opts;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${substrateUrl}/substrate/v1/schema/${namespace}`, {
      signal: ctl.signal
    });
    if (!res.ok) {
      onRefused(res.status);
      return null;
    }
    const json = await res.json();
    return json !== null && typeof json === 'object' && typeof json.types === 'object'
      ? json
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Optional on create: nullable, defaulted, readonly, or server-set. */
function isOptional(def) {
  return (
    def?.nullable === true ||
    def?.default !== undefined ||
    def?.readonly === true ||
    def?.serverSet !== undefined
  );
}

/**
 * One entry per type: what you must send, and the shapes that get guessed wrong.
 *
 * @returns {Array<{ type: string, required: Array<string>,
 *   enums: Array<{ field: string, values: Array<string> }>,
 *   numbers: Array<string>, crossRefs: Array<string> }>}
 */
export function buildSchemaDigest(schema) {
  const types = schema?.types;
  if (types === null || types === undefined || typeof types !== 'object') return [];
  const names = Object.keys(types).sort((a, b) => {
    const ia = WRITE_ORDER.indexOf(a);
    const ib = WRITE_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });

  return names.map((type) => {
    const fields = types[type]?.fields ?? {};
    const required = [];
    const enums = [];
    const numbers = [];
    const crossRefs = [];
    for (const [name, def] of Object.entries(fields)) {
      if (!isOptional(def)) required.push(name);
      if (Array.isArray(def?.enum)) enums.push({ field: name, values: def.enum });
      // `shortId` is the canonical trap: a NUMBER that everyone writes as
      // "#869" because that is how it renders everywhere.
      if (def?.type === 'number') numbers.push(name);
      if (def?.kind === 'crossRef') crossRefs.push(name);
    }
    return { type, required, enums, numbers, crossRefs };
  });
}

/**
 * The operator contract the schema route serves (on servers that send it), or
 * null when it did not arrive.
 *
 * `operators` is keyed by field KIND (`scalar.string`, `crossRef`, `list`, …),
 * so it renders once per namespace rather than per type, which is how it is
 * served. ABSENT is UNKNOWN, not "no operators": an older host, or a namespace
 * with no host-registered dataset, leaves the keys out by design, and the
 * digest must then say nothing rather than an empty set.
 *
 * `extensionOperators` (substrate-recall's `embeddingSimilar`) skip the dataset
 * capability check and are valid on EVERY kind. They are kept apart so the
 * render never files one under a single kind.
 *
 * @returns {{ byKind: Array<[string, Array<string>]>, extension: Array<string> } | null}
 */
export function buildOperatorDigest(schema) {
  const ops = schema?.operators;
  if (ops === null || ops === undefined || typeof ops !== 'object' || Array.isArray(ops)) {
    return null;
  }
  const byKind = Object.entries(ops)
    .filter(([, list]) => Array.isArray(list))
    .sort(([a], [b]) => a.localeCompare(b));
  const ext = schema.extensionOperators;
  return { byKind, extension: Array.isArray(ext) ? ext : [] };
}

/**
 * Render the digest, or '' when the schema was unavailable.
 *
 * A fenced block rather than prose: it is scanned, not read, and fencing stops
 * a markdown renderer reflowing the alignment that makes it scannable.
 */
export function renderSchemaDigest(entries, opts = {}) {
  const { ns = 'cortext', operators = null } = opts;
  if (entries.length === 0) return '';
  const lines = [];
  for (const e of entries) {
    const parts = [];
    if (e.required.length > 0) parts.push(`req: ${e.required.join(', ')}`);
    for (const { field, values } of e.enums) parts.push(`${field}: ${values.join('|')}`);
    if (e.numbers.length > 0) parts.push(`num: ${e.numbers.join(', ')}`);
    if (e.crossRefs.length > 0) parts.push(`ref: ${e.crossRefs.join(', ')}`);
    if (parts.length === 0) continue;
    lines.push(`${ns}/${e.type}\n  ${parts.join('\n  ')}`);
  }
  if (lines.length === 0) return '';
  const operatorLines =
    operators === null || operators.byKind.length === 0
      ? []
      : [
          '',
          'Filter operators by field kind, as this server reports them (a field’s kind is in `schema`):',
          '',
          '```',
          ...operators.byKind.map(([kind, list]) => `${kind}: ${list.join('|')}`),
          ...(operators.extension.length > 0
            ? [`any kind: ${operators.extension.join('|')}  (extension)`]
            : []),
          '```'
        ];
  return [
    `## Write contract (${ns} — ${entries.length} types)`,
    '',
    'Required = every field that is not nullable, defaulted, readonly or server-set.',
    'Note `missing_required_field` reports only the FIRST omission, so the server',
    'will never show you the whole set in one go.',
    '',
    '```',
    ...lines,
    '```',
    '',
    'Query shapes that are guessed wrong more often than they are got right:',
    '- `orderBy` is an ARRAY of single-key objects — `[{ createdAt: "desc" }]`, not `{ createdAt: "desc" }`.',
    '- `shortId` is a NUMBER. `#869` is display only; filter with `{ shortId: { eq: 869 } }`.',
    '- Never send `createdAt` / `updatedAt` / `createdBy` / `updatedBy` on write — read them via `_metadata`.',
    ...operatorLines,
    ''
  ].join('\n');
}
