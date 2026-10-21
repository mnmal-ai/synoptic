/**
 * The range of substrate versions both cortext plugins are built against.
 *
 * ONE literal, used in two places that must never disagree:
 *
 *   1. `contractVersion` on both plugin objects, checked by the substrate
 *      loader at boot, which refuses a plugin outside it.
 *   2. The `@mnmal-ai/substrate` peer range in the manifest, checked by the
 *      package manager at install.
 *
 * Both exist because they guard different paths: `SUBSTRATE_PLUGIN_DIR` scans
 * a directory, so a plugin dropped in by hand never meets a package manager,
 * and the loader check is all that is left.
 *
 * The ceiling tracks actual plugin-facing compatibility, not the next major
 * by reflex: widen it only after reading what the new major changed.
 * `substrate-contract-parity.test.ts` holds the manifest to this literal.
 */
export const SUBSTRATE_CONTRACT_RANGE = '>=1.0.0-alpha.0 <2.0.0';
