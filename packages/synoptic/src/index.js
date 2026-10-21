// Public library surface of the Synoptic host: the agent-onboarding pipeline
// (identity + MCP config + cold-start + orchestrator + executor) plus the
// northbound capability contract. The cold-start HOOKS (entry.js et al.) are a
// separate concern, bundled to committed .mjs via tsdown — this barrel is the
// importable host API and the backing for the `synoptic-onboard` CLI.

export { applyOnboard, planActions } from './apply-onboard.js';
export { cortext, createCortext } from './capabilities/cortext.js';
export { defineCapability } from './capability.js';
export { projectColdStart } from './cold-start-projector.js';
export { handoffFrames, resumeQuery, watchFrame } from './handoff.js';
export { onboard } from './onboard.js';
export { provisionIdentity } from './provision-identity.js';
export { HARNESSES, wireMCP } from './wire-mcp.js';
