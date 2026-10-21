import { defineConfig } from 'tsdown';

// Bundle each CC hook to a single committed ESM artifact under hooks/, inlining
// the @mnmal-ai/synoptic host source (the entrypoints live in the host as the
// reusable hook glue; this skin bundles them for Claude Code). sourcemap:false
// keeps the build byte-deterministic so the audit recipe
// `pnpm build && git diff --stat hooks/` returns empty.
//
// One config per entry (not multi-entry): multi-entry ESM builds code-split
// shared modules into hash-named sibling chunks, breaking both determinism and
// the single-auditable-file convention. Per-entry configs duplicate the small
// shared modules into each self-contained artifact instead.
const HOST = '../synoptic/src';
const shared = {
  outDir: 'hooks',
  format: ['esm' as const],
  outExtensions: (): { js: string } => ({ js: '.mjs' }),
  target: 'node20',
  platform: 'node' as const,
  minify: false,
  sourcemap: false,
  clean: false,
  deps: { alwaysBundle: [/.*/] }
};

export default defineConfig([
  { ...shared, entry: { 'cold-start': `${HOST}/entry.js` } },
  { ...shared, entry: { 'inbox-stop': `${HOST}/inbox-stop-entry.js` } },
  { ...shared, entry: { 'inbox-prompt': `${HOST}/inbox-prompt-entry.js` } },
  { ...shared, entry: { 'inbox-watch': `${HOST}/inbox-watch-entry.js` } },
  // The hooks module: runs in Claude Code's module environment — no Node,
  // no dynamic import(). Everything bundled except `claude-code`, whose runtime
  // exports (`update`) the engine supplies. bridge-bundle.test.js holds all three.
  {
    ...shared,
    entry: { 'inbox-bridge': 'src/inbox-bridge.ts' },
    platform: 'neutral' as const,
    target: 'es2022',
    deps: { neverBundle: ['claude-code'], alwaysBundle: [/^(?!claude-code$).*/] }
  },
  // Not hooks — CLIs the /substrate-setup skill shells out to. Bundled the same way
  // and for the same reason: a self-contained artifact has no import resolution
  // to get wrong (a hand-written file importing `../src/` would throw, since
  // this package has no `src/` for the host code).
  { ...shared, outDir: 'bin', entry: { 'resolve-fragment': `${HOST}/fragment-resolve-entry.js` } },
  { ...shared, outDir: 'bin', entry: { audit: `${HOST}/audit-entry.js` } },
  { ...shared, outDir: 'bin', entry: { 'prune-cache': `${HOST}/cache-prune-entry.js` } },
  { ...shared, outDir: 'bin', entry: { onboard: `${HOST}/onboard-entry.js` } }
]);
