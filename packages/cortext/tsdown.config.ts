import type { UserConfig } from 'tsdown';

// Annotated because `substrate-contract-parity.test.ts` imports this config to
// assert peers ⊆ external; without it TS cannot name the inferred type.
const config: UserConfig = {
  // One build for both plugins, so code they share lands in one chunk: one
  // copy of each class in the process.
  entry: {
    index: 'src/index.ts',
    bootstrap: 'src/bootstrap.ts',
    kernel: 'src/kernel/index.ts',
    'kernel-bootstrap': 'src/kernel/bootstrap.ts'
  },
  format: ['esm'],
  platform: 'node',
  target: 'node26',
  fixedExtension: false,
  sourcemap: false,
  clean: true,
  minify: false,
  outDir: 'dist',
  dts: false,
  // Hand-maintained allowlist: anything NOT listed here is INLINED into dist/,
  // silently, so a missing entry ships a private copy of a whole module graph
  // inside cortext. Every entry in `peerDependencies`
  // MUST appear here; `substrate-contract-parity.test.ts` enforces that.
  deps: {
    neverBundle: [/^@mnmal-ai\/substrate(\/|$)/, 'postgres', 'zod', /^node:/]
  }
};

export default config;
