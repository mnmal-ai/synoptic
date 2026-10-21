// The report renderer.

// `info` states a permanent limit of the audit itself, not a check
// that could not run. It is shown, never counted, and never fails the exit.
const MARKER = { ok: 'ok  ', warn: 'WARN', unknown: '????', info: 'note' };

/**
 * Render the report.
 *
 * The summary counts `unknown` separately and never folds it into either side —
 * see the note at the top of this file. A report that said "3 ok, 0 warnings"
 * while four checks never ran is the bug this audit exists to find.
 */
export function renderAudit(groups) {
  const lines = ['# /substrate-setup --audit — read-only reconciliation', ''];
  let ok = 0;
  let warn = 0;
  let unknown = 0;

  for (const [title, checks] of groups) {
    lines.push(`## ${title}`);
    lines.push('');
    for (const c of checks) {
      if (c.state === 'ok') ok++;
      else if (c.state === 'warn') warn++;
      else if (c.state !== 'info') unknown++;
      lines.push(`  [${MARKER[c.state]}]  ${c.text}`);
      if (c.detail) lines.push(`          ${c.detail}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  if (warn === 0 && unknown === 0) {
    lines.push(`**${ok} checks passed.** Nothing to do.`);
  } else {
    const parts = [`${ok} ok`];
    if (warn > 0) parts.push(`**${warn} needing attention**`);
    if (unknown > 0) parts.push(`**${unknown} NOT VERIFIED**`);
    lines.push(parts.join(', '));
    if (unknown > 0) {
      lines.push('');
      lines.push(
        '> A `????` is a hole in this audit, not a pass. It means the check could ' +
          'not run — which is the same failure mode the audit exists to catch, one ' +
          'level up. Treat it as unresolved, never as "probably fine".'
      );
    }
  }
  lines.push('');
  lines.push('*Nothing above was written. This mode only reads.*');
  return lines.join('\n');
}
