// apply-onboard — the EXECUTION layer over an onboard() plan. The plan is pure
// data; this turns it into disk writes + a runnable identity script.
//
// Two safety rules, deliberate:
//   1. NEVER clobber. An existing target file (MCP config OR instruction doc) is
//      routed to `skipped`, never overwritten — re-applying is idempotent and a
//      hand-edited AGENTS.md/CLAUDE.md survives. `merge:true` files (Gemini
//      settings.json, Codex config.toml) carry that flag so the operator knows
//      a structured merge is needed rather than a replace.
//   2. NEVER auto-run privileged steps. `applyOnboard` writes files (the
//      pure-emitter outputs, safe) but only SURFACES the identity script —
//      keygen is local, but register hits the prod DB and restart bounces the
//      service, so an operator runs those.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Resolve a plan file path: `~/…` → under home, anything else → under targetDir. */
function resolvePath(p, { targetDir, home }) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return join(targetDir, p);
}

function buildIdentityScript(identity) {
  const lines = [
    `# Agent identity: ${identity.kid}`,
    '# Run in order. SAFE steps are local; PRIVILEGED steps need an operator.'
  ];
  for (const step of identity.steps) {
    lines.push(
      '',
      `# [${step.privileged ? 'PRIVILEGED' : 'SAFE'}] ${step.label}`,
      ...step.commands
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Decide the apply actions for a plan. Pure — fs state is injected via
 * `existing` (absolute paths that already exist) so it's fully testable.
 *
 * @param {{ files: Array<{path:string,content:string,merge?:boolean}>, identity: object, primeHint: string|null }} plan
 * @param {{ targetDir: string, home: string, existing?: string[] }} ctx
 */
export function planActions(plan, ctx) {
  const existing = new Set(ctx.existing ?? []);
  const writes = [];
  const skipped = [];
  for (const f of plan.files) {
    const path = resolvePath(f.path, ctx);
    if (existing.has(path)) {
      skipped.push({ path, content: f.content, merge: f.merge === true });
    } else {
      writes.push({ path, content: f.content });
    }
  }
  return {
    writes,
    skipped,
    identityScript: buildIdentityScript(plan.identity),
    primeHint: plan.primeHint
  };
}

/**
 * Apply a plan to disk: write files that don't yet exist (creating dirs),
 * surface the rest. Returns a summary; the identity script + prime hint are for
 * the operator to act on.
 */
export function applyOnboard(plan, ctx) {
  const existing = plan.files.map((f) => resolvePath(f.path, ctx)).filter((p) => existsSync(p));
  const actions = planActions(plan, { ...ctx, existing });
  const written = [];
  for (const w of actions.writes) {
    mkdirSync(dirname(w.path), { recursive: true });
    writeFileSync(w.path, w.content);
    written.push(w.path);
  }
  return {
    written,
    skipped: actions.skipped,
    identityScript: actions.identityScript,
    primeHint: actions.primeHint
  };
}
