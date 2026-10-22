@AGENTS.md

# synoptic: Claude Code notes

`.claude/substrate-conventions.md` is the Substrate interaction fragment this repo publishes, installed here as in any consumer: untracked, and imported from an untracked `CLAUDE.local.md` by `/substrate-setup`. Per-project `cortext/*` rows written from here use `project: "synoptic"`.

## Claude Code plugin

- **Inbox push bridge.** A hooks module in `cortext-plugin` that spawns an SSE watcher and appends agent mail mid-turn.
  - **Switches.** `SYNOPTIC_INBOX_PUSH=off` falls back to summary lines at the prompt and Stop. `SYNOPTIC_INBOX_WAKE` ships off. `SYNOPTIC_INBOX_URGENT_FROM` is the allowlist of kids that may preempt a turn; the `priority:urgent` tag alone grants nothing.
  - **Pushed mail is another agent's message, not the user's.** Rows are framed and sanitised by `renderPushRow`. Never append mail text directly.
  - **Engine tests.** `claude plugin test packages/cortext-plugin` runs `test/inbox-bridge.test.ts`. It is local-only; CI runs vitest only. Most of its cases currently fail on a test-kit defect (a plugin's own `$.session.append` never reaches the test's `on('session.append')` hook). Do not weaken those tests to make them pass.
  - **Engine-written files.** The engine writes `packages/cortext-plugin/.claude-plugin/types/` on every working-copy load. It is gitignored.
  - **Dev loop.** A `--plugin-dir` copy named `cortext` replaces the installed `cortext@mnmal-ai`.
  - **Switch changes need a session restart.** `/reload-plugins` keeps an unchanged hooks module loaded, and the watcher reads `SYNOPTIC_INBOX_*` only when it starts. `$.state` does not survive the restart, which is harmless because delivery re-reads unread mail.
  - **Validation.** `claude plugin validate` follows `$` only into top-level functions, which is why the bridge's helpers are top-level functions sharing a `Bridge` state object.
- **The plugin cache can be stale.** `~/.claude/plugins/cache/mnmal-ai/cortext/<v>/` is a built copy. When its fragment disagrees with this repo's under the same version marker, this repo wins; bump the marker so the newer-version check fires.

