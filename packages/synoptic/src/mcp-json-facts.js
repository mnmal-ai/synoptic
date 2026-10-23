// What the repo's `.mcp.json` says, read for the audit and the cold-start's
// HostInstall checks alike.

import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readOrNull } from './fs-safe.js';

/**
 * A `.mcp.json` env value, reduced to the literal it actually commits to.
 *
 * Handles both `${VAR}` and `${VAR:-fallback}`: the fallback is the interesting
 * half, because it is the literal a repo commits to when the environment
 * supplies nothing. A bare `${VAR}` commits to nothing and answers null — which
 * is why an unpinned repo cannot establish its own kid this way.
 */
export function mcpEnvLiteral(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-([^}]*))?\}$/);
  if (m === null) return v === '' ? null : v;
  return m[1] === undefined || m[1] === '' ? null : m[1];
}

/**
 * Facts about the project `.mcp.json` for the drift check.
 *
 * Reads the file ONCE and returns only what the check needs: is it tracked,
 * and which FIELDS carry machine-specific values. Values never leave this
 * function — an env block can hold a token, and the audit's rule is to report
 * a field name rather than read a secret into the transcript.
 *
 * `${VAR:-fallback}` is the interesting case and is not machine-specific by
 * itself: the skill's own Step 4.2 form ships `${SUBSTRATE_AGENT_KEY_ID:-default}`,
 * whose fallback is the FLEET default. So a kid is flagged only when its
 * literal names a host, and a path only when its literal is absolute.
 */
export function readMcpJsonFacts(dir, { gitTimeoutMs = 15000 } = {}) {
  const path = join(dir, '.mcp.json');
  const raw = readOrNull(path);
  if (raw === null) return { present: false, tracked: null, markers: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: null, tracked: null, markers: null };
  }

  let tracked = null;
  try {
    execFileSync('git', gitArgs(dir), { stdio: 'ignore', timeout: gitTimeoutMs });
    tracked = true;
  } catch (e) {
    tracked = trackedFromError(e);
  }
  return { present: true, tracked, markers: markersOf(parsed) };
}

/**
 * readMcpJsonFacts without blocking the event loop, for the cold-start, which
 * has reads in flight while it runs.
 *
 * @returns {Promise<{ present: boolean|null, tracked: boolean|null, markers: Array<object>|null }>}
 */
export async function readMcpJsonFactsAsync(dir, { gitTimeoutMs = 15000 } = {}) {
  const raw = readOrNull(join(dir, '.mcp.json'));
  if (raw === null) return { present: false, tracked: null, markers: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: null, tracked: null, markers: null };
  }
  const tracked = await new Promise((resolve) => {
    execFile('git', gitArgs(dir), { timeout: gitTimeoutMs }, (err) =>
      resolve(err ? trackedFromError(err) : true)
    );
  });
  return { present: true, tracked, markers: markersOf(parsed) };
}

function gitArgs(dir) {
  return ['-C', dir, 'ls-files', '--error-unmatch', '.mcp.json'];
}

// Exit 1 is the answer "not tracked". Anything else (not a repo, git missing,
// a timeout) is a question that did not get asked, and must not be reported
// as "untracked".
function trackedFromError(e) {
  return e?.status === 1 || e?.code === 1 ? false : null;
}

function markersOf(parsed) {
  const markers = [];
  const isAbsolute = (v) => typeof v === 'string' && (v.startsWith('/') || v.startsWith('~/'));
  for (const [name, server] of Object.entries(parsed?.mcpServers ?? {})) {
    const cmd = mcpEnvLiteral(server?.command);
    if (isAbsolute(cmd)) markers.push({ field: `${name}.command`, kind: 'absolute path' });
    for (const [i, arg] of (Array.isArray(server?.args) ? server.args : []).entries()) {
      if (isAbsolute(mcpEnvLiteral(arg)))
        markers.push({ field: `${name}.args[${i}]`, kind: 'absolute path' });
    }
    for (const [k, v] of Object.entries(server?.env ?? {})) {
      const lit = mcpEnvLiteral(v);
      if (lit === null) continue;
      if (/(TOKEN|SECRET|PASSWORD|PASSPHRASE)/i.test(k)) {
        markers.push({ field: `${name}.env.${k}`, kind: 'literal secret' });
      } else if (isAbsolute(lit)) {
        markers.push({ field: `${name}.env.${k}`, kind: 'absolute path' });
      } else if (/(KID|KEY_ID)$/i.test(k) && lit.includes('@')) {
        markers.push({ field: `${name}.env.${k}`, kind: 'host-pinned identity' });
      }
    }
  }
  return markers;
}
