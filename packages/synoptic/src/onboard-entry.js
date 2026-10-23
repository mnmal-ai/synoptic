#!/usr/bin/env node
// Thin CLI over the agent-onboarding pipeline:
//   node bin/onboard.mjs <harness> [--project X] [--host X] [--substrate-url URL]
//                        [--mcp-bin PATH] [--target-dir DIR] [--scope project|user] [--apply]
//
// Dry-run by default (prints what it WOULD write + the identity script). With
// --apply it writes the safe pure-emitter files (never clobbering) and surfaces
// the privileged identity steps (register/restart) for an operator — it never
// runs them. Arg-wiring only; the logic lives in the tested onboard() +
// applyOnboard().

// Bundled, like the hooks and the other three bins, so it has no
// import-resolution surface to get wrong. The guard is
// `test/bin-entries-load.test.js`, which loads every declared entry: a bin
// that nothing imports can fail on its first import unnoticed.
import { hostname } from 'node:os';
import { applyOnboard, existingTargets, planActions } from './apply-onboard.js';
import { onboard } from './onboard.js';
import { HARNESSES as DESCRIPTORS } from './wire-mcp.js';

// The canonical list is the HARNESSES descriptor, not a local copy that could
// drift from what onboard() accepts.
const HARNESSES = Object.keys(DESCRIPTORS);

function parseArgs(argv) {
  const [harness, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const name = rest[i].slice(2);
    flags[name] = name === 'apply' ? true : rest[++i];
  }
  return { harness, flags };
}

const { harness, flags } = parseArgs(process.argv.slice(2));
const substrateUrl = flags['substrate-url'] ?? process.env.SUBSTRATE_URL;
if (!harness || !HARNESSES.includes(harness) || !substrateUrl) {
  process.stderr.write(
    `usage: onboard <${HARNESSES.join('|')}> --substrate-url URL (or SUBSTRATE_URL) [--project X] [--host X] [--mcp-bin PATH] [--target-dir DIR] [--scope project|user] [--apply]\n`
  );
  process.exit(1);
}

const plan = onboard(harness, {
  host: flags.host ?? hostname(),
  project: flags.project ?? 'default',
  substrateUrl,
  ...(flags['mcp-bin'] ? { mcpBin: flags['mcp-bin'] } : {}),
  ...(flags.scope ? { scope: flags.scope } : {})
});

const ctx = { targetDir: flags['target-dir'] ?? process.cwd(), home: process.env.HOME ?? '~' };
const out = (s) => process.stdout.write(`${s}\n`);

out(`\nonboard ${plan.harness} → ${plan.kid}\n`);

if (flags.apply) {
  const s = applyOnboard(plan, ctx);
  out('WROTE:');
  for (const p of s.written) out(`  + ${p}`);
  if (s.skipped.length) {
    out('SKIPPED (exists — review/merge):');
    for (const k of s.skipped) out(`  ~ ${k.path}${k.merge ? '  (structured merge)' : ''}`);
  }
  out('\nIDENTITY — run these (PRIVILEGED steps need an operator):\n');
  out(s.identityScript);
  if (s.primeHint) out(`PRIME: ${s.primeHint}`);
} else {
  const a = planActions(plan, { ...ctx, existing: existingTargets(plan, ctx) });
  out('WOULD WRITE (dry-run — pass --apply to write):');
  for (const w of a.writes) out(`  + ${w.path}`);
  if (a.skipped.length) {
    out('WOULD SKIP (exists — review/merge):');
    for (const k of a.skipped) out(`  ~ ${k.path}${k.merge ? '  (structured merge)' : ''}`);
  }
  out('\nIDENTITY:\n');
  out(a.identityScript);
  if (a.primeHint) out(`PRIME: ${a.primeHint}`);
}
