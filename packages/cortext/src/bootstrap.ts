/**
 * Structured-config bootstrap for `@mnmal-ai/cortext`.
 *
 * The canonical entry consumed by the binary's `SUBSTRATE_PLUGIN_DIR` loader.
 *
 * Operator JSON config supplies the env-shape knobs (namespace,
 * architectureNamespace, compactRetention, autoCompactIntervalMs); the
 * bootstrap parses + validates and hands off to `createCortextPlugin`.
 * Embeddable types (Memory, SessionLog, Decision, AnchorIntent, Concept)
 * declare `embed.source` metadata; substrate's recall plugin walks this at compose time
 * and chains an embedding postWrite per match via `contributePostWrites`.
 */

import { defineBootstrap } from '@mnmal-ai/substrate/sdk';
import { z } from 'zod';
import { DEFAULT_AUTH, isMonotonicAuth } from './auth-policy.js';
import { createCortextPlugin } from './index.js';
import { ARCHITECTURE_NAMESPACE, CORTEXT_NAMESPACE } from './kernel/index.js';

const NamespaceSchema = z
  .string()
  .min(1, 'must not be empty')
  .refine((s) => !s.includes('/'), { message: "must not contain '/'" });

/**
 * Namespace overrides stay SUPPORTED. The kernel cannot follow a renamed
 * namespace, so using one silently disables every kernel invariant — that
 * is reported at boot by `reportUncoveredNamespaces` (./kernel-invariants.ts),
 * wired into the plugin's `onStart`.
 *
 * They are not pinned to the kernel's literals: per-cohort context stores are a
 * designed capability with a test that names `codex` explicitly. The knob
 * stays; only the silence goes.
 */

const AuthModeSchema = z.enum(['open', 'identity']);

/**
 * Auth posture knob. Defaults: reads/writes open, hard-deletes
 * identity-gated. Operators
 * tighten (or fully open) per deployment — see ./auth-policy.ts for the
 * posture → policy mapping and the monotonicity invariant.
 */
const AuthPostureSchema = z
  .object({
    reads: AuthModeSchema.default(DEFAULT_AUTH.reads),
    writes: AuthModeSchema.default(DEFAULT_AUTH.writes),
    deletes: AuthModeSchema.default(DEFAULT_AUTH.deletes)
  })
  .strict();

export const CortextBootstrapConfigSchema = z
  .object({
    namespace: NamespaceSchema.default(CORTEXT_NAMESPACE),
    architectureNamespace: NamespaceSchema.default(ARCHITECTURE_NAMESPACE),
    compactRetention: z.number().int().positive().default(7),
    /** Auto-compact tick interval in milliseconds. Omitted = disabled. */
    autoCompactIntervalMs: z.number().positive().optional(),
    // zod v4 .default() short-circuits parsing, so the fallback must be the
    // fully-resolved posture object — not {} relying on inner defaults.
    auth: AuthPostureSchema.default({ ...DEFAULT_AUTH })
  })
  .strict()
  .refine((cfg) => cfg.namespace !== cfg.architectureNamespace, {
    message: 'architectureNamespace must differ from namespace',
    path: ['architectureNamespace']
  })
  .refine((cfg) => isMonotonicAuth(cfg.auth), {
    message:
      'auth posture must be monotonic — strictness non-decreasing along reads → writes → deletes ' +
      "(e.g. writes:'identity' requires deletes:'identity')",
    path: ['auth']
  });

export type CortextBootstrapConfig = z.infer<typeof CortextBootstrapConfigSchema>;

export const bootstrap = defineBootstrap.coordinator<CortextBootstrapConfig>({
  schema: CortextBootstrapConfigSchema,
  build: (config) =>
    createCortextPlugin({
      namespace: config.namespace,
      architectureNamespace: config.architectureNamespace,
      compactRetention: config.compactRetention,
      autoCompactIntervalMs: config.autoCompactIntervalMs,
      auth: config.auth
    })
});

export default bootstrap;
