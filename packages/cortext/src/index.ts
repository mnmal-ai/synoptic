/**
 * @mnmal-ai/cortext — coordinator plugin that persists Claude Code
 * context (sessions, decisions, todos, rules, reviews, councils, skills) plus
 * Claude-lineage architecture findings.
 *
 * Binds the context store onto the coordinator plugin seam (§5.11):
 *   - `namespaces[0]` — the 13-type context-store surface (see `./namespace.ts`).
 *   - `namespaces[1]` — the `architecture` surface (`ArchitectureConcern`),
 *     kept in a distinct namespace so lifecycle policies (compaction,
 *     retention, audit) diverge from session-scoped rationale.
 *   - `routes` — `/onboard` (static agent self-description) and `/compact`
 *     (session archiver — operates on the claude namespace only).
 *   - `schedule` — an auto-compact task when `autoCompactIntervalMs` is set
 *     in the operator's `cortext.config.json`; otherwise the plugin
 *     ships with no scheduled tasks and relies on explicit
 *     `POST /substrate/v1/plugins/cortext/compact` calls.
 *
 * `createCortextPlugin` is a pure factory taking a fully-resolved
 * `CortextPluginConfig`. Recall/embedding wiring is entirely declarative:
 * embeddable types declare `embed.source` slots on their namespace definitions,
 * and kernel plugins (e.g. substrate's recall plugin) walk that metadata at compose
 * time to contribute postWrite hooks via the engine's kernel-walk.
 */

import type { CoordinatorPlugin } from '@mnmal-ai/substrate/sdk';
import { buildAuthPolicies, DEFAULT_AUTH } from './auth-policy.js';
import { registerCompactRoute, runCompact } from './compact.js';
import type { CortextPluginConfig } from './config.js';
import { CORTEXT_COORDINATOR_NAME, SUBSTRATE_CONTRACT_RANGE } from './kernel/index.js';
import { reportUncoveredNamespaces } from './kernel-invariants.js';
import { buildArchitectureNamespace, buildClaudeNamespace } from './namespace.js';
import { registerOnboardRoute } from './onboard.js';

export { buildAuthPolicies, DEFAULT_AUTH, isMonotonicAuth } from './auth-policy.js';
export { type CompactResult, registerCompactRoute, runCompact } from './compact.js';
export type { CortextAuthConfig, CortextAuthMode, CortextPluginConfig } from './config.js';
export {
  AGENT_MESSAGE_STATUS_VOCAB,
  AGENT_RULE_CATEGORY_VOCAB,
  AGENT_RULE_SEVERITY_ALIASES,
  AGENT_RULE_SEVERITY_VOCAB,
  ARCHITECTURE_TYPE_NAMES,
  buildArchitectureNamespace,
  buildClaudeNamespace,
  CLAUDE_TYPE_NAMES,
  DECISION_STATUS_ALIASES,
  DECISION_STATUS_VOCAB,
  HOST_INSTALL_CHECK_STATES,
  HOST_INSTALL_FRAGMENT_STATES,
  TASK_STATUS_VOCAB,
  TODO_RESOLUTION_ALIASES,
  TODO_STATUS_ALIASES,
  TODO_STATUS_IMPLIES
} from './namespace.js';
export { registerOnboardRoute } from './onboard.js';
// Release tooling. Exported so scripts/check-release-class.mjs can reuse
// the classifier from the built package rather than restating its rules — two
// copies of "what counts as breaking" is a defect generator, and the rules are
// tested beside the builder.
export {
  buildReleaseSurface,
  bumpClass,
  classifySurfaceChange,
  classSatisfies,
  type ReleaseClass,
  type ReleaseSurface,
  type SurfaceChange,
  type SurfaceField
} from './release-surface.js';
export {
  type ClosedTodoText,
  inferTodoResolution,
  type TodoResolution
} from './todo-resolution.js';

export function createCortextPlugin(cfg: CortextPluginConfig): CoordinatorPlugin {
  return {
    // From the shared constant, not a literal. The KERNEL
    // resolves which namespace to target by filtering
    // `coordinatorNamespacesByPlugin` on this exact name — so a rename here
    // that the kernel does not follow makes its filter match nothing, and it
    // would report "the cortext coordinator is not loaded" about a healthy
    // deployment.
    name: CORTEXT_COORDINATOR_NAME,
    contractVersion: SUBSTRATE_CONTRACT_RANGE,
    // Report any configured namespace the kernel's baked-in literals do not
    // cover. Deliberately a warning, not a refusal — namespace
    // overrides are a supported capability; what was missing was any signal
    // that using one silently disables every kernel invariant. See
    // ./kernel-invariants.ts.
    onStart: (ctx) => {
      reportUncoveredNamespaces(cfg, ctx.metric);
    },
    namespaces: [
      buildClaudeNamespace(cfg.namespace),
      buildArchitectureNamespace(cfg.architectureNamespace)
    ],
    // Auth posture. The context store is the agent's memory
    // estate — anonymous writes are a prompt-injection vector with
    // persistence (cold-start + recall inject Memory/AgentRule/Concept rows
    // into every future session's context), and anonymous deletes can erase
    // it. The posture knob maps to plugin-level policies at compose time
    // (see ./auth-policy.ts) covering BOTH namespaces (claude +
    // architecture). Default: reads/writes open, deletes identity-gated —
    // tire-kicker friendly, matches the v3.2.3 shipped behaviour. Operators
    // with a stricter security posture tighten via cortext.config.json;
    // internal maintenance writers (compact) pass the resolve-identity
    // system envelope so they keep working under gated writes.
    policies: buildAuthPolicies(cfg.auth ?? DEFAULT_AUTH),
    schedule:
      cfg.autoCompactIntervalMs !== undefined
        ? [
            {
              name: `${cfg.namespace}-auto-compact`,
              intervalMs: cfg.autoCompactIntervalMs,
              runOnStart: false,
              handler: async (taskCtx): Promise<void> => {
                await runCompact(taskCtx.engine, cfg.namespace, cfg.compactRetention, false);
                taskCtx.metric('compact_applied', { namespace: cfg.namespace });
              }
            }
          ]
        : [],
    routes: (router, routeCtx): void => {
      registerOnboardRoute(router, routeCtx, cfg.compactRetention, cfg.namespace);
      registerCompactRoute(
        router,
        routeCtx,
        cfg.compactRetention,
        cfg.namespace,
        cfg.auth ?? DEFAULT_AUTH
      );
      // recall + embed-stats routes are kernel-mounted at /substrate/v1/recall and
      // /substrate/v1/embed-stats by createRecallPlugin (`@mnmal-ai/substrate/recall`).
    }
  };
}
