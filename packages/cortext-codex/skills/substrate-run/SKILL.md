---
name: substrate-run
description: "Run a short TypeScript script against Substrate with `substrate run`, so many reads and writes cost one tool call and return one small result. Use for multi-step store work: censuses and counts, joins across types, recall-then-hydrate, and batch writes driven by reads. Do NOT use for a single lookup or a single write; the substrate MCP tools are simpler there. Requires substrate >= 1.0.0-alpha.6."
---

`substrate run` imports one `.mts` script, calls its default export with a signed
`ScriptContext`, and prints one JSON report. Many queries and mutations run in a
single tool call, and only the result the script returns reaches your context.

## 0. Find the binary and the identity

**Requires substrate >= 1.0.0-alpha.6.** Older binaries have no `run` subcommand.

Both come from the repo's `.codex/cortext.local.json`, the file the plugin's
hooks and MCP server already read:

- **The binary** is what `mcp` names. If `mcp.command` is a Node executable,
  the binary is `node` plus `mcp.args[0]` (a path ending `substrate.js`).
  Otherwise `mcp.command` is the substrate executable itself.
- **The identity** is `env.SUBSTRATE_URL`, `env.SUBSTRATE_AGENT_KEY_ID` and
  `env.SUBSTRATE_AGENT_KEY_PATH`. Codex does not pass that file to your shell,
  so `substrate run` sees none of them unless you set them on the command.
  A value your shell already exports wins, as it does for the hooks. Use
  only the key's path; never read or print the key file.

```bash
node -e "const c=require('./.codex/cortext.local.json'); console.log(c.mcp, c.env.SUBSTRATE_URL, c.env.SUBSTRATE_AGENT_KEY_ID)"
node /abs/path/to/substrate.js --version
```

Write every run as one literal command, values filled in:

```bash
env SUBSTRATE_URL=https://substrate.example.com:3100 SUBSTRATE_AGENT_KEY_ID=repo-codex@host SUBSTRATE_AGENT_KEY_PATH=/abs/path/to/repo-codex.key node /abs/path/to/substrate.js run script.mts
```

If the version is below `1.0.0-alpha.6`, stop and use the MCP tools instead.
Say that the local substrate install is behind and that updating it unlocks
this skill.

**It refuses to run unsigned**, so a refusal names a missing identity rather
than a broken script. A connection error instead usually means the sandbox
blocks network access; ask to run the command outside it.

## 1. When to use it, and when not to

| Use `substrate run` | Use the MCP tools |
|---|---|
| A count or census over many rows (`queryAll` pages to the end) | One lookup by id, shortId or name |
| A join: rows of one type, then the rows they reference | One write |
| Recall, then fetch the bodies of the few hits worth reading | Exploring the schema |
| A batch of writes chosen by what a read found | Anything you will read only once, row by row |

The test: if you would otherwise make three or more MCP calls and pass ids from
one call to the next, write a script.

## 2. Write the script outside the repo

Scripts are throwaway. Put them in the session scratchpad directory, or a temp
directory if the harness gives you none, never in the repo.

```ts
import type { ScriptContext } from '@mnmal-ai/substrate/client';

// node /abs/path/to/substrate.js run open-by-project.mts --args '{"ns":"cortext"}'
export default async function (s: ScriptContext) {
  const ns = String(s.args.ns ?? 'cortext');
  const open = await s.queryAll(`${ns}/Todo`, {
    params: { where: { status: { eq: 'open' }, archived: { eq: false } }, limit: 100 },
    fields: { id: true, project: true }
  });
  const byProject: Record<string, number> = {};
  for (const t of open) byProject[String(t.project ?? 'null')] = (byProject[String(t.project ?? 'null')] ?? 0) + 1;
  return { total: open.length, byProject };
}
```

The namespace is `cortext` unless `SUBSTRATE_NAMESPACE` says otherwise. Pass it
in through `--args` instead of hardcoding it. The `import type` line is erased
at load, so the script needs no `node_modules` beside it.

The context:

| Member | Does |
|---|---|
| `s.args` | The `--args` JSON object, frozen. `{}` when omitted |
| `s.query(frame)` | One query frame. **Throws if any key you asked for is missing from `data`**: a rejected frame fails the run with the server's `errors` instead of reading as empty. Adds a warning when a result is truncated (`hasMore`) |
| `s.queryAll(key, { params, fields })` | Every row of one key, paging until `hasMore` is false |
| `s.recall({ query, namespace, type?, k?, threshold?, where?, row? })` | Hits, best first. `row` holds `id` plus the handle fields; pass `row: { body: true }` (or `true`) only on the call whose hits you will read |
| `s.mutate(payload)` | One mutate payload. Throws by default, records without sending under `--dry-run`, sends under `--write`. Throws when the server refuses any frame |
| `s.log(...)` | stderr only. The report owns stdout |
| `s.kid`, `s.mode` | The signing kid and `read` / `dry-run` / `write` |

## 3. Reduce in the script

Return counts, ids, short handles, a verdict. Never return whole rows "to look
at". Filtering, grouping and joining belong in the script, because what it
returns lands in your context.

When the result is large, pass `--out <file>` (beside the script). The report
goes to the file and stdout gets one line. Then read only what you need from
the file.

## 4. Writes: dry run, read, then write

The default mode is read-only, and `s.mutate` throws in it.

1. Run with `--dry-run`. Each payload is recorded in `report.mutations` and
   nothing is sent; `s.mutate` returns `null`, so do not let later logic depend
   on its return value.
2. Read `report.mutations`. Check the count, the ids, and a sample of the
   params against what you intended.
3. Re-run the same script with `--write`. It sends up to `--max-writes` frames
   (default 50; an array under an op-key counts one per element). Raise it
   deliberately, not by habit.

The script re-reads the store on the write run, so it acts on the current state
rather than on what the dry run saw.

Transactions are per call and per op-key. Within one `s.mutate` payload, each
array op-key is its own transaction, so one can be refused (for example
`policy_denied`) while the others land. The single-frame op-keys share one
transaction, and newer substrate runtimes roll all of them back when any one
is refused (`frame_rolled_back`), so never count on one single-frame op-key
landing while a sibling fails. Separate `s.mutate` calls are separate
transactions: use them for writes that must stay independent, and one array
under one op-key for writes that must land together.

## 5. Read the report

```json
{ "ok": true, "kid": "…", "mode": "write", "args": {}, "result": {}, "mutations": [{ "frame": {}, "applied": true }], "warnings": [], "stats": { "queries": 3, "writes": 1, "ms": 137 } }
```

- Check `ok` and the exit code (`0` ok, `1` the script failed, `2` usage or
  configuration) before `result`. On failure `error` carries the server's
  message.
- **`mutations` lists every payload with `applied`, including those sent before
  a failure.** A failed `--write` run may have written part of its batch. Read
  this list before retrying, and make a retry skip rows that already changed.
- `warnings` names truncated reads. A warning means the answer is incomplete;
  switch that read to `queryAll`.

Never pipe the run into `tail` or `jq` when its exit code matters. Use
`--out`, or redirect to a file.

## 6. Cut the approval prompts

Each run asks for approval. Suggest the user allow it with a prefix rule in
`~/.codex/rules/default.rules`, copying the command from step 0 up to `run`:

```
prefix_rule(pattern=["env", "SUBSTRATE_URL=https://substrate.example.com:3100", "SUBSTRATE_AGENT_KEY_ID=repo-codex@host", "SUBSTRATE_AGENT_KEY_PATH=/abs/path/to/repo-codex.key", "node", "/abs/path/to/substrate.js", "run"], decision="allow")
```

This covers `--write` too, just as the MCP tools write without prompting. The
dry run in step 4 is the guard on writes, not the approval prompt.
