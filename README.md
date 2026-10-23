# Synoptic

The agent-coordination **host**. Synoptic ships **Cortext** — an agent-neutral
workflow/coordination capability delivered as a [Substrate](https://github.com/mnmal-ai/substrate) plugin — plus the harness
that onboards agents (Claude, Kimi, Codex, Gemini, …) to it.

> Cortext is the neutral ground that normalises the namespaces + the domain
> types, and it **uses Substrate** (a single substrate binding, by design — the
> power is Substrate's principled stance on how things behave).

## Packages

| Package | What it is |
|---|---|
| [`@mnmal-ai/cortext`](packages/cortext/README.md) | One package, two Substrate plugins: the coordinator (coordination types, policy, mailbox, onboard) and the kernel plugin at the `@mnmal-ai/cortext/kernel` subpath (schema constraints + body invariants, migrations). |
| [`@mnmal-ai/synoptic`](packages/synoptic/README.md) | The host library — onboarding pipeline, cold-start projector, capability contract, handoff. |
| `@mnmal-ai/context-render` | Type-generic index-and-pull rendering, body folding, budget trim, RRF ranking and rule tiering. |
| `cortext` (CC plugin) | The Claude Code delivery — cold-start hooks + skills (the "skin"). |
| [`@mnmal-ai/cortext-opencode`](packages/cortext-opencode/README.md) | The OpenCode skin — cold-start injection via `experimental.chat.system.transform`, zero-dep committed `dist/plugin.js`. |
| [`cortext-codex`](packages/cortext-codex/README.md) | Local Codex delivery — cold-start and compaction refresh, prompt/stop inbox checks, shared council/todo skills and architecture review. |

## Install

Every skin needs a Substrate server you run: set `SUBSTRATE_URL` to it. There is
no default URL and no discovery.

- **Claude Code.** This repo is the plugin marketplace. In any session:

  ```
  /plugin marketplace add mnmal-ai/synoptic
  /plugin install cortext@mnmal-ai
  ```

  Then run `/substrate-setup` in each repo you want onboarded. The marketplace
  pins the plugin to a release tag, so an install never serves unreleased code.
- **OpenCode.** OpenCode installs plugins from npm, not from a marketplace. See
  [`packages/cortext-opencode`](packages/cortext-opencode/README.md#install), and
  use the same version as the Claude plugin's release.
- **Muse Spark.** Muse has no plugin system; its hooks run the cold-start from an
  installed `@mnmal-ai/synoptic` by absolute path. See
  [`muse-substrate-setup.md`](packages/synoptic/docs/muse-substrate-setup.md).
- **Codex.** Local only, from a checkout. See
  [`packages/cortext-codex`](packages/cortext-codex/README.md).

`@mnmal-ai/substrate` and these packages are public on npmjs.com; installing them needs no token.

Status: **active** — Cortext and its skins ride one tag (see `AGENTS.md`). Versioning is decoupled from Substrate.

## Development

    pnpm install
    pnpm build && pnpm check-types && pnpm lint && pnpm test

See [CONTRIBUTING.md](CONTRIBUTING.md) for pull requests and labels, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[Apache-2.0](LICENSE)
