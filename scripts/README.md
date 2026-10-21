# scripts/

One-off and gate scripts. Each file's header comment is the full usage doc;
this index only records which are CI-wired and which are manual.

| Script | Wired into | Run it |
|---|---|---|
| `stable-region-paths.mjs` | build plugin (`cortext-opencode` tsdown config) | never directly — runs inside `pnpm build` |
| `check-release-class.mjs` | nothing (manual release-sizing guard) | `node scripts/check-release-class.mjs [--from vX.Y.Z] [--to <v>] [--reason "..."]` before cutting a release |
| `eval-rule-salience.mjs` | nothing (dev-only, needs live `SUBSTRATE_URL` + signing key) | `node scripts/eval-rule-salience.mjs [project] [substrateUrl]` |
| `todo-resolution-values.mjs` | nothing (one-shot backfill helper; needs `pnpm build` first) | `node scripts/todo-resolution-values.mjs <out.json> [substrateUrl] [ns]`, then `substrate backfill-field` |

To wire a manual script into CI, add the step to `.github/workflows/ci.yml`
(and to `publish.yml` if a release must not ship without it).
