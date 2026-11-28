# @mnmal-ai/cortext-omp

The OMP (oh-my-pi) skin for Cortext. An OMP extension that:

- appends the synoptic cold-start (a line keeping Substrate access to the MCP tools, the rule index, the pointers, the session line and the inbox) to the system prompt at `before_agent_start`, and on later prompts adds a one-line unread-mail summary
- continues a turn once at `session_stop` when unread agent mail is waiting
- pushes agent mail as it arrives: steered into a turn in progress, or, with `SYNOPTIC_INBOX_WAKE=on`, a turn is started in an idle session (at most 6 an hour and 2 per thread); without wake, an idle session reads it on its next turn
- compacts into Substrate: at every compaction, mid-turn included, it saves the steps being compacted away (each tool call with a one-line result, and the model's last note) as a `cortext/ExecutionCheckpoint` under the session's `cortext/Task`, and replaces OMP's summary with a pointer carrying the request and those steps

`dist/extension.js` is a committed, byte-deterministic bundle with the synoptic host inlined and no runtime dependencies.

## Use

```bash
omp plugin install @mnmal-ai/cortext-omp@next
```

Identity and endpoint come from the env OMP is launched with. From a checkout, load the package directory instead:

```bash
SUBSTRATE_URL=https://substrate.example:3100 \
SUBSTRATE_AGENT_KEY_ID=<kid> \
SUBSTRATE_AGENT_KEY_PATH=<path to its key> \
omp -e /path/to/synoptic/packages/cortext-omp
```

Run it from inside the repo whose rows you want; the project scope is the repo root's basename.

To give the model substrate's `act` tool (short sketches such as `close Todo #12` in place of hand-built frames), set `SUBSTRATE_MCP_TOOLS=core,act` in the env of the substrate MCP server in your OMP MCP config. It needs substrate 1.0.0-beta.10 or later. The cold-start names `act` only in a session that has the tool.

| Env | Effect |
|---|---|
| `SUBSTRATE_NAMESPACE` | Namespace, default `cortext` |
| `SYNOPTIC_COLD_START_MAX_BYTES` | Byte cap on the injected cold-start |
| `SYNOPTIC_HOST_REPORT=off` | Skip the HostInstall write (harness `omp`) |
| `SYNOPTIC_OMP_COMPACT=off` | Leave compaction entirely to OMP |
| `SYNOPTIC_INBOX_PROMPT_CHECK=off` / `SYNOPTIC_INBOX_STOP_CHECK=off` | Disable the inbox seams |
| `SYNOPTIC_INBOX_PUSH=off` | Do not watch the inbox (no pushed mail) |
| `SYNOPTIC_INBOX_EXTERNAL_PUSH_FROM` | Comma-separated allowlist for mail from another server: a peer domain (`peer.example.net`) lifts everything that peer relays; `<domain>/<kid>` lifts that sender only when relayed by that domain; a bare kid matches nothing. Other relayed mail is held for the prompt and stop checks |
| `SYNOPTIC_INBOX_WAKE=on` | Let pushed mail start a turn in an idle session |

A read-only identity works: the cold-start and the inbox are reads, the HostInstall write fails into a comment line, and a refused checkpoint write falls back to OMP's own compaction.

## Compaction

The checkpoint is built from the messages, not written by a model, so a small model's summarising cannot invent a goal or leave a stray tool call where the summary should be. The pointer replaces only OMP's summary. The recent turns OMP keeps after the cut are its own, sized by the `compaction.keepRecentTokens` setting, and `compaction.thresholdTokens` sets when compaction runs.

The pointer is used only when the write is acknowledged. A refused write (a read-only identity), an unreachable Substrate or a 20-second timeout each leave OMP's compaction to run as usual.

## Not yet

The substrate conventions text, urgent preemption of a running turn (`SYNOPTIC_INBOX_URGENT_FROM`), and commands and tools.
