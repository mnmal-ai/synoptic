/**
 * Tests for the disk-headroom watchdog.
 *
 * `statfs` is injected rather than mocked at the module level, so these assert
 * the arithmetic and the thresholds against known block counts instead of
 * against whatever the machine running them happens to have free.
 */

import { describe, expect, it } from 'vitest';
import { checkDiskHeadroom, diskWarning, renderDiskWarning } from '../src/disk-headroom.js';

const GIB = 1024 ** 3;
/** A statfs stub in whole GiB. `avail` defaults to `free` unless given. */
const fs =
  ({ total, free, avail = free }) =>
  () => ({
    bsize: 4096,
    blocks: (total * GIB) / 4096,
    bfree: (free * GIB) / 4096,
    bavail: (avail * GIB) / 4096
  });

describe('checkDiskHeadroom', () => {
  it('reports ok with headroom to spare', () => {
    const r = checkDiskHeadroom({
      path: '/x',
      minFreeGib: 10,
      statfs: fs({ total: 100, free: 40 })
    });
    expect(r).toMatchObject({ status: 'ok', freeGib: 40, totalGib: 100 });
    expect(Math.round(r.percentUsed)).toBe(60);
  });

  it('reports low below the threshold', () => {
    const r = checkDiskHeadroom({
      path: '/x',
      minFreeGib: 10,
      statfs: fs({ total: 100, free: 9 })
    });
    expect(r.status).toBe('low');
    expect(Math.round(r.percentUsed)).toBe(91);
  });

  it('treats exactly the threshold as ok, not low', () => {
    // A strict `<` so an operator who sets 10 does not get warned at 10.
    expect(
      checkDiskHeadroom({ path: '/x', minFreeGib: 10, statfs: fs({ total: 100, free: 10 }) }).status
    ).toBe('ok');
  });

  it('measures AVAILABLE blocks, not free ones', () => {
    // The kernel reserves blocks for root that a build cannot touch. Counting
    // them would promise headroom the thing that fills the disk cannot reach
    // — the wrong direction for a warning to be wrong in.
    const r = checkDiskHeadroom({
      path: '/x',
      minFreeGib: 10,
      statfs: fs({ total: 100, free: 15, avail: 5 })
    });
    expect(r.status).toBe('low');
    expect(r.freeGib).toBe(5);
  });

  it('reports error rather than throwing when the path is unreadable', () => {
    const r = checkDiskHeadroom({
      path: '/nope',
      minFreeGib: 10,
      statfs: () => {
        throw new Error('ENOENT');
      }
    });
    expect(r).toMatchObject({ status: 'error' });
  });

  it('reports error on a zero-block filesystem rather than dividing by zero', () => {
    const r = checkDiskHeadroom({ path: '/x', minFreeGib: 10, statfs: fs({ total: 0, free: 0 }) });
    expect(r.status).toBe('error');
  });
});

describe('renderDiskWarning', () => {
  it('is silent when ok', () => {
    expect(
      renderDiskWarning({ status: 'ok', freeGib: 40, totalGib: 100, percentUsed: 60 }, '/x')
    ).toBe('');
  });

  it('names the free space, the percentage and the path', () => {
    const out = renderDiskWarning(
      { status: 'low', freeGib: 9.6, totalGib: 111, percentUsed: 91.3 },
      '/srv/data'
    );
    expect(out).toContain('9.6 GiB');
    expect(out).toContain('91%');
    expect(out).toContain('/srv/data');
  });

  it('reports a failed check LOUDER than low headroom', () => {
    // A watchdog pointed at a path that no longer exists must not look
    // identical to a healthy volume.
    expect(renderDiskWarning({ status: 'error', reason: 'ENOENT' }, '/gone')).toContain(
      'DID NOT RUN'
    );
  });
});

describe('diskWarning env gate', () => {
  const low = fs({ total: 100, free: 1 });

  it('is silent unless explicitly switched on', () => {
    // A generic consumer of the plugin must never inherit a host-specific
    // watchdog it did not ask for.
    expect(diskWarning({}, low)).toBe('');
    expect(diskWarning({ SYNOPTIC_DISK_CHECK: 'true' }, low)).toBe('');
    expect(diskWarning({ SYNOPTIC_DISK_CHECK: 'ON' }, low)).toBe('');
  });

  it('fires when on and below the configured threshold', () => {
    const out = diskWarning({ SYNOPTIC_DISK_CHECK: 'on', SYNOPTIC_DISK_PATH: '/srv/data' }, low);
    expect(out).toContain('DISK HEADROOM LOW');
  });

  it('honours a custom threshold', () => {
    const env = { SYNOPTIC_DISK_CHECK: 'on', SYNOPTIC_DISK_MIN_FREE_GIB: '0.5' };
    expect(diskWarning(env, low)).toBe('');
  });

  it('falls back to the default threshold on an unparseable one', () => {
    // `Number('abc') || 10` — a typo must not silently disable the watchdog,
    // which is the failure mode of every `:-` style fallback.
    const env = { SYNOPTIC_DISK_CHECK: 'on', SYNOPTIC_DISK_MIN_FREE_GIB: 'abc' };
    expect(diskWarning(env, low)).toContain('DISK HEADROOM LOW');
  });
});
