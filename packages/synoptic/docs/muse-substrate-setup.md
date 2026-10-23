# /substrate-setup (Muse) — onboard a Muse consumer — DRAFT

Status: draft on `feature/muse-harness-onboarding`. Every Muse-specific claim
below was measured against `muse` 1.2.1 (see appendix); anything taken from
docs rather than measurement is marked as such.

Run these steps in order. This flow is **idempotent** — re-running it never
duplicates config entries or rules.

Steps 2, 5, 6, 8 are transport-agnostic and identical to the OpenCode skin's
`/substrate-setup` (`packages/cortext-opencode/skills/substrate-setup/SKILL.md`); only
the file paths, the MCP dialect, and the hook wiring differ. Where this
document says "same as", it means it — do not improvise a second procedure.

The cared-about slice for Muse is Substrate onboarding + proper agent identity,
but the scope is the full flow adapted, not identity-half only.

## Step 1 — get SUBSTRATE_URL + identity env

Ask the user for their Substrate base URL (e.g. `https://substrate.example.com:3100`)
unless it is already exported in their shell.

Identity is a **machine kid**, not per-project: `muse@<host>` (the fleet runs
one Substrate for all projects; rows are tagged per-project instead). The
recommended arrangement is one block above all repos, e.g. in `mise.toml`:

```toml
[env]
SUBSTRATE_URL = "https://substrate.example.com:3100"
SUBSTRATE_AGENT_KEY_ID = "muse@YourHost"
SUBSTRATE_AGENT_KEY_PATH = "{{ env.HOME }}/.config/substrate/keys/muse@YourHost.key"
```

Two caveats that bite Claude migrants:

- **Hook commands do NOT inherit these.** A hook's process gets a cleared
  environment (measured: `HOME`, `PATH`, `USER` and little else — no
  `SUBSTRATE_*`). Every `.muse/hooks.json` command that talks to Substrate must set
  its own env inline (see Steps 3–4 for the exact commands).
- The MCP server below carries its own literals in settings.json, so it is
  unaffected — but anything else that signs (audit scripts, curl probes)
  reads this block.

## Step 2 — probe capability

Same as the OpenCode skin's Step 2 (reachable, coordinator present with the
`claude`-namespace-retired caveat, recall tier, MCP package resolvability).
Print a capability summary block.

## Step 3 — conventions into AGENTS.md + SessionStart hook

Muse auto-loads `AGENTS.md` on trusted workspaces (untrusted checkouts ignore
it until trusted). There is **no fragment + import pattern**: `@`-references
in `AGENTS.md` are passed through literally (measured with `@./file`,
`@file`, and `@/abs/path` — the line arrives in context, the body never
does). So the projected document (`projectColdStart('muse', …)` output, which
is the full conventions + cold-start text) is written **directly into
`AGENTS.md`** — append once if absent, never clobber existing content.

Cold-start delivery is a project SessionStart hook. Write
`<repo>/.muse/hooks.json` (Claude-style schema — measured working):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "SUBSTRATE_URL=\"https://substrate.example.com:3100\" SUBSTRATE_AGENT_KEY_ID=\"muse@$(hostname -s)\" SUBSTRATE_AGENT_KEY_PATH=\"$HOME/.config/substrate/keys/muse@$(hostname -s).key\" SYNOPTIC_COLD_START_MAX_BYTES=15000 SYNOPTIC_HARNESS=muse /abs/.../node /abs/.../@mnmal-ai/synoptic/src/cold-start-entry.js"
          }
        ]
      }
    ]
  }
}
```

Notes:

- The hook's stdout is injected as a developer-role context block at session
  start (measured: `context_block_updated`, `lifecycle: session_start`) —
  the same live-inject tier as Claude Code. The command never throws and
  never blocks start: no URL prints the offline note, a slow Substrate loses a
  9s race to the same degrade.
- **Cap the output.** Muse kills a hook whose stdout exceeds 16384 bytes and
  parses nothing (`output_too_large` — measured with the ~100 KB full
  render). `SYNOPTIC_COLD_START_MAX_BYTES=15000` keeps the render under the
  ceiling with margin: `truncateToBudget` cuts at a newline boundary and
  appends a pull pointer (`query` for rules/memory/open work), so the
  brief, the session block, and the first must-rules arrive intact. Blank or
  malformed values mean uncapped (the Claude hook serves the full document
  today).
- **Name the harness.** `SYNOPTIC_HARNESS=muse` makes this host's
  `HostInstall` row say which harness ran. The value must be a harness
  synoptic knows; anything else, or nothing, records `hook`.
- Absolute `node` path (measured: the MCP/Hook spawn env does not resolve
  bare names the way an interactive shell does).
- Inline env derives the kid from `hostname -s`, so the file stays portable
  and committable — no machine values baked in.
- Hooks are discovered and validated at session startup: start a **new
  session** to load. A malformed file contributes no handlers and warns.

## Step 4 — wire the substrate MCP server (user settings.json, identity-ready)

Unlike the Claude skin (project `.mcp.json`), Muse has **no project-scope
MCP file** — `.muse/settings.json` is ignored (measured: a probe server
placed there never appears in startup diagnostics). There is one fleet
server for every project, so this is **user scope only**. Merge this into
`~/.config/muse/settings.json` (never clobber other servers or keys; the
file must keep `"schema_version": 1`):

```json
{
  "mcpServers": {
    "substrate": {
      "transport": "stdio",
      "command": "/abs/.../node",
      "args": ["/abs/.../@mnmal-ai/substrate/dist/substrate.js", "mcp"],
      "env": {
        "SUBSTRATE_URL": "<the url>",
        "SUBSTRATE_AGENT_KEY_PATH": "/home/<you>/.config/substrate/keys/muse@<host>.key",
        "SUBSTRATE_AGENT_KEY_ID": "muse@<host>"
      },
      "enabled": true,
      "mode": "optional"
    }
  }
}
```

(`wireMCP('muse', id, { scope: 'user' })` emits exactly this; project scope
refuses loudly rather than writing a file Muse ignores.)

Three dialect notes that bite Claude migrants: the block is `mcpServers`
(the binary migrates a `mcp_servers` key to this spelling on load — measured,
against docs that still print the snake_case form); an explicit stdio
`transport` per server; and `mode: "optional"` (the measured default —
a down Substrate warns instead of aborting the run, matching this repo's
never-break-dispatch posture). Start a **new session** after writing:
config loads once at startup.

## Step 5 — seed baseline AgentRules (coverage-first, deselectable)

Same catalogue and same procedure as the OpenCode skin's Step 5 (query
`<ns>/AgentRule`, compare substance not text, report coverage, ask only about
the remainder, batch-create). Transport-agnostic.

## Step 6 — recall degradation notice

Same as the OpenCode skin's Step 6: structural-only now, auto-upgrades when
an embedder comes online, no re-run needed.

## Step 7 — agent identity: DETECT first, provision only if needed

`GET <SUBSTRATE_URL>/substrate/v1/whoami` from a signed shell. If the Step-1 kid
(`muse@<host>`) resolves to a registered row with a present key file, say so
and skip.

Otherwise — consent-gated, generate → register → restart as ONE unit (a
generated-but-unregistered key 401s every read, strictly worse than none):

```bash
mkdir -p ~/.config/substrate/keys && chmod 700 ~/.config/substrate/keys
KID="muse@$(hostname -s)"
KEYFILE=~/.config/substrate/keys/muse@$(hostname -s).key
if [ ! -f "$KEYFILE" ]; then
  openssl genpkey -algorithm ed25519 -out "$KEYFILE"
  chmod 600 "$KEYFILE"
  openssl pkey -in "$KEYFILE" -pubout -out "${KEYFILE%.key}.pub"
fi
```

Register (operator, admin — not via MCP tools): `substrate-admin register
"$KID" --pubkey "${KEYFILE%.key}.pub" --ns "<ns>,recall"
--caps read,mutate`, restart the binary, then seed the directory row
(`<ns>/createAgentIdentity { kid, host, project: null, displayName,
active: true }`) so the agent is routable for mail. Verify with a write and
read its `_metadata.createdBy` — must be `{kind:'agent', id:'<KID>'}`.

Inbox wiring (the interrupt half — measured, not degraded to poll): add to
the repo's `.muse/hooks.json` beside the SessionStart entry, same inline-env
pattern, pointing at the synoptic entries:

- `Stop` → `…/src/inbox-stop-entry.js`: unread mail blocks the stop ONCE
  with a compact summary (Claude's `{"decision":"block","reason"}` protocol
  is honored verbatim, including the `stop_hook_active` loop guard; the
  reason is injected as developer context). Kill switch:
  `SYNOPTIC_INBOX_STOP_CHECK=off`.
- `UserPromptSubmit` → `…/src/inbox-prompt-entry.js`: mail that arrived
  while idle is injected additively, never blocking. Kill switch:
  `SYNOPTIC_INBOX_PROMPT_CHECK=off`.

Both are silent no-ops without identity and on any transport failure — a
down Substrate never wedges a session at its seams.

## Step 8 — write the first anchor, then confirm

Same as the OpenCode skin's Step 8 (one real `AnchorIntent`, never a
placeholder), then summarise: SUBSTRATE_URL source, AGENTS.md write, hook
entries, MCP server form, rules created vs skipped, recall tier, identity.
Tell the user to start a new session to see the injected cold-start.

## Appendix — measured Muse facts (muse 1.2.1)

| Claim | Basis |
|---|---|
| Project hooks at `<root>/.muse/hooks.json`, Claude-style `{"hooks":{event:[{hooks:[{type,command}]}]}}` schema | marker-file firing test, trusted workspace |
| Untrusted workspace: project hooks do not fire | marker absent, `workspace is untrusted` |
| SessionStart/Stop/UserPromptSubmit stdout → developer-role `context_block_updated` | session-log records (`lifecycle: session_start` / `stop` / `user_prompt_submit`) |
| Stop stdin carries `stop_hook_active`; `{"decision":"block","reason"}` blocks once and continues the turn | block-once probe: turn ran twice, reason injected |
| MCP block is `mcpServers` (binary migrates `mcp_servers`) | binary rewrote the settings file on load |
| Default server `mode` is `optional`, not `required` as docs print | bootstrap diagnostics on an entry with no `mode` |
| Bare `node` fails MCP spawn (`spawn_or_connect_failed`); absolute path connects (`ready` on startup/handshake/discovery, tools as `mcp__substrate__*`) | bootstrap diagnostics, before/after |
| `.muse/settings.json` is ignored | probe server never in diagnostics |
| `@`-references in AGENTS.md are not expanded (`@./f`, `@f`, `@/abs/f`) | fragment body absent from loaded rules |
| `.agents/memory/MEMORY.md` index auto-injected at session start (`memory_snapshot`, project scope) | session-log record |
| Hook processes get a cleared env (no parent `SUBSTRATE_*`) but keep `PATH` | `env` capture probe |
| Hook stdout over 16384 bytes kills the hook with `output_too_large` and parses nothing — cap via `SYNOPTIC_COLD_START_MAX_BYTES` | live session log (`hook_run_terminal`, `status: failed`, 693ms) |
