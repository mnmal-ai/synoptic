// wireMCP — Synoptic host SOUTHBOUND-seam config emitter (north-star
// `neutral-agent-coordination-substrate`). Given a target harness + the Substrate
// agent identity, emit the MCP-server config that harness needs to reach the
// shared context store, serialised in that harness's own file + format.
//
// The DATA plane is uniform across every harness: a stdio MCP server (`substrate
// mcp`) carrying an env block with SUBSTRATE_URL + SUBSTRATE_AGENT_KEY_PATH +
// SUBSTRATE_AGENT_KEY_ID. Only the config FILE PATH and SERIALISATION differ — JSON
// `mcpServers` for most, a TOML `[mcp_servers.*]` table for Codex, a
// settings.json MERGE for Gemini/Codex (their MCP block lives inside a larger
// config). This is the SOLVED, deterministic half of the harness seam; the
// cold-start half (instruction-file projection + deliverColdStart) is separate.
//
// HARNESSES is the executable form of the `harness-capability-matrix` Concept
// (web-verified). `wireMCP` consumes only the `.mcp` slice; the
// instruction/cold-start fields are descriptive metadata the cold-start
// projector will consume next.

/** @typedef {'claude-code'|'kimi'|'cursor'|'gemini'|'codex'|'opencode'|'muse'} Harness */

export const HARNESSES = {
  'claude-code': {
    instructionFile: 'CLAUDE.md',
    autoLoadsInstructions: true,
    injectionHook: 'session-start',
    coldStartTier: 'live-inject',
    mcp: {
      projectPath: '.mcp.json',
      userPath: '~/.claude.json',
      format: 'json',
      envStyle: 'var-expansion',
      merge: false
    }
  },
  kimi: {
    instructionFile: 'AGENTS.md',
    autoLoadsInstructions: false,
    injectionHook: null,
    coldStartTier: 'manual-prime',
    mcp: {
      projectPath: '.kimi-code/mcp.json',
      userPath: '~/.kimi-code/mcp.json',
      format: 'json',
      envStyle: 'literal',
      merge: false
    }
  },
  cursor: {
    instructionFile: '.cursor/rules/substrate.mdc',
    autoLoadsInstructions: true,
    injectionHook: null,
    coldStartTier: 'auto-file',
    mcp: {
      projectPath: '.cursor/mcp.json',
      userPath: '~/.cursor/mcp.json',
      format: 'json',
      envStyle: 'literal',
      merge: false,
      toolCeiling: 40
    }
  },
  gemini: {
    instructionFile: 'GEMINI.md',
    autoLoadsInstructions: true,
    injectionHook: null,
    coldStartTier: 'auto-file',
    mcp: {
      projectPath: '.gemini/settings.json',
      userPath: '~/.gemini/settings.json',
      format: 'json',
      envStyle: 'literal',
      // The MCP block is one key inside a larger settings.json — emit a
      // fragment the caller merges, never a standalone overwrite.
      merge: true
    }
  },
  codex: {
    instructionFile: 'AGENTS.md',
    autoLoadsInstructions: true,
    // Generic onboarding retains the self-query fallback. The optional local
    // cortext-codex plugin now supplies SessionStart / compact reinjection and
    // inbox seams once installed and its hooks trusted (Codex 0.161.0+).
    injectionHook: null,
    coldStartTier: 'auto-file',
    mcp: {
      projectPath: '.codex/config.toml',
      userPath: '~/.codex/config.toml',
      format: 'toml',
      envStyle: 'literal',
      // Codex MCP lives in the shared config.toml under [mcp_servers.*] — a
      // fragment to merge into the existing TOML, plus an allowlist caveat.
      merge: true
    }
  },
  opencode: {
    instructionFile: 'AGENTS.md',
    autoLoadsInstructions: true,
    // No session-start hook: the cortext-opencode skin injects the cold-start
    // via `experimental.chat.system.transform` on first dispatch per session.
    injectionHook: 'system-transform',
    coldStartTier: 'live-inject',
    mcp: {
      projectPath: 'opencode.json',
      userPath: '~/.config/opencode/opencode.json',
      format: 'opencode-json',
      // `{env:VAR}` interpolation refs, never `${VAR}` (not substituted) —
      // and never literals for the key path: opencode.json is committed.
      envStyle: 'interpolation',
      // The MCP block is one key inside the larger opencode.json — emit a
      // fragment the caller merges, never a standalone overwrite.
      merge: true
    }
  },
  muse: {
    instructionFile: 'AGENTS.md',
    // Trust-gated: project rules load only after the workspace is trusted.
    autoLoadsInstructions: true,
    // Measured on muse 1.2.1: project `.muse/hooks.json` SessionStart fires on
    // a trusted workspace and its stdout is injected as a developer-role
    // context block — the same live-inject tier as Claude Code.
    injectionHook: 'session-start',
    coldStartTier: 'live-inject',
    mcp: {
      // No project-scope file: `.muse/settings.json` is ignored (measured —
      // a probe server placed there never appears in startup diagnostics).
      // One fleet server serves every project, so this is user scope only;
      // identity is the machine kid and rows are tagged per-project instead.
      projectPath: null,
      userPath: '~/.config/muse/settings.json',
      format: 'muse-json',
      // Literals: the user settings file is machine-local, never committed.
      envStyle: 'literal',
      // The MCP block is one key inside the larger settings.json — emit a
      // fragment the caller merges, never a standalone overwrite.
      merge: true
    }
  }
};

/**
 * The spawn command for the substrate MCP server. Prefer a local install via
 * `--mcp-bin` (`node <bin> mcp` — no registry auth); otherwise the published
 * package via npx, which needs a GH-Packages-authed ~/.npmrc.
 */
function serverCommand(id) {
  return id.mcpBin
    ? { command: 'node', args: [id.mcpBin, 'mcp'] }
    : { command: 'npx', args: ['-y', '@mnmal-ai/substrate', 'mcp'] };
}

function serverEnv(id) {
  return {
    SUBSTRATE_URL: id.substrateUrl,
    SUBSTRATE_AGENT_KEY_PATH: id.keyPath,
    SUBSTRATE_AGENT_KEY_ID: id.kid
  };
}

/**
 * Minimal TOML for the one shape we emit: a `[mcp_servers.<name>]` table with a
 * string `command`, a string-array `args`, and a `[mcp_servers.<name>.env]`
 * subtable of string values. TOML basic strings share JSON string escaping for
 * our value space (URLs, POSIX paths, kids — no control characters), so
 * JSON.stringify yields a valid TOML basic string.
 */
function emitToml(serverName, entry) {
  const q = (s) => JSON.stringify(s);
  const lines = [
    `[mcp_servers.${serverName}]`,
    `command = ${q(entry.command)}`,
    `args = [${entry.args.map(q).join(', ')}]`,
    '',
    `[mcp_servers.${serverName}.env]`,
    ...Object.entries(entry.env).map(([k, v]) => `${k} = ${q(v)}`),
    ''
  ];
  return lines.join('\n');
}

/**
 * OpenCode's dialect differs on every key: in 2.x servers live under
 * `mcp.servers` (not `mcpServers`, and not 1.x's bare `mcp.<name>`, which 2.x
 * still migrates) inside opencode.json, `type: 'local'` is required, `command`
 * is a string ARRAY, and env rides under `environment`. `codemode: false`
 * because 2.x otherwise hides a local server's tools behind its generic
 * `execute` tool: the model never sees `substrate_*` by name, and an agent
 * following the conventions concludes it has no substrate tools. Identity values are
 * emitted as `{env:VAR}` interpolation refs — never literals: opencode.json
 * is committed, and a key path or kid baked in here would be machine-specific
 * (the indirected arrangement from substrate-setup Step 4.3).
 * SUBSTRATE_URL stays literal; it is the fleet-public value.
 */
function emitOpencode(serverName, id) {
  const cmd = serverCommand(id);
  return `${JSON.stringify(
    {
      mcp: {
        servers: {
          [serverName]: {
            type: 'local',
            command: [cmd.command, ...cmd.args],
            codemode: false,
            environment: {
              SUBSTRATE_URL: id.substrateUrl,
              SUBSTRATE_AGENT_KEY_PATH: '{env:SUBSTRATE_AGENT_KEY_PATH}',
              SUBSTRATE_AGENT_KEY_ID: '{env:SUBSTRATE_AGENT_KEY_ID}'
            }
          }
        }
      }
    },
    null,
    2
  )}\n`;
}
/**
 * Muse's dialect: the block is `mcpServers` (the binary migrates a
 * `mcp_servers` key to this spelling on load — measured, against docs that
 * still print the snake_case form) inside settings.json, each server carrying
 * an explicit stdio `transport`. `enabled: true` + `mode: 'optional'` are
 * emitted explicitly: optional is the measured default and matches this
 * repo's never-break-dispatch posture (a down Substrate warns instead of aborting
 * the run; the cold-start hook degrades to its offline note beside it).
 * Identity rides as literals — the user settings file is machine-local and
 * never committed.
 */
function emitMuse(serverName, entry) {
  return `${JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          transport: 'stdio',
          // Bare `node` relies on PATH, which the MCP child's cleared spawn
          // env lacks (measured `spawn_or_connect_failed`); the interpreter
          // running this onboarding is the correct absolute one. The npx
          // fallback passes through with the other harnesses' PATH caveat.
          command: entry.command === 'node' ? process.execPath : entry.command,
          args: entry.args,
          env: entry.env,
          enabled: true,
          mode: 'optional'
        }
      }
    },
    null,
    2
  )}\n`;
}
/**
 * Emit the MCP-server config to connect `harness` to the Substrate context store as
 * the given identity.
 *
 * @param {Harness} harness
 * @param {{ substrateUrl: string, kid: string, keyPath: string, mcpBin?: string }} id
 * @param {{ scope?: 'project'|'user', serverName?: string }} [opts]
 * @returns {{ harness: Harness, path: string, format: 'json'|'toml'|'opencode-json'|'muse-json', merge: boolean, content: string }}
 */
export function wireMCP(harness, id, opts = {}) {
  const caps = HARNESSES[harness];
  if (caps === undefined) {
    throw new Error(
      `wireMCP: unknown harness '${harness}' (known: ${Object.keys(HARNESSES).join(', ')})`
    );
  }
  const serverName = opts.serverName ?? 'substrate';
  const entry = { ...serverCommand(id), env: serverEnv(id) };
  const path = opts.scope === 'user' ? caps.mcp.userPath : caps.mcp.projectPath;
  if (path === null) {
    throw new Error(
      `wireMCP: '${harness}' has no project-scope config (one fleet server, user scope only) — use { scope: 'user' }`
    );
  }
  const merge = caps.mcp.merge;

  const content =
    caps.mcp.format === 'toml'
      ? emitToml(serverName, entry)
      : caps.mcp.format === 'opencode-json'
        ? emitOpencode(serverName, id)
        : caps.mcp.format === 'muse-json'
          ? emitMuse(serverName, entry)
          : `${JSON.stringify({ mcpServers: { [serverName]: entry } }, null, 2)}\n`;

  return { harness, path, format: caps.mcp.format, merge, content };
}
