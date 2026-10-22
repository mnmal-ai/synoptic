# @mnmal-ai/cortext-opencode — Cortext for OpenCode

The OpenCode skin for the [Cortext](../cortext/README.md) coordination
capability: the same synoptic cold-start (Concepts, Agent Memory, Open Work,
Agent Rules, Inbox) the Claude Code skin injects, delivered through a
`context` session hook on first dispatch per session (OpenCode 2.x
`Plugin.define({ id, setup })`; a V1 `server()` entrypoint is bundled for
OpenCode 1.x compat).

## Install

1. Plugin entry in the repo's `opencode.json`. The object form carries
   per-project identity — `options.kid` / `options.key` win over the
   `SUBSTRATE_AGENT_*` env pair:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       {
         "package": "@mnmal-ai/cortext-opencode",
         "options": {
           "kid": "synoptic-opencode@YourHost",
           "key": "/home/you/.config/substrate/keys/synoptic-opencode.key"
         }
       }
     ]
   }
   ```

   The plain string form (`"plugins": ["@mnmal-ai/cortext-opencode"]`) also
   works — identity then comes from the env pair. **Keep exactly one entry
   per package**: as of opencode v2.0.24 the `plugins`
   arrays concatenate across global + project config and loads dedupe only
   by exact source string, so a global string entry plus a project object
   entry for the same package load the plugin twice and double-inject the
   cold-start. When adding the object entry, remove the global string entry.

   npm plugins install automatically via Bun at startup. This package is
   public on npmjs.com, as is the `@mnmal-ai/substrate` dep; no token needed.

2. MCP server — merge into the same `opencode.json` (see
   `commands/substrate-setup.md` Step 4 for the full procedure). **The MCP server
   must sign as the same identity as the plugin**: the plugin shows
   mail for its `options.kid`, and only that kid may ack it. With
   `options.kid`/`options.key`, give the MCP `environment` the same kid and
   key, as literals in a user-level config rather than `{env:…}` refs that a
   GUI launch leaves empty:

   ```json
   {
     "mcp": {
       "servers": {
         "substrate": {
           "type": "local",
           "command": ["npx", "-y", "@mnmal-ai/substrate", "mcp"],
           "codemode": false,
           "environment": {
             "SUBSTRATE_URL": "https://substrate.example.com:3100",
             "SUBSTRATE_AGENT_KEY_PATH": "{env:SUBSTRATE_AGENT_KEY_PATH}",
             "SUBSTRATE_AGENT_KEY_ID": "{env:SUBSTRATE_AGENT_KEY_ID}"
           }
         }
       }
     }
   }
   ```

   `"codemode": false` matters: OpenCode 2.x otherwise hides the
   server's tools behind its `execute` tool, so the agent never sees
   them and cannot ack mail. With it off they arrive prefixed by the server
   name: `substrate_query`, `substrate_whoami`, and so on. On OpenCode 1.x use bare `mcp.substrate`
   without `codemode`.

3. Conventions — nothing to do. The plugin injects the conventions from its
   own package on every dispatch, so they always match the installed
   version. An older hand-copied `.opencode/substrate-conventions.md` is named in
   the session context as stale; delete it and its `"instructions"` entry.

4. Restart opencode (config loads once at startup). Or run `/substrate-setup`
   (copy `commands/substrate-setup.md` to `.opencode/commands/`) for the guided
   version of all of the above plus capability probing, AgentRule seeding,
   identity provisioning, and the first anchor.

## Environment

| Var | Meaning | Default |
|---|---|---|
| `SUBSTRATE_URL` | Substrate base URL (required for live context) | — (offline note) |
| `SUBSTRATE_NAMESPACE` | Coordinator namespace | `cortext` |
| `SYNOPTIC_PROJECT_SCOPE=all` | Cross-project scope (omit project filter) | repo basename |
| `SUBSTRATE_AGENT_KEY_PATH` / `SUBSTRATE_AGENT_KEY_ID` | Ed25519 identity for signed reads + mail | anonymous |
| plugin-config `options.kid` / `options.key` | V2 object plugin entry identity — wins over the env pair, per-project, survives GUI launch where shell env does not. **All or nothing**: setting either uses the options pair only, never half from env | falls back to the env pair |
| plugin-config `options.url` / `options.ns` | Override `SUBSTRATE_URL` / `SUBSTRATE_NAMESPACE` for the plugin, for a launch whose process env carries neither | the env values |
| `SYNOPTIC_INBOX_PUSH` | `off` disables mid-turn push (V2); the prompt and end-of-turn seams carry on | on |
| `SYNOPTIC_INBOX_WAKE` | `on` lets new mail start a turn in an idle session (6 per hour, 2 per thread) | off |
| `SYNOPTIC_INBOX_URGENT_FROM` | Comma-separated kids whose `priority:urgent` mail may interrupt a turn (3 per hour, 20 s grace for a running tool) | unset |

## How it maps to the Claude skin

| Claude (`cortext-plugin`) | OpenCode (this package) |
|---|---|
| `SessionStart` hook → `hooks/cold-start.mjs` | `prompt` prewarm + `context` session-hook inject (once per session, cached; V1 compat via `experimental.chat.system.transform`) |
| `UserPromptSubmit` inbox re-check | V2: each prompt after the first re-reads unread mail, and every dispatch of that turn carries the same summary line. `SYNOPTIC_INBOX_PROMPT_CHECK=off` disables it |
| `Stop` inbox check (blocks once) | V2: a `session.execution.succeeded` event with unread mail queues one synthetic message carrying the same reason, with `resume: true`. Each message id nudges once. `SYNOPTIC_INBOX_STOP_CHECK=off` disables it |
| Mid-turn push (`inbox-bridge`) | V2: the watcher runs in-process; new mail is steered into every busy session, allowlisted urgent mail preempts the most recently prompted session, and idle wake is opt-in. While the watcher is live the per-prompt summary is skipped; the end-of-turn nudge stays |
| `skills/{council,todos}` | `skills/{council,todos}` — byte-identical pointer bodies (`test/skills-sync.test.ts` enforces) |
| `fragments/substrate-conventions.md` | `instructions/substrate-conventions.md` — shared body, own marker (`test/instructions-sync.test.ts` enforces) |
| `/substrate-setup` skill | `commands/substrate-setup.md` — opencode paths + MCP dialect |
| SessionStart `compact` re-run | `compaction` session hook: drops the cache (next dispatch rebuilds) + leaves a pointer in the summary |
| Fragment-drift watchdog | **Deferred** — the check reads the `.claude/` install path; see `src/plugin.ts` header |

## Build

`dist/plugin.js` is a committed, byte-deterministic tsdown bundle with zero
runtime deps (same convention as `cortext-plugin/hooks/*.mjs`): `pnpm build
&& git diff --stat dist/` must return empty. The `@opencode-ai/plugin`
import is type-only; `@opencode/plugin` is imported from its dependency-free
`promise/plugin` deep module (`define` is an identity function), so the
bundle stays self-contained.
