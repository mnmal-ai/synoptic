/**
 * cortext plugin config type.
 *
 * Pure type definition — config is supplied to `createCortextPlugin` either
 * by the structured-config bootstrap (operator JSON config + optional
 * code-shaped extras) or by direct programmatic callers (tests). Validation
 * and defaults live in the bootstrap layer (zod schema in `bootstrap.ts`).
 */

/** Per-surface auth posture: anonymous allowed, or authenticated identity required. */
export type CortextAuthMode = 'open' | 'identity';

/**
 * Auth posture knob ("open initially, retrofit-capable").
 * Maps onto plugin-level policy combinators at compose time; autoCRUD type
 * definitions are untouched, so any deployment can tighten posture later by
 * config alone. Strictness must be monotonic: reads ≤ writes ≤ deletes.
 */
export interface CortextAuthConfig {
  /** Type queries + get<T> (and subscribe/stream dispatch). */
  reads: CortextAuthMode;
  /** create<T> + update<T>. */
  writes: CortextAuthMode;
  /** delete<T>, incl. purge<T> via its verb:'delete' stamp. */
  deletes: CortextAuthMode;
}

export interface CortextPluginConfig {
  /** Namespace the context-store types register under. */
  namespace: string;
  /**
   * Namespace the architecture-findings type (`ArchitectureConcern`) registers
   * under. Kept separate from the context store so compaction / retention /
   * audit policies diverge.
   */
  architectureNamespace: string;
  /** Number of recent sessions to keep live during compaction. */
  compactRetention: number;
  /** Auto-compact interval in milliseconds. Undefined = disabled. */
  autoCompactIntervalMs: number | undefined;
  /** Auth posture. Undefined = DEFAULT_AUTH (reads/writes open, deletes identity). */
  auth: CortextAuthConfig | undefined;
}
