import { describe, expect, it } from 'vitest';
import { closeOpenFence, flattenHeadings } from '../src/fold.js';

describe('fences close only on their own kind', () => {
  it('closes an open ~~~ block with ~~~, and a ``` inside it is content', () => {
    expect(closeOpenFence('a\n~~~\ncode\n```\nmore')).toBe('a\n~~~\ncode\n```\nmore\n~~~');
    expect(closeOpenFence('a\n```\ncode')).toBe('a\n```\ncode\n```');
    expect(closeOpenFence('a\n~~~~\nx\n~~~~\nb')).toBe('a\n~~~~\nx\n~~~~\nb');
  });

  it('does not flatten a heading inside a ~~~ block that contains ```', () => {
    const out = flattenHeadings('~~~\n```\n## inside\n~~~\n## outside');
    expect(out).toContain('## inside');
    expect(out).toContain('**outside**');
  });
});
