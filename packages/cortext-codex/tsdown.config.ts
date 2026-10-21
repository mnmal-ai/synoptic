import { defineConfig } from 'tsdown';

const shared = {
  format: ['esm' as const],
  outExtensions: () => ({ js: '.mjs' }),
  target: 'node20',
  platform: 'node' as const,
  minify: false,
  sourcemap: false,
  clean: false,
  deps: { alwaysBundle: [/.*/] }
};

// Separate entries keep the reviewed artifacts self-contained in plugin caches.
export default defineConfig([
  { ...shared, outDir: 'hooks', entry: { cortext: 'src/hook-entry.js' } },
  { ...shared, outDir: 'bin', entry: { 'substrate-mcp': 'src/mcp-entry.js' } }
]);
