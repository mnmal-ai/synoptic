# @mnmal-ai/cortext-omp

The OMP (oh-my-pi) skin for Cortext. An OMP extension that:

- appends the synoptic cold-start (the rule index, the pointers, the session line and the inbox) to the system prompt at `before_agent_start`, and on later prompts adds a one-line unread-mail summary
- continues a turn once at `session_stop` when unread agent mail is waiting
- compacts into Substrate: once the context passes a threshold it asks the model for a fenced `checkpoint` block, and at compaction it saves the newest block as a `cortext/ExecutionCheckpoint` under the session's `cortext/Task` and replaces the summary with a short pointer to it

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

| Env | Effect |
|---|---|
| `SUBSTRATE_NAMESPACE` | Namespace, default `cortext` |
| `SYNOPTIC_COLD_START_MAX_BYTES` | Byte cap on the injected cold-start |
| `SYNOPTIC_HOST_REPORT=off` | Skip the HostInstall write (harness `omp`) |
| `SYNOPTIC_OMP_COMPACT=off` | Leave compaction entirely to OMP |
| `SYNOPTIC_OMP_CHECKPOINT_PERCENT` | Context use, as a percent of the window, at which to start asking for a checkpoint (again every 10 points); default `50` |
| `SYNOPTIC_INBOX_PROMPT_CHECK=off` / `SYNOPTIC_INBOX_STOP_CHECK=off` | Disable the inbox seams |

A read-only identity works: the cold-start and the inbox are reads, the HostInstall write fails into a comment line, and a refused checkpoint write falls back to OMP's own compaction.

## Compaction

The pointer replaces only OMP's summary. The recent turns OMP keeps after the cut are its own, sized by the `compaction.keepRecentTokens` setting, and `compaction.thresholdTokens` sets when compaction runs. Lower both for a small model. Nothing after the block is dropped: when the block is older than OMP's cut, the kept history starts right after it instead. So the request repeats every 10 points of context use past the threshold, keeping the block close to the cut.

The pointer is used only when the write is acknowledged. No block, a malformed one, a refused write or a 20-second timeout each leave OMP's compaction to run as usual.

## Not yet

The push watcher (mid-turn mail), the substrate conventions text, and commands and tools.
