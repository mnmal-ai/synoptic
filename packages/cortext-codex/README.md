# Cortext for Codex

A locally installed Codex plugin over the existing Synoptic host and Cortext
store. Tested against Codex CLI **0.161.0–0.162.1**. The compatibility manifest is used
because this installed runtime discovers `.codex-plugin/plugin.json` metadata;
portable-root metadata was not exposed by the discovery probe.

This initial pass implements option 2: no coordinator, scheduler, automatic
idle wake, or changes to the Claude/OpenCode adapters.

| Lifecycle | Behaviour |
|---|---|
| `SessionStart` (`startup`, `resume`, `clear`, `compact`) | Fresh shared cold-start render plus conventions, added as developer context; records this host in `cortext/HostInstall` under harness `codex` (`SYNOPTIC_HOST_REPORT=off` disables) |
| `UserPromptSubmit` | Compact unread-mail notice |
| `Stop` | Unread mail requests one continuation; `stop_hook_active` prevents a loop |
| `$cortext:council`, `$cortext:todos` | Same live Substrate skill pointers as Claude and OpenCode |
| `$cortext:substrate-run` | Many store reads and writes in one `substrate run` script; same steps as the Claude skill, with the binary and identity from `.codex/cortext.local.json` |
| `$cortext:architecture-review` | Evidence-backed plan/spec review; requested discussion with named peers through the mailbox |
| `$cortext:substrate-setup` | Codex-specific wiring and diagnosis |

The store, authentication, rendering, and inbox logic are reused, not forked.
Hook scripts are committed, self-contained bundles. They only contact the
explicitly configured Substrate endpoint. They do not start a model, download
dependencies, phone home, or create another state database. Model inference
continues to use the provider configured in Codex.

## Configure

`.codex/config.toml` is Codex's native configuration: it enables the plugin.
`.codex/cortext.local.json` is **plugin-owned**, the analogue of Claude's local
`env` settings for this integration; Codex itself does not interpret this JSON.
Unlike setting `[mcp_servers.substrate.env]`, it supplies both the hooks and MCP.

The bundled MCP server is named **`cortext-substrate`**, not `substrate`, so its tools
read `mcp__cortext-substrate__query` and so on. If a user-level
`[mcp_servers.substrate]` also exists, turn it off for the repo with
`[mcp_servers.substrate] enabled = false` in `.codex/config.toml`. Codex keys that
switch by name, so a shared name would disable both.

**Codex caches the plugin by version.** It copies this package into
`~/.codex/plugins/cache/synoptic-codex-local/cortext/<version>/` and re-copies
only when the version changes. To pick up a local edit under the same version,
run `codex plugin remove cortext@synoptic-codex-local` then `codex plugin add
cortext@synoptic-codex-local` (deleting the directory uninstalls the plugin
rather than refreshing it). A change to `.mcp.json` also needs the background
`codex app-server` restarted, which holds MCP server settings in memory.

**The MCP server locates itself through that cache.** Codex (0.162.1) does not
expand `${PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_ROOT}` in a plugin server's command
or args and passes it no plugin variable, and the server must run in the
project to find `.codex/cortext.local.json`. So `.mcp.json` starts `sh`, which
execs the installed `bin/substrate-mcp.mjs` under `${CODEX_HOME:-~/.codex}`.

Create **gitignored** `<repo>/.codex/cortext.local.json` with the operator's
endpoint, a distinct Codex identity, and an already installed MCP executable:

```json
{
  "env": {
    "SUBSTRATE_URL": "http://127.0.0.1:3100",
    "SUBSTRATE_NAMESPACE": "cortext",
    "SUBSTRATE_AGENT_KEY_ID": "synoptic-codex@YourHost",
    "SUBSTRATE_AGENT_KEY_PATH": "/absolute/path/outside/repo/codex.key"
  },
  "mcp": {
    "command": "/absolute/path/to/substrate",
    "args": ["mcp"]
  }
}
```

For an installed JS entrypoint, use an absolute Node executable as `command`
and `args: ["/absolute/path/to/dist/substrate.js", "mcp"]`. No `npx` install occurs.
Both hooks and MCP read these settings at the repo root, including sessions
started in a subdirectory. Shell environment values override settings. The kid
and key are an atomic pair: setting either in the shell prevents filling either
from the file. A partial or unreadable signing identity is diagnosed on stderr;
MCP refuses anonymous startup. Hooks remain nonblocking.

The loader never reads `.claude/settings.local.json` or OpenCode configuration.
`SYNOPTIC_PROJECT_SCOPE`,
`SYNOPTIC_COLD_START_MAX_BYTES`, `SYNOPTIC_HOST_REPORT`, `SUBSTRATE_AGENT_CAPABILITIES`,
`SYNOPTIC_AGENT_NAMESPACES`, `SYNOPTIC_INBOX_PROMPT_CHECK`, and
`SYNOPTIC_INBOX_STOP_CHECK` may also be set in the local `env` object. Unrelated
environment settings such as `PATH` and `NODE_OPTIONS` are ignored there.
Identity needs the operator-granted `cortext` and `recall` capabilities for the
shared cold-start. The plugin does not provision or expand those grants itself.

## Install locally

Build from this checkout, then add the package's self-contained local catalog:

```sh
pnpm --filter @mnmal-ai/cortext-codex build
codex plugin marketplace add /absolute/path/to/synoptic/packages/cortext-codex
```

Enable `cortext@synoptic-codex-local` using the local plugin browser, or merge
this section into the trusted target repo's `.codex/config.toml`:

```toml
[plugins."cortext@synoptic-codex-local"]
enabled = true
```

Restart Codex. Use `/hooks` to review and trust the three bundled definitions;
installation does not grant hook trust. Inspect `/mcp` for the bundled Substrate
connection. Avoid a second standalone Substrate connection with a different
identity. Until trust is granted, manually query shared context using MCP.

After editing local plugin files, refresh/reinstall the local plugin and restart;
Codex copies the plugin into its cache. Changed hook definitions need review
again. Keep the local package/catalog together when copying it elsewhere.

## Limits and rollback

Inbox delivery happens at prompt and stop boundaries. Idle agents need another
user turn; there is no persistent watcher or autonomous peer wake. Stop only
requests one continuation per stop chain and never acknowledges messages itself.
Mail is labelled as peer information, not user authority.

The cold-start is bounded to nine seconds and inbox checks to 3.5 seconds, with
fetch cancellation; outer hook timeouts are 12 and five seconds respectively.
Missing/invalid settings or failed requests allow normal work to continue. No
compaction replacement or arbitrary request-history rewriting is attempted.
Codex may spill large injected context to a local file at the configured
`additionalContextLimit` (5,000 approximate tokens). The optional byte budget
caps the live document, with a retrieval pointer, not the fixed conventions.

Generic Synoptic onboarding still emits `AGENTS.md` self-query instructions
for Codex without the plugin. Do not switch that fallback off globally.
Codex host-install reporting and conventions-file drift checks are deferred:
the current diagnostics inspect Claude install paths. Plugin conventions are
included directly in startup context instead.

Set the plugin's `enabled = false` and restart to disable both its hooks and
bundled MCP. Shared Cortext records remain accessible to other agents. This
package is local-only and private; no external marketplace rail is added.

## Verify

```sh
pnpm --filter @mnmal-ai/cortext-codex build
pnpm --filter @mnmal-ai/cortext-codex test
pnpm --filter @mnmal-ai/cortext-codex check-types
pnpm --filter @mnmal-ai/cortext-codex lint
```

Tests use temporary workspaces, disposable keys and loopback fixtures. They
exercise the committed bundles as well as the shared-service adapter. The
optional runtime smoke script uses a temporary Codex home and a mock model
endpoint, never the configured live Substrate or model provider.

```sh
node packages/cortext-codex/scripts/runtime-smoke.mjs
```

Run that command from the workspace root. The smoke uses a one-off hook-trust
bypass only in its disposable Codex home to exercise the already inspected test
plugin. It does not grant trust or change configuration in your real Codex home.
The runtime smoke verifies startup, prompt, and one Stop continuation. Compact
re-rendering is verified at the adapter boundary; a live runtime compaction
exercise remains a follow-up check.

Runtime contracts: [Codex hooks](https://learn.chatgpt.com/docs/hooks) and
[local plugins](https://developers.openai.com/plugins/build/plugins).
