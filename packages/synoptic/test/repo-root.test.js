import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../src/repo-root.js';

const ME = 1000;
// `owned` maps path -> owner uid; anything absent does not exist.
const io = (owned) => ({ uid: ME, ownerOf: (p) => owned[p] ?? null });
const mine = (...paths) => Object.fromEntries(paths.map((p) => [p, ME]));

describe('findRepoRoot', () => {
  it('walks up from a subdirectory to the directory holding .git', () => {
    const fs = io(mine('/work/substrate', '/work/substrate/.git'));
    expect(findRepoRoot('/work/substrate/apps/substrate-tui', fs)).toBe('/work/substrate');
  });

  it('returns the start itself when it is the root', () => {
    expect(
      findRepoRoot('/work/substrate', io(mine('/work/substrate', '/work/substrate/.git')))
    ).toBe('/work/substrate');
  });

  it('stops at the nearest .git, so a nested repo or worktree is its own root', () => {
    const fs = io(
      mine(
        '/work/substrate',
        '/work/substrate/.git',
        '/work/substrate/vendor/lib',
        '/work/substrate/vendor/lib/.git'
      )
    );
    expect(findRepoRoot('/work/substrate/vendor/lib/src', fs)).toBe('/work/substrate/vendor/lib');
  });

  it('is null outside any repository', () => {
    expect(findRepoRoot('/tmp/scratch', io({}))).toBeNull();
  });

  // A .git planted in a shared ancestor must not adopt the session: that
  // root's settings would decide which server the session signs to.
  it('refuses a root whose .git belongs to another user', () => {
    const fs = io({ '/tmp': 0, '/tmp/.git': 1001 });
    expect(findRepoRoot('/tmp/scratch/work', fs)).toBeNull();
  });

  it('refuses a root directory owned by another user, even with a .git of ours', () => {
    const fs = io({ '/shared': 0, '/shared/.git': ME });
    expect(findRepoRoot('/shared/sub', fs)).toBeNull();
  });

  it('does not keep walking past a refused .git to an owned one above it', () => {
    const fs = io({
      ...mine('/home/me', '/home/me/.git'),
      '/home/me/drop': ME,
      '/home/me/drop/.git': 1001
    });
    expect(findRepoRoot('/home/me/drop/x', fs)).toBeNull();
  });

  it('is null for an empty start, and never throws', () => {
    expect(findRepoRoot('', io({}))).toBeNull();
    expect(
      findRepoRoot('/a/b', {
        uid: ME,
        ownerOf: () => {
          throw new Error('EACCES');
        }
      })
    ).toBeNull();
  });
});
