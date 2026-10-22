---
name: substrate-setup
description: Onboard this repo as a consumer of the cortext coordinator. Probes the target Substrate, wires SUBSTRATE_URL, installs the conventions fragment + import, wires the substrate MCP server (project-scoped, identity-ready), and seeds baseline AgentRules. Run once per repo. Triggers: "set up substrate", "/substrate-setup", "onboard substrate".
---

# /substrate-setup — onboard a cortext consumer

Run these steps in order. This skill is **idempotent** — re-running it never duplicates the import line or rules, and refreshes the conventions fragment only when the plugin's copy differs from the installed one.

## Step 0 — is THIS DOCUMENT current?

**Before following anything below, run the audit and read its `plugin.served`
line.** If it says the served skill text is RETIRED, stop and re-read this skill
from the installed version before acting on any of it.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/audit.mjs" --target-dir "$PWD"
```

Skill text is served from a plugin cache directory bound at session start, and
**nothing reconciles it.** The conventions fragment has a resolver that installs
over a stale copy and an audit line that reports drift; this document has
neither. So a session can be handed a superseded instruction and follow it
correctly, with no signal anywhere that a newer one exists.

Two things worth knowing about the check:

- **It does not need `CLAUDE_PLUGIN_ROOT`.** The audit locates itself: it is run
  as `<servedRoot>/bin/audit.mjs`, so it is inside the tree that served this
  document and reads that tree's version. The env var is used when present and
  is not required.
- **It cannot retrofit itself.** A cache copy older than v1.13.4 has no such
  check, so being served one produces silence rather than a warning. Once you
  are on a version that carries it, staleness is loud from then on — but the
  first stale read after upgrading is the one nobody can warn you about.

## `--audit` — read-only, run it first

If the user asked for an audit, or the repo is already onboarded and you only
want to know what has drifted, run this and **stop**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/audit.mjs" --target-dir "$PWD"
```

It **writes nothing** — no consent gate, no questions, safe to run unprompted.
Exit `0` when everything checked out, `1` when anything warned **or could not be
verified**. Report its output verbatim.

Three states, and the third is the point:

| | meaning |
|---|---|
| `[ok  ]` | verified, and good |
| `[WARN]` | verified, and bad |
| `[????]` | **NOT VERIFIED** — the check could not run |

**A `[????]` is a hole in the audit, not a pass.** Do not summarise it as "mostly
fine" or fold it into the ok count. It means the audit hit the same failure mode
it exists to detect, one level up: an operation that could not establish its
answer and must not be mistaken for one that established a good answer.

What it reconciles: the **marketplace pin** against what this machine
installed; the plugin cache against `installed_plugins.json` and against
whatever served this session; the repo's fragment against the best available;
the signing identity against the key files and the `AgentIdentity` directory;
key files against directory rows in both directions; and the inbox push
switches as this repo resolves them (a value that is neither `on` nor `off` is
flagged, because it silently does nothing).

**`--fleet <parent-dir>` answers a question no other check can.** Every other
instrument here is single-repo: the cold-start drift check compares THIS repo
against the local plugin, and `--audit` without `--fleet` answers "is this repo
current". Neither can answer "are my repos consistent" — several repos can
hold different fragment bodies with nothing flagging it. Pass `--fleet` the directory holding your repos and it reports the SPREAD.

**`--fetch` is worth passing when you care about the answer.** Without it the
pin is read from whatever the local marketplace clone last fetched, and that
clone can itself be behind while every other check reports healthy. Without `--fetch` the audit says so, as a
`[????]`, rather than trusting it.

It resolves identity from the **running MCP server**, not from its own
environment — those differ, and an audit reading its own env reports "no
identity" on a correctly configured box.

## Step 1 — get SUBSTRATE_URL

Ask the user for their Substrate base URL (e.g. `https://substrate.example.com:3100`) unless `SUBSTRATE_URL` is already in the repo's `.claude/settings.json` `env`.

Write it into `.claude/settings.json` under a top-level `env` object (create the file/keys if absent; never clobber existing keys):

```json
{ "env": { "SUBSTRATE_URL": "<the url>" } }
```

## Step 2 — probe capability

Using the `substrate` MCP tools (or `curl -sfk` as fallback), check each of the following and report it as ✓/✗:

1. **Reachable:** `GET <SUBSTRATE_URL>/health` → 200.
2. **Coordinator present (hard prerequisite):** `schema` includes the coordinator namespace — `cortext` by default, or whatever `SUBSTRATE_NAMESPACE` names (look for `cortext/AgentRule`, `cortext/Todo`). If absent, **STOP** and tell the user: "The cortext coordinator isn't loaded on this Substrate. Install it server-side before onboarding — I can't seed rules or recall context without that namespace."
   - The legacy `claude` namespace is **retired** — it resolves to `unknown_namespace`. If you find `claude/*` but not `cortext/*`, the server is running a pre-migration coordinator; say so rather than onboarding against a dead namespace.
   - Every `<ns>/...` frame key below follows this same namespace. Substitute it consistently; do not hardcode `claude`.
3. **Recall capability:** `GET <SUBSTRATE_URL>/substrate/v1/embed-stats` → `enabled`. `true` = hybrid cold-start available; `false` = structural-only (degrade).
4. **MCP package resolvable** (only matters if Step 4 will wire the npx-based server): run `npm view @mnmal-ai/substrate version`. It is public on npmjs.com and needs no token. If it fails, print this and continue:
   > `@mnmal-ai/substrate` is public on npmjs.com. If `npm view` fails, check network access, and that no `~/.npmrc` maps `@mnmal-ai` to another registry (an old `@mnmal-ai:registry=https://npm.pkg.github.com` line does).

Print a capability summary block.

## Step 3 — install the conventions fragment + import

1. **Run the resolver. Do not copy the file by hand.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/resolve-fragment.mjs" --target-dir "$PWD" --apply
   ```

   It prints the reconciliation it acted on and exits `0` installed-or-current,
   `1` refused, `2` skipped-because-this-repo-ships-the-fragment. **Report its
   output verbatim** — the resolution is the evidence.

   ```
   substrate-conventions fragment — resolution
     pin/installed:  1.9.0
     served skill:   1.7.1   <- STALE: bound at session start, before the install
     cache holds:    8 version(s) (newest 1.9.0, oldest 1.2.0)
     repo has:       v1.0.1+446ab494
     -> chose 1.9.0+e25b9217 from cache/1.9.0
     -> INSTALL
   ```

   - **Exit 1 is a refusal, not a failure to try.** The only source available
     was OLDER than the version this machine has installed. Nothing was
     written. Tell the user to refresh the plugin cache, and do **not** work
     around it by copying a file.
   - **Exit 2 means this repo is the source** (`packages/cortext-plugin/fragments/`
     exists). Its working tree is authoritative and may be ahead of the last
     release, so copy `packages/cortext-plugin/fragments/substrate-conventions.md`
     over `.claude/substrate-conventions.md` rather than installing from the
     plugin cache. The `version` script keeps that copy in sync from then on.

   Why a command rather than an instruction: `${CLAUDE_PLUGIN_ROOT}` is **bound
   at session start** — a session running when the plugin updated keeps
   pointing at the directory it was launched with, so a path under it can name
   a stale fragment. The resolver reads
   `installed_plugins.json` and the cache directly, so a stale copy of the
   resolver still resolves correctly.

   The rules it enforces, for reference — you do not need to apply them by hand:
   **overwrite whenever the digests differ** (the `+<sha8>` half is a digest of
   the body, so a content fix that ships without a version bump still moves the
   marker; gating on "newer" would leave such a fix unpropagated), but **never install below the installed
   version**. Both halves are needed: same version + different digest is an
   install; a lower version is a refusal.

2. Import it from the repo's **untracked** `CLAUDE.local.md`, so contributors who don't use Cortext never load it:
   - Ensure `<repo>/CLAUDE.local.md` contains the line `@.claude/substrate-conventions.md` (create the file, or append the line once if absent; never modify other lines).
   - Ensure `<repo>/.gitignore` lists both `CLAUDE.local.md` and `.claude/substrate-conventions.md` (append whichever is missing).
   - If `<repo>/CLAUDE.md` still has the line `@.claude/substrate-conventions.md` from an older setup, remove that one line and touch nothing else.
   - If `git ls-files --error-unmatch .claude/substrate-conventions.md` succeeds, the fragment is still tracked: run `git rm --cached .claude/substrate-conventions.md` and tell the user to commit the untracking with the `.gitignore` and `CLAUDE.md` changes on a branch.

## Step 4 — wire the substrate MCP server (project `.mcp.json`, identity-ready)

The plugin does **not** bundle an MCP server (a plugin-provided server can't be disabled per-machine and would duplicate or fight an existing one). Wire it as a **project `.mcp.json`** — that file names the server; per-project agent identity rides separately via `.claude/settings.local.json` (Step 7).

**Where identity actually comes from.** Two separate mechanisms, easy to conflate:

- **`${VAR}` expansion** in `.mcp.json` reads the shell `claude` was launched from **and nothing else**. A settings `env` value is never a source for it: an unexpandable ref is passed through literally, with a `Missing environment variables` warning.
- **Process inheritance** is different: `.claude/settings.json` and `.claude/settings.local.json` `env` **are** passed into the MCP server's environment at spawn.

Measured on Claude Code 2.1.286 with a stub server that dumps its own env, launched from a shell carrying neither variable: `settings.local.json` and `settings.json` values both arrived, and `"EXPANDED": "${VAR}"` arrived as the literal string. Same result via a project `.mcp.json` and via `--mcp-config`.

So identity must NOT be named in `.mcp.json` `env`: a variable named there is resolved by expansion, which only the launch shell can satisfy, and it shadows the inherited settings value. Omit both identity keys and let the server inherit them from `settings.local.json`.

Project scope is still the right default: the server definition and its `SUBSTRATE_URL` are versioned **with the repo**, a fresh clone gets a working server, and a user-scope server would leave every repo signing as the same machine-wide identity instead of `<project>-claude@<host>`.

1. **Existing project server?** `claude mcp get substrate`. If it reports **Project config (`.mcp.json`)**, ensure its `env` block carries `SUBSTRATE_URL` + the two identity refs below (add any missing; never clobber), then go to sub-step 3.
2. **Write `./.mcp.json`** (create it, or add the `substrate` server to an existing file — never clobber other servers):

   ```json
   {
     "mcpServers": {
       "substrate": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@mnmal-ai/substrate", "mcp"],
         "env": {
           "SUBSTRATE_URL": "<the url>"
         }
       }
     }
   }
   ```

   No identity keys in `env` — that is the whole arrangement, not an omission. The server inherits `SUBSTRATE_AGENT_KEY_ID` / `SUBSTRATE_AGENT_KEY_PATH` from `.claude/settings.local.json` `env` at spawn (Step 7). Naming them here would hand them to launch-shell expansion instead, and shadow the settings layer.

   **The failure to guard against is SILENT ANONYMITY.** If `settings.local.json` carries no identity, the server starts with none and the client sends no `Authorization` — it degrades to anonymous while looking configured. So do not treat a working server as a signed one: Step 7.6's `createdBy` check, or `whoami` returning your kid rather than `identity: null`, is the only confirmation. The cold-start hook also says `agent identity misconfigured … reads are anonymous` when it cannot load a key.

   - **Operator box** (a local `@mnmal-ai/substrate` install, e.g. a machine running the runtime): prefer absolute paths to `node` + the substrate bin over `npx` — no registry/auth dependency at session start. e.g. `"command": "/abs/.../node", "args": ["/abs/.../@mnmal-ai/substrate/dist/substrate.js", "mcp"]`.
   - The `npx` form needs `npx` available in Claude Code's *launch* environment, not just the interactive shell (Step 2.4's check ran in a shell; GUI/tmux/remote launches can differ).

3. **Gitignore it — if it carries machine-specific values.** The test is the file's **content**, not its name. Add `.mcp.json` to the repo's `.gitignore` when it holds an absolute interpreter or bin path, a hardcoded kid or host, or a literal secret — the operator-box form above is exactly this, and must never be committed.

   The `npx` form above *should* be committed: no machine paths, no identity, only a public `SUBSTRATE_URL` literal. A fresh clone gets a working server with no setup step, and identity stays in each machine's Step 7 settings.

   Do not write `${VAR}` refs into `.mcp.json`: they expand from the launch shell only, so a file that looks portable silently depends on shell state.

4. **Enable + reconnect.** Ensure `.claude/settings.local.json` has `enableAllProjectMcpServers: true` (or `enabledMcpjsonServers: ["substrate"]`) so the project server auto-approves. It connects on the **next session start** (or `/mcp` → reconnect) — a freshly written `.mcp.json` does **not** take effect mid-session.

   - A pre-existing **user-scope** `substrate` server is harmless (project scope wins) but is now redundant for this repo; mention it so the user can `claude mcp remove substrate -s user` if they want.

## Step 5 — seed baseline AgentRules (coverage-first, deselectable)

**Check coverage BEFORE showing anyone a catalogue.** On a mature store every
baseline is usually already covered by a richer, differently-worded rule, and
asking the user to deselect from five items that are all redundant is pure
noise. It gets worse over time, not better — rule stores only accumulate.

1. Query `<ns>/AgentRule` (active, `project: null` and this project) and read the
   existing `rule` texts.

   **There is no `key` field.** `cortext/AgentRule` does not declare one at all —
   not null-on-every-row, absent. The fields are `rule, category, severity,
   active, pinned, synopsis, rationale, expressesConcept, archived, project,
   shortId`. Any instruction to "match on `key`" is wrong; substance-matching is
   the only path, not a fallback.

   Exact `rule`-text equality is also useless here — established deployments
   carry richer wording that covers the same ground. Compare **substance**.

2. The baseline catalogue (universal tier → `project: null`):

| key | category | rule |
|---|---|---|
| `mcp-call-style` | style | Never echo MCP payloads or tool parameters in chat; describe calls in plain language. |
| `concise-responses` | style | No trailing summaries of what was just done; keep responses tight. |
| `git-feature-branch` | process | Always work on a feature branch and open a PR; never commit directly to main. |
| `mcp-first` | tooling | Use MCP tools for all Substrate interactions; fall back to HTTP only when MCP is confirmed unreachable. |
| `cold-start-adherence` | process | At session start, read the injected cold-start context before acting. |

   (The `key` column names each baseline **for this document**. It is not a
   field and must not be sent.)

3. **Report coverage, then ask only about the remainder.** If everything is
   covered, say so in one line and create nothing:

   > Baseline rules: all 5 already covered (`mcp-call-style` → #15,
   > `concise-responses` → #7, `git-feature-branch` → #3, `mcp-first` → #6,
   > `cold-start-adherence` → #44). Nothing to seed.

4. For anything genuinely uncovered, show the user the proposed rule and let
   them deselect. Where a baseline is *partly* covered, show both texts and let
   them decide rather than creating a weaker near-duplicate — seeding duplicates
   is far more costly than skipping, since they compete for cold-start budget
   and the older, richer rule usually wins on merit.

5. Create the remainder with `<ns>/createAgentRule`, `project: null`,
   `active: true`, `severity: "should"` (or `"must"` where the catalogue implies
   a safety boundary), and the category from the table. Batch them in one
   mutation (array under the op-key).

6. Report created vs skipped.

## Step 6 — recall degradation notice

If Step 2 found recall **disabled**, tell the user plainly:

> Recall (semantic memory) is **off** on this Substrate — no embedder configured. Your cold-start will run **structural-only** (recency/importance ordering). It will **auto-upgrade** to hybrid recall the moment an embedder comes online — no need to re-run setup. A guided `/substrate-setup recall` to stand up the embedder is planned (not yet available).

## Step 7 — agent identity: DETECT first, prescribe only if needed

**Do not write an identity carrier before checking whether one is already
working.** Writing one anyway adds a second, redundant carrier for values
already supplied.

### 7.1 — detect

Run the audit and read its `identity` block:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/audit.mjs" --target-dir "$PWD"
```

If it reports a resolved kid that is registered with a key file present,
**identity is already wired**. Say so and skip to Step 8:

> identity: already wired as `<kid>` (source: MCP server env) — nothing to do.

Note it resolves from the **running MCP server**, not from your own shell.
Those differ: the shell often carries no `SUBSTRATE_AGENT_KEY_ID` while the MCP
child does. Do not "check" by echoing your own environment — you will get a
false negative on a correctly configured box.

### 7.2 — the recommended arrangement, if identity is NOT yet wired

Put the concrete values in the repo's own `.claude/settings.local.json`
(`env`), which is per-repo, per-machine, and already gitignored. One block:

```json
{ "env": {
    "SUBSTRATE_URL": "<the url>",
    "SUBSTRATE_NAMESPACE": "<ns>",
    "SUBSTRATE_AGENT_KEY_ID": "<project>-claude@<host>",
    "SUBSTRATE_AGENT_KEY_PATH": "<home>/.config/substrate/keys/<project>-claude.key"
} }
```

The MCP server inherits these at spawn (Step 4 names no identity keys, so
nothing shadows them), and the hooks fill any gaps from this same file when
the launching shell carries nothing — a plain shell then holds no identity at
all, which is the correct answer for a shell running no session. Consequences,
all of them better than the shell-carried form this replaces:

- per-repo, **typed once** — no `cwd`-basename derivation, so the subdirectory
  failure mode (an unregistered kid whose *present* key 401s every read as
  "substrate offline") cannot occur;
- the host is canonicalised in one literal per repo instead of re-derived per
  template;
- rotation touches one file in one repo, and only that repo's sessions.

Do not carry identity in a parent `mise.toml` or other shell env: it exports
into EVERY shell under the tree, agent or not. If one still names
`SUBSTRATE_AGENT_*`, delete those lines once every repo under it carries its own
settings.

**Inbox push: optional, and nothing to write by default.** Since synoptic 2.4.0
the plugin delivers agent mail mid-turn, through a hooks module that runs an SSE
watcher. It is on as soon as identity is wired, so this step adds nothing for it.
The same `env` block takes three optional switches. Write one only when the
operator asks for it:

| key | default | set it when |
|---|---|---|
| `SYNOPTIC_INBOX_PUSH` | on | `"off"` returns this repo to summary lines at the prompt and at Stop. This is the rollback, and it needs no release |
| `SYNOPTIC_INBOX_WAKE` | off | `"on"` lets mail that arrives while the session is idle start a turn, within 6 per hour and 2 per thread |
| `SYNOPTIC_INBOX_URGENT_FROM` | unset | the operator runs a coordinator: its kids, comma-separated, whose `priority:urgent` mail may stop a running turn. The tag alone grants nothing |

A change to any of these takes effect at the **next session start**, including
`--continue`. `/reload-plugins` keeps an unchanged hooks module loaded, so the
watcher never re-reads them. Do not suggest `SYNOPTIC_INBOX_URGENT_FROM` unprompted:
it lets another agent interrupt this repo's work.

### 7.3 — declare the stable half in the repo

Whatever supplies the host, the repo should declare its own agent **name** —
the half that is machine-independent — in `.claude/settings.json`:

```json
{ "env": { "SYNOPTIC_AGENT_NAME": "<project>-claude" } }
```

No host, no key path, no secret, so this is **committable and portable**. Its
job is to give the audit something to compare a derivation against: without it,
a resolved kid cannot drift *or* be verified, and the subdirectory case above
becomes a loud mismatch instead of a silent unregistered identity.

### 7.4 — provision a key, only if there is none

Consent-gated. Skipping is first-class: the repo keeps the machine-wide default.

> Assign this repo its own signing identity? This generates an Ed25519 keypair,
> registers its public key with your Substrate (an operator action), and signs this
> repo's writes as `<project>-claude@<host>`. [y/N]

**Treat generate → register → restart as ONE unit.** A generated-but-
unregistered key is strictly worse than no key: with no key the MCP server reads
anonymously and cold-start degrades gracefully; once the file exists the server
signs with it, Substrate rejects the unknown kid, and every read fails `401`. If you
cannot finish registration now, either do not generate the key yet, or move it
aside (`mv "$KEYFILE" "$KEYFILE.pending"`) — and tell the user which.

```bash
mkdir -p ~/.config/substrate/keys && chmod 700 ~/.config/substrate/keys
KID="$(basename "$(git rev-parse --show-toplevel)")-claude@$(hostname -s)"
KEYFILE=~/.config/substrate/keys/$(basename "$(git rev-parse --show-toplevel)")-claude.key
if [ ! -f "$KEYFILE" ]; then
  openssl genpkey -algorithm ed25519 -out "$KEYFILE"
  chmod 600 "$KEYFILE"
  openssl pkey -in "$KEYFILE" -pubout -out "${KEYFILE%.key}.pub"
fi
echo "kid = $KID"
```

Register (admin, operator-on-box — registration cannot go through the `substrate`
MCP tools, whose agent-JWT only ever claims `read,mutate`), then restart so the
binary re-primes its key registry:

```bash
substrate-admin register "$KID" --pubkey "${KEYFILE%.key}.pub" \
  --ns "<ns>,recall" --caps read,mutate
sudo systemctl restart substrate-binary   # or however your Substrate service is run
```

**`--ns` is not optional.** `substrate-admin` refuses without it — its usage
reads `--ns <csv> is REQUIRED (use --ns '*' to grant every namespace)` — because
a wildcard issued by omission would produce no error and no review surface. Say
what you are granting.

**Why `recall` is in the list.** A kid granted only the coordinator namespace
still works, which is what makes it dangerous: frames against `recall` are
rejected per-key with `unauthorized_namespace`, and the cold-start degrades to
the importance × recency ranker behind a rejected-frames banner rather than
failing. The render looks complete and simply carries a different heading.

Substitute `<ns>` for the coordinator namespace in use (`cortext` by default,
or whatever `SUBSTRATE_NAMESPACE` names), exactly as elsewhere in this document. Pass a
wider grant only if the agent genuinely reads more namespaces, and pass
`--ns '*'` only as a deliberate, stated choice — never as a shortcut.

If `substrate-admin` is absent or prints `unknown command: register`, do NOT fail
the setup — print the two commands **including the flags** for the operator to
run out-of-band and continue. A grant is what an operator approves; a command
that hides it gives them nothing to approve.

`--audit` re-reads this from the server (`authority`) and reports the grant it
actually finds — `whoami` is post-intersection, so it answers what the key
HOLDS rather than what the command asked for. A mistake here surfaces on the
next audit rather than staying invisible until someone reads the key table.

### 7.5 — seed the directory row

Registering a key does not populate the directory. The `_system/Key` row
proves the signature; `<ns>/AgentIdentity` is what makes this agent
**discoverable** as a routing peer. Skip if a row with this `kid` exists:

```
<ns>/createAgentIdentity { kid: "<KID>", project: "<project>",
                           host: "<host>", displayName: "<Project>", active: true }
```

### 7.6 — verify, and check the settings file you are about to write

Do a write and read its `_metadata.createdBy`; it must read
`{kind:'agent', id:'<KID>'}`.

**If you write `.claude/settings.local.json`, `JSON.parse` it before and after.**
A pre-existing syntax error means Claude Code is *silently ignoring the whole
file* — one missing comma drops `enableAllProjectMcpServers` and every
permission while the file reads as though both applied.
Merging into a file whose contents are already being discarded produces a change
that cannot take effect. Fail loudly on a pre-existing error rather than adding
to it. The audit in 7.1 reports this too.

## Step 8 — write the first anchor, then confirm

**Onboarding does not seed an `AnchorIntent`, and a repo without one ranks its
rules STRUCTURALLY.** `rankRules` scores rules against the anchor's vector; with
no anchor the semantic half cannot run at all, however well the rule corpus is
embedded. That is a silent degrade — the cold-start renders, recall answers,
every check says healthy, and the ranking is simply worse.

`--audit` distinguishes *never had one* (the normal state right
after onboarding — this step) from *every anchor archived* (a focus that ended
and was not replaced).

So write one, as the last act of onboarding or the first act of the next
session:

```
<ns>/createAnchorIntent { project: "<project>", synopsis: "<what this repo is
                          for and what is being worked on right now>" }
```

**Do not seed a placeholder to silence the warning.** The ranker scores against
the anchor's OWN vector, so `"onboarded this repo"` is not a neutral default —
it is semantic noise aimed at the whole rule set, and it trades a visible,
accurate WARN for a silent, subtly-degraded ranker. An honest warning is worth
more than a filled slot. Write a real intent or leave it empty and fix it in
the first working session.

Then summarise what was wired: where `SUBSTRATE_URL` lives, the fragment + import line, the MCP server (pre-existing vs newly added, and its scope), how many rules were created, the recall tier (hybrid vs structural), and the agent identity (per-project kid vs machine-wide default). Tell the user to start a new session (or `/clear`) to see the synoptic cold-start.
