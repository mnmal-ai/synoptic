// `/substrate-setup --audit` — the read-only three-way reconciliation.
//
// Three stores are supposed to agree and nothing has ever checked that they do:
// the plugin cache, the key files on disk, and the `AgentIdentity` directory.
// Step 7.5 of the skill already tells an operator to cross-check two of them by
// hand — and it only runs at all if someone opts into the identity step, which
// on an already-provisioned repo is exactly when they skip it. So the drift
// accumulates precisely where the check would have caught it.
//
// ## Why read-only matters more than it sounds
//
// Every failure in this cluster is one nobody went looking for. A mode that
// writes nothing needs no consent gate, so it can run unprompted on any
// invocation — which is the only way a check reaches the people who were never
// going to run it deliberately.
//
// ## The one rule this module exists to enforce
//
// **"Checked and fine" must never render the same as "could not check."**
//
// An empty `data` read as a true negative, an audit that emits only failure
// metrics so a clean run and a run that never executed look the same, a stale
// install reporting success: all one defect. An audit that silently degrades a
// check it could not perform into a clean line is not a diagnostic, it is a
// generator of false confidence.
//
// So every check carries one of THREE states, never two:
//
//   ok       verified, and the answer is good
//   warn     verified, and the answer is bad
//   unknown  NOT VERIFIED — and this renders as loudly as `warn`, because an
//            unverified check is a hole in the audit, not a passing line
//
// A summary that counts only ok/warn would hide the third, so it counts all
// three and says so.

export * from './audit/check.js';
export * from './audit/identity.js';
export * from './audit/inbox.js';
export * from './audit/install.js';
export * from './audit/mcp-json.js';
export * from './audit/orphans.js';
export * from './audit/recall.js';
export * from './audit/render.js';
