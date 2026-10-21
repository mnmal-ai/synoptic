// Whether a tracked `.mcp.json` is still committable, and whether it holds secrets.

import { check } from './check.js';

/**
 * Is a TRACKED `.mcp.json` still the committable form?
 *
 * The gitignore rule is conditional on CONTENT rather than on the file's name: a fully-indirected file (pure `${VAR}` refs, public
 * `SUBSTRATE_URL` literal) is committed, and one carrying an absolute path, a
 * host-pinned kid or a literal secret is ignored.
 *
 * The rule introduces exactly one failure mode: a file that starts portable and
 * STAYS TRACKED while someone edits a machine value into it. The cost lands in
 * git history, where it is not retractable.
 *
 * ## What is deliberately NOT flagged
 *
 * `${VAR:-default}` is not automatically machine-specific. The skill's own Step
 * 4.2 form uses `${SUBSTRATE_AGENT_KEY_ID:-default}`, whose fallback is the FLEET
 * default rather than a host-pinned identity. So a kid fallback is flagged only
 * when it names a host (`@`), and a path fallback only when it is absolute.
 * Flagging every fallback would flag the arrangement this skill recommends.
 *
 * ## Values are never printed
 *
 * A `.mcp.json` env block can hold a token. Findings name the FIELD and the
 * marker kind, never the value — the same discipline as the identity checks,
 * which report a boolean for the key file rather than reading it out.
 *
 * @param {{ present: boolean|null, tracked: boolean|null,
 *           markers: ReadonlyArray<{ field: string, kind: string }>|null }} p
 */
export function auditMcpJson({ present, tracked, markers }) {
  if (present === null) {
    return [
      check(
        'mcp-json',
        'unknown',
        'a project .mcp.json exists but could not be read or parsed',
        'so whether it carries machine-specific values is unknown — distinct from reading it and finding none'
      )
    ];
  }
  if (present === false) {
    return [
      check(
        'mcp-json',
        'ok',
        'no project .mcp.json',
        'nothing to commit or ignore — this repo uses a user-scope server or none'
      )
    ];
  }
  if (tracked === null || markers === null) {
    return [
      check(
        'mcp-json',
        'unknown',
        'cannot tell whether .mcp.json is tracked',
        'git could not answer (not a repository, or the command failed), and an untracked-vs-committed distinction is the whole of this check'
      )
    ];
  }

  const named = markers.map((m) => `${m.field} (${m.kind})`).join(', ');

  if (tracked && markers.length > 0) {
    return [
      check(
        'mcp-json',
        'warn',
        `.mcp.json is TRACKED and carries ${markers.length} machine-specific value(s): ${named}`,
        'the portable form is committed and this one is ignored. Every commit from here puts a machine path or an identity into git history, which is not retractable — either indirect the value through the environment (Step 7.2) or `git rm --cached .mcp.json` and ignore it'
      )
    ];
  }
  if (tracked) {
    return [
      check('mcp-json', 'ok', '.mcp.json is tracked and fully indirected — the committable form')
    ];
  }
  if (markers.length > 0) {
    return [
      check(
        'mcp-json',
        'ok',
        `.mcp.json is ignored and carries machine-specific value(s): ${named} — correctly ignored`
      )
    ];
  }
  return [
    check(
      'mcp-json',
      'ok',
      '.mcp.json is ignored and carries no machine-specific value',
      'harmless, but a tracked repo would commit this form: a fresh clone then gets a working server with no setup step'
    )
  ];
}
