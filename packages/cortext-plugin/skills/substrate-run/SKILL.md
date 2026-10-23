---
name: substrate-run
description: "Run a short TypeScript script against Substrate with `substrate run`, so many reads and writes cost one tool call and return one small result. Use for multi-step store work: censuses and counts, joins across types, recall-then-hydrate, and batch writes driven by reads. Do NOT use for a single lookup or a single write; the substrate MCP tools are simpler there. Requires substrate >= 1.0.0-alpha.6."
---

`substrate run` imports one `.mts` script, calls its default export with a signed
`ScriptContext`, and prints one JSON report. Many queries and mutations run in a
single tool call, and only the result the script returns reaches your context.

## 0. Check the binary first

**Requires substrate >= 1.0.0-alpha.6.** Older binaries have no `run` subcommand.

The binary is the one the repo's `.mcp.json` names for the `substrate` server
(`args[0]`, a path ending `substrate.js`). It is often not on `PATH`, so call it
the same way:

```bash
node -e "console.log(require('./.mcp.json').mcpServers.substrate.args[0])"
node /abs/path/to/substrate.js --version
```

From then on write that absolute path literally in every command, not through
a shell variable. A permission rule (step 6) matches the command text, so
`node "$SUBSTRATE_JS" run …` never matches and prompts every time.

If the version is below `1.0.0-alpha.6`, stop and use the MCP tools instead.
Say that the local substrate install is behind and that updating it unlocks
this skill.

The run signs from `SUBSTRATE_URL`, `SUBSTRATE_AGENT_KEY_ID` and
`SUBSTRATE_AGENT_KEY_PATH`, which Claude Code passes from the repo's settings
`env` to the Bash tool. You need no setup. **It refuses to run unsigned**, so
a refusal names a missing identity rather than a broken script.

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
array op-key is its own transaction and the single-frame op-keys share one, so
one op-key can be refused (for example `policy_denied`) while its siblings
land. Separate `s.mutate` calls are separate transactions. For writes that must
land together, put them in one array under one op-key.

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

## 6. Cut the permission prompts

Each run asks for Bash permission. Suggest the user allow it in the repo's
`.claude/settings.local.json`, using the absolute path from step 0:

```json
{ "permissions": { "allow": ["Bash(node /abs/path/to/substrate.js run:*)"] } }
```

This covers `--write` too, just as the MCP tools write without prompting. The
dry run in step 4 is the guard on writes, not the permission prompt.
