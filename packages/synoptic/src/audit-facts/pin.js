// The marketplace pin, the clone it was read from, and the installed OpenCode skin.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { compareVersions } from '../fragment-resolve.js';
import { listOrNull, readOrNull } from '../fs-safe.js';
import { newestOpencodeSkin, readMarketplacePin } from '../marketplace-pin.js';

/** @param {{ pluginsDir: string, fetch: boolean }} p `fetch` verifies the clone against its remote. */
export function readPinFacts({ pluginsDir, fetch }) {
  // The marketplace pin, which nothing read. Both tools labelled the local
  // install `pin/installed:` and thereby asserted a fact neither checked.
  const marketplacesDir = join(pluginsDir, 'marketplaces');
  const pin = readMarketplacePin({
    marketplacesDir,
    listDir: (d) => (listOrNull(d) ?? []).filter((e) => e.isDirectory()).map((e) => e.name),
    readFile: readOrNull
  });

  // Verifying the clone against its remote costs network, so it is opt-in. When
  // it is NOT done the pin is reported as unverified rather than trusted — a
  // local clone genuinely cannot know whether it is behind, and claiming
  // otherwise is how this defect happened.
  //
  // The RESULT is three-valued, not boolean. A boolean collapsed "no check ran"
  // into "the check ran and found the clone behind", so the one condition --fetch
  // exists to detect rendered as the caveat that says to pass --fetch. See
  // auditPin for the observed case.
  //
  // Counting both directions rather than comparing SHAs, because `local !== remote`
  // is true for behind, ahead AND diverged, and those want different sentences.
  let cloneFreshness = 'unchecked';
  let cloneDetail = null;
  if (fetch === true && pin !== null) {
    try {
      const clone = join(marketplacesDir, pin.marketplace);
      const git = (...args) =>
        execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', timeout: 15000 }).trim();
      execFileSync('git', ['-C', clone, 'fetch', '--quiet'], { timeout: 15000, stdio: 'ignore' });
      const behind = Number(git('rev-list', '--count', 'HEAD..@{u}'));
      const ahead = Number(git('rev-list', '--count', '@{u}..HEAD'));
      const local = git('rev-parse', '--short', 'HEAD');
      const remote = git('rev-parse', '--short', '@{u}');
      if (behind > 0) {
        cloneFreshness = 'behind';
        cloneDetail =
          `local ${local}, remote ${remote} — ${behind} commit(s) behind` +
          (ahead > 0 ? ` and ${ahead} ahead (diverged)` : '');
      } else if (ahead > 0) {
        cloneFreshness = 'ahead';
        cloneDetail = `local ${local}, remote ${remote} — ${ahead} commit(s) ahead`;
      } else {
        cloneFreshness = 'current';
      }
    } catch {
      // A fetch that fails leaves us knowing nothing, which is 'unchecked' — NOT
      // 'current'. Failing closed here is the whole point of the three states.
      cloneFreshness = 'unchecked';
      cloneDetail = null;
    }
  }
  return { marketplacesDir, pin, cloneFreshness, cloneDetail };
}

/** @param {{ home: string }} p */
export function readSkinFacts({ home }) {
  // The OpenCode skin installs through Bun into the opencode npm cache, not the
  // Claude plugin cache — installed_plugins.json cannot answer it. Same
  // three-state discipline as installedVersion above: unreadable/absent stays
  // null and the reconciler reports the hole rather than claiming "not
  // installed".
  const opencodeSkinVersion = newestOpencodeSkin({
    cacheRoot: join(home, '.cache', 'opencode'),
    listDir: (d) => (listOrNull(d) ?? []).filter((e) => e.isDirectory()).map((e) => e.name),
    readFile: readOrNull,
    compare: compareVersions
  });
  return { opencodeSkinVersion };
}
