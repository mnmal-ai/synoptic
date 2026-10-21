/**
 * cortext's kernel plugin public surface.
 *
 * Exported for direct embedding (the perf harness, test harnesses).
 * Production deployments go through the manifest loader →
 * `./bootstrap` entry.
 */

export {
  ARCHITECTURE_NAMESPACE,
  CORTEXT_COORDINATOR_NAME,
  CORTEXT_NAMESPACE
} from './cortext-namespace.js';
export {
  auditNamespaceCoverage,
  auditObjects,
  type Finding,
  findingMessage,
  INVARIANT_OBJECTS,
  type InvariantObject,
  type PluginNamespace,
  reportInvariantAudit,
  resolveCortextNamespaces,
  scopedNamespace,
  type UntargetableReason
} from './invariant-audit.js';
export { cortextBaselineMigration } from './migrations/0001_baseline.js';
export { createCortextKernelPlugin } from './plugin.js';
export {
  REPAIR_ENV_VAR,
  type RepairOutcome,
  repairIfRequested,
  repairInvariants,
  repairOutcomeMessage,
  repairRequested
} from './repair.js';
export {
  countDuplicateHostInstallKeys,
  countDuplicateKids,
  rescopeHostInstallKeyIndex,
  rescopeKidUniqueIndex,
  rescopeRecipientIndex,
  rescopeVocabConstraint,
  VOCAB_CONSTRAINTS,
  type VocabConstraint
} from './rescope.js';
export { SUBSTRATE_CONTRACT_RANGE } from './substrate-contract.js';
export {
  AGENT_MESSAGE_STATUS_VOCAB,
  TODO_LIFECYCLE_VOCAB,
  TODO_PRIORITY_VOCAB,
  TODO_RESOLUTION_VOCAB
} from './todo-vocab.js';
