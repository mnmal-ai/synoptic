// `.claude/settings.local.json` validation.
//
// ## Why
//
// One missing comma makes the whole file invalid JSON, and Claude Code ignores
// it **silently**, so:
//
//   - `enableAllProjectMcpServers: true` is never applied — `claude mcp get
//     substrate` reports `Status: ⏸ Pending approval` while the file plainly says
//     otherwise;
//   - the entire permission allowlist is inert, and the session hits prompts on
//     pre-authorised commands.
//
// The file says one thing, the running system does another, and nothing
// reconciles them.
//
// ## Why this lives here rather than being "not our bug"
//
// It is not our parser and not our silence. But `/substrate-setup` WRITES this file
// (Step 7.4) and merges into it, so it is the last place with a chance to
// notice — and merging into a file whose contents are already being discarded
// produces a change that cannot possibly take effect. A writer that does not
// check what it is writing into is our bug.
//
// ## The second check is the one that catches the real symptom
//
// Valid JSON is necessary and not sufficient. A repo with a project `.mcp.json`
// whose settings do not enable it gets a server that never connects, which
// presents as "substrate offline" rather than as a settings problem. That is a
// different fault with the same signature, so both are reported.

/**
 * @typedef {{ state: 'ok'|'warn'|'unknown', text: string, detail?: string }} SettingsFinding
 */

/**
 * Validate the settings file and its MCP-enabling keys.
 *
 * @param {object} p
 * @param {string|null} p.settingsText Raw `.claude/settings.local.json`, or null if absent.
 * @param {boolean} p.hasProjectMcp Whether the repo has its own `.mcp.json`.
 * @returns {Array<SettingsFinding>}
 */
export function checkSettings({ settingsText, hasProjectMcp }) {
  const out = [];

  if (settingsText === null) {
    // Absent is a normal state, not a fault — but it does mean a project MCP
    // server has nothing enabling it, which the second check reports below.
    out.push({ state: 'ok', text: 'settings.local.json absent (nothing to invalidate)' });
    if (hasProjectMcp) {
      out.push({
        state: 'warn',
        text: 'a project .mcp.json exists with no settings.local.json to enable it',
        detail:
          'the server needs enableAllProjectMcpServers or enabledMcpjsonServers, or it stays pending approval and presents as "substrate offline"'
      });
    }
    return out;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(settingsText);
  } catch (err) {
    out.push({
      state: 'warn',
      text: 'settings.local.json is NOT VALID JSON — Claude Code is silently ignoring all of it',
      detail: `${String(err?.message ?? err)} — every key in this file is inert, including permission allowlists and MCP enablement, while the file reads as though they apply`
    });
    // Nothing further can be said about a file that does not parse. Reporting
    // "enablement missing" here would be a second finding caused entirely by
    // the first.
    return out;
  }

  out.push({ state: 'ok', text: 'settings.local.json parses' });

  if (!hasProjectMcp) return out;

  const enabledAll = parsed?.enableAllProjectMcpServers === true;
  const enabledList = Array.isArray(parsed?.enabledMcpjsonServers)
    ? parsed.enabledMcpjsonServers
    : [];
  if (!enabledAll && !enabledList.includes('substrate')) {
    out.push({
      state: 'warn',
      text: 'the project .mcp.json substrate server is not enabled by settings.local.json',
      detail:
        'set enableAllProjectMcpServers: true or add "substrate" to enabledMcpjsonServers; until then it stays pending approval and cold-start reports "substrate offline"'
    });
  } else {
    out.push({ state: 'ok', text: 'project MCP servers are enabled' });
  }
  return out;
}
