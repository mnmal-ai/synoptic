import { describe, expect, it } from 'vitest';
import { parseMaxBytes, renderSessionStart } from '../src/session-start.js';

describe('renderSessionStart', () => {
  it('returns the render with any auth warning in front', async () => {
    const out = await renderSessionStart({
      render: async () => 'doc\n',
      env: {},
      authWarning: 'warn\n'
    });
    expect(out).toBe('warn\ndoc\n');
  });

  it('a render slower than the budget becomes the timeout note', async () => {
    const out = await renderSessionStart({
      render: () => new Promise((r) => setTimeout(() => r('late'), 200)),
      env: {},
      budgetMs: 20
    });
    expect(out).toContain('cold-start unavailable (timeout)');
  });

  it('a render that throws becomes a one-line note, never an exception', async () => {
    const out = await renderSessionStart({
      render: async () => {
        throw new Error('boom\nsecond line');
      },
      env: {}
    });
    expect(out).toBe('<!-- synoptic cold-start failed: boom second line -->\n');
  });

  it('applies SYNOPTIC_COLD_START_MAX_BYTES', async () => {
    const doc = `${'line of text\n'.repeat(200)}`;
    const out = await renderSessionStart({
      render: async () => doc,
      env: { SYNOPTIC_COLD_START_MAX_BYTES: '500' }
    });
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(500);
    expect(out.length).toBeLessThan(doc.length);
  });

  it('blank or malformed caps mean uncapped', () => {
    expect(parseMaxBytes(undefined)).toBeNull();
    expect(parseMaxBytes('')).toBeNull();
    expect(parseMaxBytes('abc')).toBeNull();
    expect(parseMaxBytes('-5')).toBeNull();
    expect(parseMaxBytes('15000.7')).toBe(15000);
  });
});
