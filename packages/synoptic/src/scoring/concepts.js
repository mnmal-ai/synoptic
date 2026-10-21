// Cold-start hook helper for <ns>/Concept.
//
// Always-load projection: name + description + kind. Bodies on demand via
// query (<ns>/Concept where { name: { eq: ... } }) or recall.
// Grouped by kind in the rendered output for human-scannability.

const KIND_ORDER = ['type', 'protocol', 'pattern', 'role'];

/**
 * Render the `## Concepts (operational semantics)` cold-start section.
 *
 * @param {Array<{ name: string, description: string, kind: string, archived?: boolean }>} rows
 * @returns {string}
 */
export function renderConcepts(rows) {
  const live = rows.filter((r) => r.archived !== true);
  if (live.length === 0) return '';

  const out = [];
  out.push(`## Concepts (operational semantics — ${live.length} total)`);
  out.push('');

  // Bucket by kind, preserving the canonical kind ordering.
  const byKind = new Map();
  for (const k of KIND_ORDER) byKind.set(k, []);
  for (const r of live) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }

  for (const kind of KIND_ORDER.concat([...byKind.keys()].filter((k) => !KIND_ORDER.includes(k)))) {
    const bucket = byKind.get(kind) ?? [];
    if (bucket.length === 0) continue;
    out.push(`### ${kind}`);
    bucket.sort((a, b) => a.name.localeCompare(b.name));
    for (const r of bucket) {
      out.push(`- **${r.name}**`);
      out.push(`  > ${r.description}`);
    }
    out.push('');
  }

  return `${out.join('\n')}\n`;
}

/**
 * Fetch in-scope Concept rows via the Substrate HTTP query endpoint.
 *
 * @param {{ substrateUrl: string, projectSlug: string | null, namespace: string, fetchImpl?: typeof fetch }} opts
 *   `projectSlug=null` means cross-project ("all") scope — the project filter
 *   is omitted so every project's Concepts come back.
 * @returns {Promise<Array<{ name: string, description: string, kind: string, archived?: boolean }>>}
 */
export async function loadConcepts({ substrateUrl, projectSlug, namespace, fetchImpl = fetch }) {
  const projectFilter = projectSlug === null ? {} : { project: { in: [projectSlug, null] } };
  const payload = {
    [`${namespace}/Concept`]: {
      params: {
        where: { archived: { eq: false }, ...projectFilter },
        limit: 200,
        orderBy: [{ kind: 'asc' }, { name: 'asc' }]
      },
      fields: { name: true, description: true, kind: true, archived: true }
    }
  };
  const res = await fetchImpl(`${substrateUrl}/substrate/v1/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) return [];
  const env = await res.json();
  const rows = env?.data?.[`${namespace}/Concept`];
  return Array.isArray(rows) ? rows : [];
}
