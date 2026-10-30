---
name: substrate-run
description: "Run a short TypeScript script against Substrate with `substrate run`, so many reads and writes cost one tool call and return one small result. Use it when the work takes three or more dependent MCP calls (ids passed from one call to the next): a census or count that must page, a join across types, recall-then-hydrate, or a batch of writes driven by a read. Do NOT use for a single lookup or a single write; the substrate MCP tools are simpler there. Requires substrate >= 1.0.0-alpha.6."
---

`substrate run` imports one `.mts` script, calls its default export with a signed
`ScriptContext`, and prints one JSON report. Many queries and mutations run in a
single tool call, and only the result the script returns reaches your context.

## 0. Find the binary and the identity

**Requires substrate >= 1.0.0-alpha.6.** Older binaries have no `run` subcommand.

Both come from the `substrate` server in `opencode.json` (`mcp.servers.substrate`,
project or user level):

- **The binary** is its `command` array minus the trailing `mcp`: either
  `node /abs/path/to/substrate.js`, or `npx -y @mnmal-ai/substrate@next`.
- **The identity** is its `environment`: `SUBSTRATE_URL`,
  `SUBSTRATE_AGENT_KEY_ID` and `SUBSTRATE_AGENT_KEY_PATH`. A `{env:VAR}` value
  is already in your shell. A literal one is not, so set it on the command.
  Use only the key's path; never read or print the key file.

```bash
node /abs/path/to/substrate.js --version
```

Write every run as one literal command, values filled in, leaving out any
variable your shell already has:

```bash
env SUBSTRATE_URL=https://substrate.example.com:3100 SUBSTRATE_AGENT_KEY_ID=repo-opencode@host SUBSTRATE_AGENT_KEY_PATH=/abs/path/to/repo-opencode.key node /abs/path/to/substrate.js run script.mts
```

If the version is below `1.0.0-alpha.6`, stop and use the MCP tools instead.
Say that the local substrate install is behind and that updating it unlocks
this skill.

**It refuses to run unsigned**, so a refusal names a missing identity rather
than a broken script.

## 1. When to use it, and when not to

| Use `substrate run` | Use the MCP tools |
|---|---|
| A count or census over many rows (`queryAll` pages to the end) | One lookup by id, shortId or name |
| A join: rows of one type, then the rows they reference | One write |
| Recall, then fetch the bodies of the few hits worth reading | Exploring the schema |
| A batch of writes chosen by what a read found | Anything you will read only once, row by row |

The switch point: three or more dependent MCP calls (ids passed from one call to
the next), a census or count that must page, a join, recall-then-hydrate, or a
batch of writes chosen by a read. Any of those, write a script.

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
| `s.recall({ query, namespace, type, k?, threshold?, where?, row? })` | Hits, best first. `type` is required (e.g. `"Memory"`, `"Decision"`); the server refuses recall without it. `row` holds `id` plus the handle fields; pass `row: { body: true }` (or `true`) only on the call whose hits you will read |
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

**Small batch (five frames or fewer): write directly.** Run once with
`--write --max-writes N`, where N is the number of frames you expect, and put
every write in ONE `s.mutate` call. The cap is checked per call, so with a
single call an unexpected sixth frame is refused before anything is sent. With
several calls, the earlier ones would already have landed. Then read
`report.mutations` as in step 5.

**Anything larger, or any batch whose size you cannot predict: dry run first.**

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

## 6. Cut the permission prompts

If OpenCode asks before each run, suggest the user allow the command in
`opencode.json`, using the prefix from step 0:

```json
{ "permission": { "bash": { "env SUBSTRATE_URL=* node /abs/path/to/substrate.js run *": "allow" } } }
```

This covers `--write` too, just as the MCP tools write without prompting. The
dry run in step 4, or the single-call cap on a small batch, is the guard on
writes, not the permission prompt.
