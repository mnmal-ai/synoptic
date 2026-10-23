// The cold-start rule index: every binding (`must`) and always-on (`pinned`)
// rule as one line, then pointers to everything else. The AgentRule rows hold
// the full text; this only locates it. A synopsis is rendered whole, never
// clipped, so a rule whose exact string is the payload (e.g. a commit footer)
// arrives word for word.

// Category order, most costly to get wrong first. An unlisted category sorts
// after the ranked ones, alphabetically, so adding one without ranking it is a
// visible demotion rather than a random placement.
const CATEGORY_ORDER = [
  'substrate',
  'identity',
  'permissions',
  'verification',
  'testing',
  'tooling',
  'git',
  'scope-discipline',
  'investigation',
  'process',
  'communication',
  'style'
];

function categoryRank(cat) {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/** Cost-ranked category, then unlisted categories alphabetically, then `pinned`, then shortId. */
function compareRules(a, b) {
  const ca = a.category ?? 'uncategorised';
  const cb = b.category ?? 'uncategorised';
  const d = categoryRank(ca) - categoryRank(cb);
  if (d !== 0) return d;
  if (ca !== cb) return ca < cb ? -1 : 1;
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  return (a.shortId ?? 0) - (b.shortId ?? 0);
}

/** `#N (category) synopsis` — the only rule form the cold-start renders. */
function ruleLine(r) {
  const cat = r.category ? ` (${r.category})` : '';
  const text =
    typeof r.synopsis === 'string' && r.synopsis.length > 0
      ? r.synopsis
      : '(no synopsis — query the row)';
  return `#${r.shortId}${cat} ${text}`;
}

/**
 * Render the rule index.
 *
 * @param {Array<{shortId: number, category?: string|null, severity?: string|null, pinned?: boolean|null, synopsis?: string|null}>} rules
 * @param {{ ns?: string, project: string|null }} opts  `project` null: the reads were unscoped
 * @returns {string}
 */
export function renderRuleIndex(rules, { ns = 'cortext', project }) {
  const all = Array.isArray(rules) ? rules : [];
  const musts = all.filter((r) => r?.severity === 'must').sort(compareRules);
  const pinned = all.filter((r) => r?.severity !== 'must' && r?.pinned === true).sort(compareRules);
  const rest = all.length - musts.length - pinned.length;
  const scope = project ? `\`project\` in [\`${project}\`, null]` : 'all projects';

  const lines = [
    `## Binding rules — ${musts.length} \`must\``,
    '',
    `Apply silently. Full text on the row: query \`${ns}/AgentRule\` by shortId.`,
    '',
    ...musts.map(ruleLine)
  ];
  if (pinned.length > 0)
    lines.push('', `**Always-on (${pinned.length}):**`, ...pinned.map(ruleLine));
  lines.push(
    '',
    `Everything else is a query (${scope}): ${rest} more rules \`${ns}/AgentRule\`, ` +
      `focus \`${ns}/AnchorIntent\` (newest), open work \`${ns}/Todo\`, memory \`recall\` ` +
      `(\`type: "Memory"\`), concepts \`${ns}/Concept\`.`
  );
  return lines.join('\n');
}
