// Rolldown's `//#region` comments name each bundled file by its on-disk path,
// and under pnpm that path runs through the store directory, which encodes the
// package version and its peer set, e.g.
//   node_modules/.pnpm/@opencode+plugin@2.0.24_<peers>/node_modules/@opencode/plugin/...
// So a lockfile-only dependency bump rewrites a comment in every committed
// bundle without changing any code, and CI's build-drift check fails until
// someone rebuilds by hand. Collapse the store segment so the comment
// keeps WHICH package a region came from but not WHICH version — that is the
// lockfile's job.
const STORE_SEGMENT = /node_modules\/\.pnpm\/[^/\n]+\/node_modules\//g;

export function stableRegionPaths() {
  return {
    name: 'stable-region-paths',
    renderChunk(code) {
      return code.replace(STORE_SEGMENT, 'node_modules/');
    }
  };
}
