import { defineConfig } from 'tsdown';
import { stableRegionPaths } from '../../scripts/stable-region-paths.mjs';

// One committed, byte-deterministic ESM file with the synoptic host inlined,
// as cortext-opencode does it: OMP loads dist/extension.js with nothing to
// resolve, and the extension has zero runtime deps.
export default defineConfig({
  entry: { extension: 'src/extension.ts' },
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
