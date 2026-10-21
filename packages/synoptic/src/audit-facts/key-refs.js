// Which key files something actually signs with, read from every config
// surface that binds a kid to a key.

import { join } from 'node:path';
import { scanCodexRefs, scanMiseRefs, scanSystemdRefs } from '../audit.js';
import { listOrNull, readOrNull } from '../fs-safe.js';
import { mcpEnvLiteral } from '../mcp-json-facts.js';

/**
 * Which key files are actually SIGNED WITH, and under which kid.
 *
 * A key file's name is not its identity. `claude-agent.key` signs as
 * `claude-code@host-a`, and the only place that binding is written down is
 * the `.mcp.json` that configures the pair — so that is what has to be read
 * before calling a key unowned.
 *
 * Handles both `${VAR}` and `${VAR:-fallback}`: the fallback is the interesting
 * half, because it is the literal a repo commits to when the environment
 * supplies nothing.
 *
 * @param {ReadonlyArray<string>} files absolute paths to candidate .mcp.json
 * @returns {Array<{ keyName: string, kid: string, source: string }>}
 */
export function scanKeyRefs(files) {
  const refs = [];
  for (const f of files) {
    const raw = readOrNull(f);
    if (raw === null) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const server of Object.values(parsed?.mcpServers ?? {})) {
      const keyPath = mcpEnvLiteral(server?.env?.SUBSTRATE_AGENT_KEY_PATH);
      const kid = mcpEnvLiteral(server?.env?.SUBSTRATE_AGENT_KEY_ID);
      if (keyPath === null || kid === null) continue;
      const base = keyPath.split('/').pop() ?? '';
      const keyName = base.replace(/\.(key|pub)$/, '');
      if (keyName !== '') refs.push({ keyName, kid, source: f });
    }
  }
  return refs;
}

/** @param {{ fleetDir: string|null, targetDir: string, home: string }} p */
export function gatherKeyRefs({ fleetDir, targetDir, home }) {
  // Only a --fleet run reads more than this repo, and only a complete read can
  // turn "I did not see a reference" into "nothing references it".
  // (A daemon's kid lives in mise.toml env, never in an .mcp.json —
  // scanning configs without it reports every unattended identity as
  // unreferenced, forever.)
  const refScanDirs =
    fleetDir === null
      ? [targetDir]
      : (listOrNull(fleetDir) ?? [])
          .filter((e) => e.isDirectory())
          .map((e) => join(fleetDir, e.name));
  // Systemd user units are where unattended selves bind their keys
  // (a daemon's worker and scheduler), and they live per BOX rather than per
  // repo, so they are read whatever the scan scope. The INSTALLED units, not the
  // templates in a repo's ops/ tree: installed is what actually runs.
  const systemdUserDir = join(home, '.config', 'systemd', 'user');
  const systemdUnits = (listOrNull(systemdUserDir) ?? [])
    .filter((e) => e.name.endsWith('.service'))
    .map((e) => join(systemdUserDir, e.name));
  const keyRefs = [
    ...scanKeyRefs(refScanDirs.map((d) => join(d, '.mcp.json'))),
    ...scanMiseRefs(
      refScanDirs.map((d) => ({
        path: join(d, 'mise.toml'),
        text: readOrNull(join(d, 'mise.toml'))
      }))
    ),
    ...scanCodexRefs(
      refScanDirs.map((d) => {
        const path = join(d, '.codex', 'cortext.local.json');
        return { path, text: readOrNull(path) };
      })
    ),
    ...scanSystemdRefs(systemdUnits.map((path) => ({ path, text: readOrNull(path) })))
  ];
  const refScanComplete = fleetDir !== null;
  return { keyRefs, refScanComplete };
}
