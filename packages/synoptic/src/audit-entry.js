#!/usr/bin/env node

// Executable entry for `/substrate-setup --audit`. Bundled to
// `bin/audit.mjs` like the hooks and the resolver.
//
//   node bin/audit.mjs [--target-dir DIR] [--plugins-dir DIR]
//
// READ-ONLY. It opens no file for writing and sends no mutation. That is the
// whole design: a mode that writes nothing needs no consent gate, so it can run
// unprompted — the only way a check reaches people who were never going to run
// it deliberately.
//
// Exit 0 when every check passed, 1 when anything warned OR could not be
// verified. An unverified check is a hole in the audit, not a pass, so it does
// not get to exit 0.

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentAuth, makeSignedFetch } from './agent-auth.js';
import { check, renderAudit } from './audit.js';
import { gatherFleet } from './audit-facts/fleet.js';
import { buildGroups } from './audit-facts/groups.js';
import {
  readDeclaredKid,
  readDeclaredName,
  readKeyFiles,
  resolveIdentityFromMcp
} from './audit-facts/identity.js';
import { gatherKeyRefs } from './audit-facts/key-refs.js';
import { readPinFacts, readSkinFacts } from './audit-facts/pin.js';
import { gatherPluginFacts } from './audit-facts/plugin.js';
import { probeServer, readDirectory } from './audit-facts/server.js';
import { readOrNull } from './fs-safe.js';
import { envWithLocalFallback } from './local-env.js';
import { readMcpJsonFacts } from './mcp-json-facts.js';
import { sessionRoot } from './scope.js';
import { checkSettings } from './settings-check.js';

// `fetch` is a boolean; everything else takes a value. Without this, a bare
// `--fetch` swallows the following argument.
const BOOLEAN_FLAGS = new Set(['fetch']);

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    flags[name] = BOOLEAN_FLAGS.has(name) ? true : argv[++i];
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
// The repo ROOT, resolved: a relative path, a subdirectory or a
// symlinked $PWD otherwise missed the /proc cwd match and selfAudit, and read
// settings from the wrong directory.
const requestedDir = (() => {
  const dir = resolve(flags['target-dir'] ?? process.cwd());
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
})();
const targetDir = sessionRoot(requestedDir);
const pluginsDir = flags['plugins-dir'] ?? join(homedir(), '.claude', 'plugins');
const cacheDir = join(pluginsDir, 'cache', 'mnmal-ai', 'cortext');
const keysDir = join(homedir(), '.config/substrate/keys');

const envRoot = process.env.CLAUDE_PLUGIN_ROOT ?? null;
const selfRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = gatherPluginFacts({ pluginsDir, cacheDir, targetDir, envRoot, selfRoot });

// --- identity facts ---
const { kid, source } = resolveIdentityFromMcp(targetDir);
const { keyNames, revokedNames } = readKeyFiles(keysDir);

// The launching shell is not the identity carrier (see local-env.js): fill
// gaps from the target repo's own settings so a plain-shell audit answers
// about the target instead of about the auditor's shell. Process env wins.
const { env } = envWithLocalFallback(process.env, { targetDir });
const substrateUrl = env.SUBSTRATE_URL ?? null;
// ONE construction for the whole run. Several would invite them to disagree
// after a future edit, and each is another chance to drop `.warning`.
const agentAuth = createAgentAuth(env);
const fetchImpl = makeSignedFetch(agentAuth.getAuthHeader);
const directory = await readDirectory({ substrateUrl, env, fetchImpl });

// `createAgentAuth` computes the precise reason a configured credential
// failed to load and returns it as `warning`. Hand it to `auditAuthority`
// rather than re-deriving a WORSE diagnosis from whoami — "the env vars never
// took effect" when the fault is a missing key file.
const authWarning = agentAuth.warning;

const declaredKid = readDeclaredKid(targetDir);
const server = await probeServer({ substrateUrl, env, targetDir, fetchImpl, kid, declaredKid });

// The skill WRITES this file and merges into it, so it is the last
// place with a chance to notice that everything in it is being discarded.
const settingsFindings = checkSettings({
  settingsText: readOrNull(join(targetDir, '.claude', 'settings.local.json')),
  hasProjectMcp: existsSync(join(targetDir, '.mcp.json'))
}).map((f, i) => check(`settings.${i}`, f.state, f.text, f.detail));
const pinFacts = readPinFacts({ pluginsDir, fetch: flags.fetch === true });

const fleetDir = flags.fleet ?? null;
const fleet = await gatherFleet({
  fleetDir,
  directoryRows: directory.directoryRows,
  candidates: plugin.candidates,
  substrateUrl,
  env,
  fetchImpl
});
const refs = gatherKeyRefs({ fleetDir, targetDir, home: homedir() });
const skins = readSkinFacts({ home: homedir() });

const groups = buildGroups({
  ...plugin,
  kid,
  source,
  declaredName: readDeclaredName(targetDir),
  declaredKid,
  keyNames,
  revokedNames,
  ...directory,
  ...server,
  authWarning,
  env,
  targetDir,
  cwd: process.cwd(),
  settingsFindings,
  mcpJsonFacts: readMcpJsonFacts(targetDir),
  ...pinFacts,
  ...skins,
  ...fleet,
  ...refs
});

const report = renderAudit(groups);
console.log(report);
process.exit(/\[WARN\]|\[\?\?\?\?\]/.test(report) ? 1 : 0);
