// Who the target repo signs as: the MCP server's live identity, what the repo
// declares, and which key files exist on this box.

import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { listOrNull, readOrNull } from '../fs-safe.js';
import { mcpEnvLiteral } from '../mcp-json-facts.js';

/**
 * The signing identity of the MCP server serving THIS repo.
 *
 * ## Read this before touching it
 *
 * It must not come from `process.env`. The auditing shell can carry no
 * `SUBSTRATE_AGENT_KEY_ID` while the MCP child does, because `.mcp.json`
 * supplies it per-server. An audit reading its own environment reports "no
 * identity" on a correctly configured box — a false negative that would send
 * someone off to re-provision a working identity.
 *
 * ## And why it extracts ONE variable instead of dumping
 *
 * `/proc/<pid>/environ` carries `SUBSTRATE_AGENT_KEY_PATH` and `SUBSTRATE_DATABASE_URL`
 * beside the kid. Dumping it and filtering the output afterwards has already
 * leaked a live Postgres password in this fleet, because the filter masked the
 * patterns someone had thought of and not the one they had not. So this reads
 * the buffer, pulls out exactly the two names it needs, returns the kid and a
 * BOOLEAN for the key, and never returns or logs anything else.
 *
 * `/proc` is Linux-only. Elsewhere this returns nulls, which surface as
 * `unknown` — not as "no identity".
 */
export function resolveIdentityFromMcp(targetDir) {
  const procs = listOrNull('/proc');
  if (procs === null) return { kid: null, keyEnvSet: null, source: null };
  for (const d of procs) {
    if (!/^\d+$/.test(d.name)) continue;
    let cwd = null;
    try {
      // Only substrate MCP children are candidates; /proc is full of processes
      // whose cwd happens to be this repo (this audit's own shell, for one).
      if (!readFileSync(`/proc/${d.name}/cmdline`, 'utf8').includes('substrate')) continue;
      cwd = readlinkSync(`/proc/${d.name}/cwd`);
    } catch {
      continue;
    }
    if (cwd !== targetDir) continue;
    const raw = readOrNull(`/proc/${d.name}/environ`);
    if (raw === null) continue;
    let kid = null;
    let keyEnvSet = false;
    for (const entry of raw.split('\0')) {
      if (entry.startsWith('SUBSTRATE_AGENT_KEY_ID='))
        kid = entry.slice('SUBSTRATE_AGENT_KEY_ID='.length);
      else if (entry.startsWith('SUBSTRATE_AGENT_KEY_PATH=')) keyEnvSet = true;
    }
    if (kid !== null) return { kid, keyEnvSet, source: `mcp server pid ${d.name}` };
  }
  return { kid: null, keyEnvSet: null, source: null };
}

/**
 * The kid the TARGET repo pins for itself.
 *
 * First `.mcp.json` (a literal `SUBSTRATE_AGENT_KEY_ID` — never a `${VAR}` ref, which
 * commits to nothing), then the repo's own `.claude/settings.local.json`
 * `env`. Both are DECLARATIONS, not measurements — they say which identity
 * the repo intends to sign as, which is enough to reject a grant read under
 * someone else's credential and not enough to prove the key on disk matches.
 * The settings file matters because the post-shell-carrier `.mcp.json` names
 * no identity at all: it inherits settings `env` at spawn, and without this
 * fallback a plain-shell audit of such a repo could never name its subject.
 * Two sources naming different kids is ambiguous, so it answers null rather
 * than picking one.
 */
export function readDeclaredKid(targetDir) {
  // A missing or unreadable `.mcp.json` declares nothing, so it falls through
  // to settings rather than ending the search. Identity lives in settings, and pulling the untracking change deletes the local
  // `.mcp.json`, so this is the ordinary state of a correctly configured repo.
  let parsed = null;
  try {
    parsed = JSON.parse(readOrNull(join(targetDir, '.mcp.json')) ?? 'null');
  } catch {
    parsed = null;
  }
  const kids = new Set();
  for (const server of Object.values(parsed?.mcpServers ?? {})) {
    const kid = mcpEnvLiteral(server?.env?.SUBSTRATE_AGENT_KEY_ID);
    if (kid !== null) kids.add(kid);
  }
  if (kids.size > 1) return null;
  if (kids.size === 1) return [...kids][0];
  // No pin in `.mcp.json`: the repo may carry its identity in its local
  // settings instead (the shell-carrier-free arrangement names no kid in the
  // committed config). Same trust class — an operator-written declaration.
  const settingsRaw = readOrNull(join(targetDir, '.claude', 'settings.local.json'));
  if (settingsRaw === null) return null;
  try {
    const kid = JSON.parse(settingsRaw)?.env?.SUBSTRATE_AGENT_KEY_ID;
    return typeof kid === 'string' && kid !== '' ? kid : null;
  } catch {
    return null;
  }
}

/** The repo's declared agent name, when it carries one. */
export function readDeclaredName(targetDir) {
  const raw = readOrNull(join(targetDir, '.claude', 'settings.json'));
  if (raw === null) return null;
  try {
    return JSON.parse(raw)?.env?.SYNOPTIC_AGENT_NAME ?? null;
  } catch {
    return null;
  }
}

/** Live and revoked key names in `keysDir`; both null when it cannot be read. */
export function readKeyFiles(keysDir) {
  const keyEntries = listOrNull(keysDir);
  const keyNames =
    keyEntries === null
      ? null
      : keyEntries.filter((f) => f.name.endsWith('.key')).map((f) => f.name.replace(/\.key$/, ''));
  const revokedNames =
    keyEntries === null
      ? null
      : keyEntries
          .filter((f) => f.name.endsWith('.key.revoked'))
          .map((f) => f.name.replace(/\.key\.revoked$/, ''));
  return { keyNames, revokedNames };
}
