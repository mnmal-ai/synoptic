// onboard — the Synoptic host's public entry point: turn the whole hand-done
// "onboard a new agent to the shared context store" saga into ONE call.
// Composes the three southbound primitives:
//   1. provisionIdentity (identity)  → the `<agent>@<host>` signing kid + keys + steps
//   2. wireMCP            (config)    → the harness's MCP-server config (path + content)
//   3. projectColdStart  (context)   → the harness's instruction doc + cold-start tier
//
// Returns a complete PLAN — the identity steps to run + the files to write +
// any prime hint. Execution stays the caller's (a thin CLI / installer): the
// pure emitters are safe to auto-apply; provisionIdentity's privileged steps
// (prod-DB register, restart) are surfaced for an operator. Onboarding a NEW
// harness is now a one-line `HARNESSES` descriptor entry, not a research
// expedition.

import { cortext } from './capabilities/cortext.js';
import { projectColdStart } from './cold-start-projector.js';
import { provisionIdentity } from './provision-identity.js';
import { HARNESSES, wireMCP } from './wire-mcp.js';

/** Agent label per harness. Most agents are named for their harness; Claude
 *  Code signs as `claude` (the historical kid stem), not `claude-code`. */
const AGENT_LABEL = { 'claude-code': 'claude' };

/**
 * @param {'claude-code'|'kimi'|'cursor'|'gemini'|'codex'|'opencode'|'muse'} harness
 * @param {{ host?: string, project: string, substrateUrl: string, mcpBin?: string,
 *           keyDir?: string, capability?: object, scope?: 'project'|'user', agent?: string }} opts
 */
export function onboard(harness, opts = {}) {
  if (HARNESSES[harness] === undefined) {
    throw new Error(
      `onboard: unknown harness '${harness}' (known: ${Object.keys(HARNESSES).join(', ')})`
    );
  }
  const agent = opts.agent ?? AGENT_LABEL[harness] ?? harness;
  // The capability supplies the cold-start content; Cortext is the default (and
  // only, today) capability. Swapping it re-targets onboarding at another store.
  const capability = opts.capability ?? cortext;

  // Identity is per-agent-per-host. The `project` scopes the cold-start doc's
  // orient query, NOT the signing kid (an agent onboarded into `app` signs as
  // `cursor@host-a`, not `cursor-app@…`).
  // The capability declares which namespaces it reads/writes; that list IS the
  // authority the registered key needs, so it is passed straight through to
  // `--ns` rather than re-derived here. Anything registered without it
  // lands on `*`.
  const identity = provisionIdentity(agent, {
    namespaces: capability.namespaces,
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.keyDir !== undefined ? { keyDir: opts.keyDir } : {})
  });

  // Muse has no project-scope MCP file (one fleet server, user scope only),
  // so it defaults to user scope unless the caller says otherwise — at which
  // point wireMCP refuses loudly rather than emitting a file Muse ignores.
  const scope = opts.scope ?? (harness === 'muse' ? 'user' : undefined);
  const mcp = wireMCP(
    harness,
    {
      substrateUrl: opts.substrateUrl,
      kid: identity.kid,
      keyPath: identity.keyPath,
      ...(opts.mcpBin !== undefined ? { mcpBin: opts.mcpBin } : {})
    },
    scope !== undefined ? { scope } : {}
  );

  const doc = projectColdStart(harness, { project: opts.project, capability });

  const files = [
    { kind: 'mcp', path: mcp.path, content: mcp.content, format: mcp.format, merge: mcp.merge },
    { kind: 'instructions', path: doc.path, content: doc.content }
  ];

  return {
    harness,
    agent,
    capability: capability.name,
    kid: identity.kid,
    identity,
    files,
    primeHint: doc.primeHint
  };
}
