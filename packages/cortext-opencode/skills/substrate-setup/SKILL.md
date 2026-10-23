---
name: substrate-setup
description: Onboard this repo as a Cortext consumer under OpenCode. Probes the target Substrate, wires the substrate MCP server in opencode.json (identity-ready), installs the conventions instructions, and seeds baseline AgentRules. Run once per repo.
---

# substrate-setup (OpenCode): onboard a cortext-opencode consumer

Run these steps in order. This skill is **idempotent** — re-running it never duplicates config entries or rules.

Steps 2, 5, 6, 8 are transport-agnostic and identical to the Claude skin's
`/substrate-setup`; only the file paths and the MCP dialect differ. Where this
document says "same as", it means it — do not improvise a second procedure.

## Step 1 — get SUBSTRATE_URL + identity env

Ask the user for their Substrate base URL (e.g. `https://substrate.example.com:3100`)
unless it is already exported in their shell.

The OpenCode skin reads `SUBSTRATE_URL`, `SUBSTRATE_NAMESPACE` (default `cortext`),
`SUBSTRATE_AGENT_KEY_PATH` and `SUBSTRATE_AGENT_KEY_ID` from the **opencode process
environment** — both for cold-start injection and, via `{env:VAR}` refs, for
the MCP server below. The recommended arrangement is one block above all
repos (same as the Claude skin's Step 7.2):

```toml
[env]
SUBSTRATE_URL = "https://substrate.example.com:3100"
SUBSTRATE_AGENT_KEY_ID = "{{ cwd | basename }}-opencode@YourHost"
SUBSTRATE_AGENT_KEY_PATH = "{{ env.HOME }}/.config/substrate/keys/{{ cwd | basename }}-opencode.key"
```

With `mise activate` in the shell rc, every repo gets a derived kid and the
opencode.json below stays portable. GUI-launched opencode (no shell env) gets
no identity — same caveat as the Claude skin's npx note; prefer terminal
launch when identity matters. **Exception:** the V2 skin also takes identity
from plugin config — the object plugin entry's `options.kid` / `options.key`
(Step 3) win over the env pair and survive GUI launch, since they ride in the
config file instead of the process env.

## Step 2 — probe capability

Using the `substrate` MCP tools (or `curl -sfk` as fallback), check each of the
following and report it as ✓/✗:

1. **Reachable:** `GET <SUBSTRATE_URL>/health` → 200.
2. **Coordinator present (hard prerequisite):** `schema` includes the
   coordinator namespace — `cortext` by default, or whatever `SUBSTRATE_NAMESPACE`
   names (look for `cortext/AgentRule`, `cortext/Todo`). If absent,
   **STOP**: "The cortext coordinator isn't loaded on this Substrate. Install it
   server-side before onboarding."
   - The legacy `claude` namespace is **retired** — `unknown_namespace`.
3. **Recall capability:** `GET <SUBSTRATE_URL>/substrate/v1/embed-stats` → `enabled`.
   `true` = hybrid cold-start; `false` = structural-only (degrades cleanly).
4. **MCP package resolvable** (only if Step 4 uses the npx server form):
   `npm view @mnmal-ai/substrate@next version`. It is public on npmjs.com, so a
   failure here is a network or registry-mirror problem, not missing auth.

Print a capability summary block.

## Step 3 — install the plugin + conventions instructions

1. Add the plugin to the repo's `opencode.json` (create it if absent; never
   clobber existing keys). Prefer the object form — it carries the per-project
   identity through `options`, which wins over the Step-1 env pair:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       {
         "package": "@mnmal-ai/cortext-opencode@next",
         "options": {
           "kid": "<the Step-1 kid>",
           "key": "<the Step-1 key file>"
         }
       }
     ]
   }
   ```

   The plain string form (`"plugins": ["@mnmal-ai/cortext-opencode@next"]`) also
   works — identity then comes from the env pair. **Keep exactly one entry
   per package**: as of opencode v2.0.24 the `plugins`
   arrays concatenate across global + project config and loads dedupe only
   by exact source string, so a global string entry plus a project object
   entry for the same package load the plugin twice and double-inject the
   cold-start. If the plugin is already in the global config as a string
   entry, remove that entry when adding the project object entry.

   npm plugins install automatically via Bun at startup (cached under
   `~/.cache/opencode/`). No registry auth is needed.

2. Install the skills. OpenCode loads no skills from a plugin package, so
   copy them to the user skills directory, where every repo sees them. Bun
   installs the plugin at startup, so restart opencode after step 1 first.
   Re-run this after each plugin update; the copy does not track the package.

   ```bash
   PKG=$(ls -d ~/.cache/opencode/npm/@mnmal-ai/cortext-opencode@next/*/node_modules/@mnmal-ai/cortext-opencode | sort | tail -1)
   mkdir -p ~/.config/opencode/skills && cp -R "$PKG/skills/." ~/.config/opencode/skills/
   ```

   That installs `council`, `todos`, `substrate-run` and this skill.

3. Conventions need no step: the plugin injects them from its own package
   on every dispatch, so they track the installed version. If the
   repo has an older `.opencode/substrate-conventions.md` copy, delete it and its
   `"instructions"` entry; the session context names it while it is stale.
   (`AGENTS.md` needs no import line: opencode auto-loads it, and nothing in
   this setup writes to it.)

## Step 4 — wire the substrate MCP server (opencode.json, identity-ready)

Unlike the Claude skin (project `.mcp.json`), OpenCode servers live in
`opencode.json` under `mcp.servers` — same file as the plugin entry. Merge
this in (never clobber other servers).

**Sign the MCP server as the plugin's identity**. The plugin shows
mail for its identity and only that kid may ack it, so a mismatch shows mail
the session cannot close. If Step 3 used `options.kid` / `options.key`, put
the same kid and key in this server's `environment` as literals, in a
user-level config, instead of the `{env:…}` refs below, which a GUI launch
leaves empty:

```json
{
  "mcp": {
    "servers": {
      "substrate": {
        "type": "local",
        "command": ["npx", "-y", "@mnmal-ai/substrate@next", "mcp"],
        "codemode": false,
        "environment": {
          "SUBSTRATE_URL": "<the url>",
          "SUBSTRATE_AGENT_KEY_PATH": "{env:SUBSTRATE_AGENT_KEY_PATH}",
          "SUBSTRATE_AGENT_KEY_ID": "{env:SUBSTRATE_AGENT_KEY_ID}"
        }
      }
    }
  }
}
```

**`"codemode": false` is required.** OpenCode 2.x defaults a local
server to code mode, which hides its tools behind the generic `execute` tool:
the server connects, but the model never sees `substrate_*` by name, so an agent
following the conventions reports that it has no substrate tools and cannot ack
its mail. OpenCode prefixes each tool with its server name, so they reach the
model as `substrate_query`, `substrate_mutate`, `substrate_whoami` and so
on. Confirm after a restart (bounce `opencode serve --service`, not just the
TUI) that the session calls `substrate_whoami` directly and gets its kid.

Dialect notes that bite Claude migrants: servers go under `mcp.servers`, not
`mcpServers` (OpenCode 1.x used bare `mcp.<name>`, which 2.x still migrates;
on 1.x, drop the `servers` level and the `codemode` key); `type: "local"` is
required; `command` is an **array**; env
rides under `environment`; interpolation is `{env:VAR}`, **not** `${VAR}`
(which is passed through literally). The `{env:}` refs resolve against the
Step-1 environment and stay inert until identity exists.

- **Operator box** (local `@mnmal-ai/substrate` install): prefer
  `"command": ["/abs/.../node", "/abs/.../substrate.js", "mcp"]` — no registry
  dependency at session start. A committed file holding absolute paths is
  machine-specific: gitignore `opencode.json` in that case, as with the
  Claude skin's operator-box rule.
- **Restart opencode** after writing: config loads once at startup.

## Step 5 — seed baseline AgentRules (coverage-first, deselectable)

Same catalogue and same procedure as the Claude skin:

1. Query `<ns>/AgentRule` (active, `project: null` and this project) and read
   the existing `rule` texts. There is no `key` field; compare **substance**,
   not text equality — mature stores already cover these with richer wording.
2. Baselines (universal tier → `project: null`): `mcp-call-style` (never echo
   MCP payloads in chat), `concise-responses` (no trailing summaries),
   `git-feature-branch` (PRs, never main), `mcp-first` (MCP tools, HTTP only
   when unreachable), `cold-start-adherence` (read the injected context
   before acting).
3. Report coverage; ask only about the remainder; batch-create with
   `<ns>/createAgentRule` in one mutation.

## Step 6 — recall degradation notice

If Step 2 found recall **disabled**, tell the user plainly: cold-start runs
**structural-only** (recency/importance ordering) and **auto-upgrades** to
hybrid recall when an embedder comes online — no re-run needed.

## Step 7 — agent identity: DETECT first, provision only if needed

`GET <SUBSTRATE_URL>/substrate/v1/whoami` from a signed shell (or `substrate-admin list`
from the operator box, which reads postgres directly). If the Step-1 kid
resolves to a registered row with a present key file, say so and skip.

Otherwise — consent-gated, generate → register → restart as ONE unit (a
generated-but-unregistered key 401s every read, strictly worse than none):

```bash
mkdir -p ~/.config/substrate/keys && chmod 700 ~/.config/substrate/keys
KID="$(basename "$(git rev-parse --show-toplevel)")-opencode@$(hostname -s)"
KEYFILE=~/.config/substrate/keys/$(basename "$(git rev-parse --show-toplevel)")-opencode.key
if [ ! -f "$KEYFILE" ]; then
  openssl genpkey -algorithm ed25519 -out "$KEYFILE"
  chmod 600 "$KEYFILE"
  openssl pkey -in "$KEYFILE" -pubout -out "${KEYFILE%.key}.pub"
fi
```

Register (operator, admin — not via MCP tools): `substrate-admin register
"$KID" --pubkey "${KEYFILE%.key}.pub" --ns "<ns>,recall"
--caps read,mutate`, restart the binary, then seed the directory row
(`<ns>/createAgentIdentity`) so the agent is routable for mail. Verify with
a write and read its `_metadata.createdBy` — must be `{kind:'agent',
id:'<KID>'}`.

## Step 8 — write the first anchor, then confirm

Onboarding does not seed an `AnchorIntent`, and a repo without one ranks its
rules **structurally** (no semantic half). Write one real intent — never a
placeholder (`"onboarded this repo"` is semantic noise aimed at the rule
set):

```
<ns>/createAnchorIntent { project: "<project>", synopsis: "<what this repo is for and what is being worked on right now>" }
```

Then summarise: SUBSTRATE_URL source, plugin entry, instructions copy, MCP
server form, skills installed, rules created vs skipped, recall tier, identity (per-project
kid vs fleet default). Tell the user to restart opencode — config loads once
at startup, and the cold-start injects on the first dispatch after that.
