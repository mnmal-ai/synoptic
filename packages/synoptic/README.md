# @mnmal-ai/synoptic

Harness-neutral host library — the agent-onboarding pipeline (identity + MCP
config + cold-start + orchestrator + executor), the cold-start projector, the
Cortext capability contract, and cross-agent handoff. The Claude Code,
OpenCode, and Codex skins consume it; it ships no skin itself.

## Surface

- `.` — importable host API (`src/index.js`): `applyOnboard`, `planActions`,
  `cortext` / `createCortext`, `defineCapability`, `projectColdStart`,
  `handoffFrames` / `resumeQuery` / `watchFrame`, `onboard`,
  `provisionIdentity`, `HARNESSES` / `wireMCP`.
- `./handoff` — `src/handoff.js` standalone.

The cold-start and inbox hook entrypoints (`*-entry.js`) live here as reusable
glue and are bundled to committed artifacts by the skins (`cortext-plugin`
`hooks/*.mjs` + `bin/*.mjs` via tsdown). No production code here composes
Substrate — `compose()` appears in tests only; the substrate binary does the
composing, so Substrate breaking changes land as test failures, not runtime risk.

Versioning is decoupled from Substrate (see the root `AGENTS.md`). `HARNESSES` in
`src/wire-mcp.js` declares every harness; release rails derive from it.

## Verify

```sh
pnpm --filter @mnmal-ai/synoptic test
pnpm --filter @mnmal-ai/synoptic check-types
pnpm --filter @mnmal-ai/synoptic lint
```
