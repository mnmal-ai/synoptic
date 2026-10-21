// cold-start projector — Synoptic host SOUTHBOUND-seam, the *context* half
// (sibling to wire-mcp.js, the *config* half). The host owns DELIVERY; a
// capability (northbound) owns CONTENT.
//
// Given a harness + a capability, project the capability's conventions +
// cold-start into that harness's own instruction file, resolving its cold-start
// tier (from the harness-capability-matrix):
//   - live-inject (Claude Code): the Synoptic SessionStart hook injects live
//     state — the file points at the hook; NO embedded self-query.
//   - auto-file (Gemini/Codex/Cursor): the file auto-loads but can't carry live
//     data, so it EMBEDS the capability's self-query. Cursor gets always-apply
//     rule frontmatter.
//   - manual-prime (Kimi): same embedded self-query PLUS a primeHint.
//
// The projector knows nothing about *which* capability it's delivering — swap
// Cortext for any other and the same machinery projects it. The doc is
// machine-agnostic (the per-agent kid lives in the MCP env, never here).

import { HARNESSES } from './wire-mcp.js';

/** Host framing for the embedded (tier B/C) self-query; `DO THIS FIRST` is the
 *  marker that distinguishes an embedded self-query from hook delivery. */
function selfQueryFraming(body) {
  return [
    '## Cold-start — DO THIS FIRST, EVERY SESSION',
    '',
    'Nothing is auto-injected, so load context yourself before other work:',
    '',
    body,
    '',
    'Re-run this cold-start after any context compaction.'
  ].join('\n');
}

/** Tier-A framing: cold-start is delivered live by the host's session hook. */
function hookBlock(capabilityName) {
  return [
    '## Cold-start',
    '',
    `The ${capabilityName} cold-start view (Concepts / Agent Memory / Open Work / Agent Rules)`,
    'is **injected automatically** at session start by the Synoptic hook — read it before',
    'acting. The hook re-runs after any compaction.'
  ].join('\n');
}

function header(project, capabilityName, namespace) {
  return [
    `# ${capabilityName} — shared agent context store`,
    '',
    `Project: \`${project}\`. You read + write the shared coordination store via the \`substrate\``,
    'MCP server (`schema`, `query`, `mutate`, `recall`, `ask`).',
    '',
    `> \`${namespace}/*\` is a neutral **codename** for the shared namespace, not Claude-only —`,
    '> every agent (you included) is a first-class reader/writer; rows attribute to whoever',
    '> wrote them via `_metadata.createdBy`. Write freely.'
  ].join('\n');
}

/** Always-apply rule frontmatter so Cursor auto-attaches the doc (.mdc). */
function cursorFrontmatter() {
  return [
    '---',
    'alwaysApply: true',
    'description: shared agent context store — conventions + cold-start',
    '---',
    ''
  ].join('\n');
}

/**
 * Project a capability's cold-start + conventions into `harness`'s instruction
 * file, resolving its tier.
 *
 * @param {'claude-code'|'kimi'|'cursor'|'gemini'|'codex'|'opencode'|'muse'} harness
 * @param {{ project: string, capability: { name: string, namespaces: string[], conventions: string, coldStart: (ctx: object) => string } }} ctx
 * @returns {{ harness: string, capability: string, tier: string, path: string, content: string, primeHint: string|null }}
 */
export function projectColdStart(harness, ctx) {
  const caps = HARNESSES[harness];
  if (caps === undefined) {
    throw new Error(
      `projectColdStart: unknown harness '${harness}' (known: ${Object.keys(HARNESSES).join(', ')})`
    );
  }
  const { project, capability } = ctx;
  if (capability === undefined) {
    throw new Error(
      'projectColdStart: ctx.capability is required (the northbound capability to deliver)'
    );
  }
  const namespace = capability.namespaces[0];

  const coldStart =
    caps.coldStartTier === 'live-inject'
      ? hookBlock(capability.name)
      : selfQueryFraming(capability.coldStart({ project }));

  const sections = [
    header(project, capability.name, namespace),
    coldStart,
    capability.conventions.trim()
  ];
  let content = `${sections.join('\n\n')}\n`;
  if (harness === 'cursor') content = `${cursorFrontmatter()}\n${content}`;

  const primeHint =
    caps.coldStartTier === 'manual-prime'
      ? `Start each session with \`@${caps.instructionFile}\` — ${harness} does not auto-load it.`
      : null;

  return {
    harness,
    capability: capability.name,
    tier: caps.coldStartTier,
    path: caps.instructionFile,
    content,
    primeHint
  };
}
