# @mnmal-ai/cortext-omp

The OMP (oh-my-pi) skin for Cortext. An OMP extension that:

- appends the synoptic cold-start (the rule index, the pointers, the session line and the inbox) to the system prompt at `before_agent_start`, and on later prompts adds a one-line unread-mail summary
- continues a turn once at `session_stop` when unread agent mail is waiting

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
| `SYNOPTIC_INBOX_PROMPT_CHECK=off` / `SYNOPTIC_INBOX_STOP_CHECK=off` | Disable the inbox seams |

A read-only identity works: the cold-start and the inbox are reads, and the HostInstall write fails into a comment line.

## Not yet

The push watcher (mid-turn mail), the substrate conventions text, commands and tools, and a compaction pointer.
