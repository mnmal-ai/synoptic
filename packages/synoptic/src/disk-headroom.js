/**
 * Disk-headroom watchdog.
 *
 * ## The gap this closes
 *
 * A host that keeps repos, the substrate runtime, the toolchain and the pnpm
 * global store on one volume has one headroom number, and nothing else
 * watches it.
 *
 * Nothing is failing. That is the point — a full volume is loud at the instant
 * it happens and silent for every day of approach, and the things most likely
 * to find the wall are routine: a `pnpm install` that re-downloads the store
 * (7.7 GiB before it was last deleted as regenerable), turbo cache growth, a
 * Rust `target/` (5.0 GiB when last cleared). The postgres data directory
 * lives under the same volume via the runtime dir.
 *
 * ## Why opt-in, and why it ships with no default threshold that fires
 *
 * Same contract as `backupWarning`: `SYNOPTIC_DISK_CHECK=on` or this does
 * nothing, so a generic consumer of the plugin never sees it. Host-specific
 * watchdogs that arrive switched on are how a fleet acquires warnings nobody
 * chose.
 *
 * The threshold is the operator's to set BECAUSE a useful number here is
 * host-specific — 10 GiB is comfortable on a box that builds nothing and one
 * `cargo build` from trouble on this one. A default low enough to be safe
 * everywhere would fire on every host that is merely well-used, and a warning
 * that fires on a healthy machine is one people learn to skip past on their
 * way to the one that matters.
 *
 * ## GiB, not GB
 *
 * Reported in GiB so the number matches what `df -h` prints. The same volume
 * reads 10.3 GB and 9.6 GiB, and an operator comparing a warning against their
 * own terminal should not have to work out which convention each used.
 */

import { statfsSync } from 'node:fs';

const BYTES_PER_GIB = 1024 ** 3;

/**
 * @returns {{ status: 'ok' | 'low', freeGib: number, totalGib: number, percentUsed: number }
 *          | { status: 'error', reason: string }}
 */
export function checkDiskHeadroom({ path, minFreeGib, statfs = statfsSync }) {
  let st;
  try {
    st = statfs(path);
  } catch (e) {
    return { status: 'error', reason: e?.message ?? String(e) };
  }
  // `bavail` rather than `bfree`: the kernel reserves blocks for root, and a
  // non-root process cannot use them. Reporting bfree would promise headroom
  // the thing that actually fills the disk — a build, an install — cannot
  // reach, which is the wrong direction for a warning to be wrong in.
  const freeGib = (st.bavail * st.bsize) / BYTES_PER_GIB;
  const totalGib = (st.blocks * st.bsize) / BYTES_PER_GIB;
  if (!(totalGib > 0)) return { status: 'error', reason: `statfs reported no blocks for ${path}` };
  return {
    status: freeGib < minFreeGib ? 'low' : 'ok',
    freeGib,
    totalGib,
    percentUsed: 100 * (1 - freeGib / totalGib)
  };
}

/** One-line marker for the cold-start hook. Silent when there is headroom. */
export function renderDiskWarning(result, path) {
  if (result.status === 'ok') return '';
  if (result.status === 'low') {
    return (
      `⚠ DISK HEADROOM LOW: ${result.freeGib.toFixed(1)} GiB free on ${path} ` +
      `(${Math.round(result.percentUsed)}% used). A full volume is loud the instant it ` +
      'happens and silent for every day of approach; the usual culprits are a re-downloaded ' +
      'pnpm store, turbo cache, and build output.\n\n'
    );
  }
  // Louder than low headroom, because this is the CHECK failing rather than
  // the disk. Silence has to mean measured-and-fine — if this were swallowed,
  // a watchdog pointed at a path that no longer exists would look identical to
  // a healthy volume.
  return `⚠ DISK CHECK DID NOT RUN: ${result.reason}\n\n`;
}

/**
 * Env-gated entry point. Never throws — a cold-start hook degrades to less
 * context rather than none, the same contract as `backupWarning`.
 */
export function diskWarning(env = process.env, statfs = statfsSync) {
  if (env.SYNOPTIC_DISK_CHECK !== 'on') return '';
  const path = env.SYNOPTIC_DISK_PATH ?? '/';
  const minFreeGib = Number(env.SYNOPTIC_DISK_MIN_FREE_GIB) || 10;
  try {
    return renderDiskWarning(checkDiskHeadroom({ path, minFreeGib, statfs }), path);
  } catch {
    return '';
  }
}
