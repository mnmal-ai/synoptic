// The repository a session belongs to, from the directory it started in.
// A session can start in any subdirectory, and everything keyed by "the
// repo" (project scope, settings, the conventions fragment, HostInstall)
// lives at the root, not there.

import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Owner uid of `path`, or null when it does not exist. */
function ownerOf(path) {
  try {
    return statSync(path).uid;
  } catch {
    return null;
  }
}

/**
 * The nearest ancestor of `start` (itself included) holding `.git`, a
 * directory in a checkout or a file in a worktree. Null outside any
 * repository, and never throws.
 *
 * The root's settings decide which server this session signs to, so a root
 * is accepted only when it and its `.git` belong to the current user, the
 * same rule as git's safe.directory: a `.git` planted in a shared ancestor
 * such as /tmp must not be able to adopt a session. The walk stops at the
 * nearest `.git` either way.
 *
 * @param {string} start
 * @param {{ ownerOf?: (path: string) => number|null, uid?: number|null }} [io]
 * @returns {string|null}
 */
export function findRepoRoot(start, io = {}) {
  if (!start) return null;
  const owner = io.ownerOf ?? ownerOf;
  const uid = io.uid !== undefined ? io.uid : (process.getuid?.() ?? null);
  try {
    let dir = start;
    for (;;) {
      const gitOwner = owner(join(dir, '.git'));
      if (gitOwner !== null) {
        // Platforms without uids (Windows) have nothing to compare.
        if (uid === null) return dir;
        return gitOwner === uid && owner(dir) === uid ? dir : null;
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}
