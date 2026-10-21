// cortext — the first Synoptic capability: cross-agent COORDINATION + shared
// MEMORY over the Substrate context store (Todo/Decision/SessionLog/AgentRule/
// Memory/…). The reference implementation of the northbound capability contract.
//
// It owns the CONTENT — its namespace, its interaction conventions, and what an
// agent must load at cold-start — but knows nothing about harnesses. The host's
// projector turns this into a per-harness instruction file.
//
// `createCortext(namespace)` is the born-neutral factory: it templates the
// conventions + cold-start onto whatever coordination namespace the instance
// uses, so ONE codebase serves a `claude` instance today and a `cortext`
// instance at greenfield birth. The default `cortext` export stays on
// `claude` (the live codename) for back-compat.

import { defineCapability } from '../capability.js';

/**
 * Build the cortext capability bound to a coordination `namespace`.
 * @param {string} [namespace='cortext'] the qualified-key namespace stem.
 */
export function createCortext(namespace = 'cortext') {
  const ns = namespace;
  const CONVENTIONS = [
    '## Conventions',
    '',
    `- **Qualified frame keys**: every key is \`<namespace>/<Type>\` — e.g. \`${ns}/Todo\`, \`${ns}/createTodo\`.`,
    '- **Filters live in `where`**: `eq`, `neq`, `gt|gte|lt|lte`, `between`, `in|nin`, `contains`, `startsWith|endsWith`.',
    '  Indexed handle fields (name/title/topic/synopsis/description) filter freely; long-form fields',
    '  (body/summary/notes/rationale) are unindexed — prefer `recall` for prose. `eq: null` never matches.',
    '- **Server-managed metadata**: `createdAt`/`updatedAt`/`createdBy`/`updatedBy` are server-filled —',
    '  never send them on write (rejected); read via the `_metadata` projection.',
    '- **Batched mutations**: an array under one op-key is one atomic transaction; never put the array inside `params`.',
    '- **Write context as it happens**: Decision when one is made; Todo when a gap surfaces (close with',
    '  `archived: true`); SessionLog at every stable milestone (with a retrieval-tuned `synopsis`).',
    '  Per-project rows carry `project` = repo basename; cross-cutting rows use `project: null`.'
  ].join('\n');

  return defineCapability({
    name: 'cortext',
    // `recall` is NOT optional decoration. The cold-start projector issues
    // `recall/Hit`, `recall/boost` and `recall/fetchEmbeddings`, and a kid
    // granted only the coordination namespace does not fail loudly — it renders
    // Agent Memory through the importance x recency fallback with a
    // rejected-frames banner, while every other section looks normal: the
    // largest context block selected by the weaker ranker in every session
    // because the grant was one namespace short.
    //
    // These names are what `onboard` hands `provisionIdentity` for `--ns`, so a
    // namespace missing here becomes a namespace missing on the registered key.
    //
    // Both need `mutate`: the cold-start writes SessionLogs,
    // AnchorIntents and Memory to `${ns}`, and `recall/boost` is a mutation, so
    // a key narrowed to read on either reads cleanly and fails at its first
    // write. The authority audit checks these.
    namespaces: { [ns]: ['read', 'mutate'], recall: ['read', 'mutate'] },
    requiresIdentity: true,
    conventions: CONVENTIONS,
    coldStart: ({ project }) =>
      [
        `1. \`schema\` — discover types + mutations (the \`${ns}\` namespace).`,
        '2. Query active operational rules and APPLY them silently:',
        '   ```json',
        `   { "${ns}/AgentRule": { "params": { "where": { "active": { "eq": true } } },`,
        '     "fields": { "id": true, "rule": true, "category": true, "rationale": true } } }',
        '   ```',
        `3. Orient (≤5 lines): open Todos for \`${project}\`, recent \`${ns}/Memory\`, and`,
        '   `recall` for the task at hand.',
        `4. RESUME (cross-agent handoff) — the latest breadcrumb for \`${project}\`:`,
        '   ```json',
        `   { "${ns}/AnchorIntent": { "params": { "where": { "project": { "eq": "${project}" }, "archived": { "eq": false } }, "orderBy": [{ "createdAt": "desc" }], "limit": 1 }, "fields": { "synopsis": true, "body": true, "_metadata": true } } }`,
        '   ```',
        '   If one exists, continue from its `synopsis`/`body` — another agent may have left it.',
        `   When you pause mid-task, leave your own via \`${ns}/createAnchorIntent\` so the next agent resumes.`
      ].join('\n')
  });
}

export const cortext = createCortext('cortext');
