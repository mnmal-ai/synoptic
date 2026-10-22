// The cold-start rule index: every binding (`must`) and always-on (`pinned`)
// rule as one line, then pointers to everything else. The AgentRule rows hold
// the full text; this only locates it. A synopsis is rendered whole, never
// clipped, so a rule whose exact string is the payload (e.g. a commit footer)
// arrives word for word.

import { compareRules } from './render.js';

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
 * @param {{ ns?: string, project: string|null }} opts
 * @returns {string}
 */
export function renderRuleIndex(rules, { ns = 'cortext', project }) {
  const all = Array.isArray(rules) ? rules : [];
  const musts = all.filter((r) => r?.severity === 'must').sort(compareRules);
  const pinned = all.filter((r) => r?.severity !== 'must' && r?.pinned === true).sort(compareRules);
  const rest = all.length - musts.length - pinned.length;
  const scope = project ? `\`project\` in [\`${project}\`, null]` : '`project` = null';

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
      `focus \`${ns}/AnchorIntent\`, open work \`${ns}/Todo\`, memory \`recall\` ` +
      `(\`type: "Memory"\`), concepts \`${ns}/Concept\`.`
  );
  return lines.join('\n');
}
