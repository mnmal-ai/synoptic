# @mnmal-ai/context-render

Index-and-pull rendering for agent context documents: the top entries are
**pulled** (heading, quote, folded body) and the rest are **indexed** one line
each, so a reader knows they exist and can fetch them. Also included are the
pieces that decide which entries go where, and keep the result inside a budget.

Shared by synoptic's cold-start and other context renderers, so they cannot
drift. No runtime dependencies and no Node built-ins: it runs on
Node 20+ and Bun, or anywhere else `TextEncoder` does. ESM only.

## Entries

```js
{ id, label, synopsis, tokens, score, quote?, body?, pullHint? }
```

| field | rendered as |
|---|---|
| `label` | the pulled heading, after `#### ` |
| `synopsis` | the index line, after `- ` |
| `quote` | `> quote` under the heading |
| `body` | folded under the heading. **Absent** means no body; `''` means an empty one |
| `pullHint` | where the full body lives, named in the truncation note |
| `id`, `tokens`, `score` | not rendered; carried for the caller |

Nothing here knows a schema type. Mapping your rows to entries is the caller's
job; synoptic's adapters are in `packages/synoptic/src/render.js`.

## API

| export | does |
|---|---|
| `renderIndexAndPull({ top, index, topHeading, indexHeading, foldLimit?, foldReason? })` | lines for both blocks; an empty block is omitted, heading included |
| `renderPulled(entry, opts?)` / `renderIndexLine(entry)` | one entry |
| `foldBody(text, { limit?, pullHint?, reason? })` | flatten headings, cap at a line boundary, close a cut fence, and SAY it was truncated |
| `truncateToBudget(text, { maxBytes?, maxTokens?, countTokens?, pointer? })` | hard cap at a newline, never over an active ceiling. Token counts come from your `countTokens`, since they depend on the model |
| `fuseRRF(lists, { k?, pinned? })` | **plain RRF over any number of ranked `{ id, score }` lists.** Each list is ranked by its own score. `pinned` ids come first, in the order given, whether ranked or not. Exact ties break by id |
| `splitByTokens(entries, { maxTokens, reserve? })` | what to PULL within a token budget, from each entry's own `tokens`. Stops at the first entry that does not fit (never inverts rank order). `pinned: true` entries are always pulled and reported as `over` if they alone bust the budget |
| `rankWithRRF(groups, { k, totalK, minFloors?, groupOrder?, tieBreak?, onWarn? })` | Reciprocal Rank Fusion over structural + semantic ranks, with per-group minimum floors |
| `makeTieBreak({ groupOrder?, timeOf? })` | group order, then most recent first |
| `combineRRF`, `assignRanks`, `selectWithMinFloors`, `byteLength` | the parts |

## Versioning

Published from `mnmal-ai/synoptic` on synoptic's release line, so a synoptic
release moves its version whether or not this package changed. Diff
`packages/context-render/` between tags to see whether it actually did.

**A breaking change to this package's API bumps synoptic's major**, even when
nothing else in synoptic broke. Consumers that pin through a lockfile pay
nothing for a re-release with no changes.

Types ship as generated `dist/*.d.ts` (built from the JSDoc by `pnpm build`),
and `Entry`, `Fused`, `RankRow` and `TieBreak` are exported as types.
