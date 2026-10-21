import { defineConfig } from 'tsdown';
import { stableRegionPaths } from '../../scripts/stable-region-paths.mjs';

// Bundle the OpenCode plugin to a single committed ESM artifact
// (dist/plugin.js), inlining the @mnmal-ai/synoptic host source — the same
// single-auditable-file convention as cortext-plugin's hooks/*.mjs: a
// self-contained artifact has no import resolution to get wrong, and zero
// runtime deps means the consumer's `bun install` pulls nothing extra.
// sourcemap:false keeps the build byte-deterministic so the audit recipe
// `pnpm build && git diff --stat dist/` returns empty.
//
// The `@opencode-ai/plugin` import is type-only (erased at bundle); the host
// contract it types against is OpenCode's, resolved from the running CLI.
export default defineConfig({
  entry: { plugin: 'src/plugin.ts' },
  outDir: 'dist',
  format: ['esm'],
  fixedExtension: false,
  target: 'node20',
  platform: 'node',
  minify: false,
  sourcemap: false,
  clean: true,
  deps: { alwaysBundle: [/.*/] },
  plugins: [stableRegionPaths()]
});
