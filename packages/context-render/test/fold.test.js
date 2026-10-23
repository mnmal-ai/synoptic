import { describe, expect, it } from 'vitest';
import { closeOpenFence, cutAtLineBoundary, flattenHeadings } from '../src/fold.js';

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

it('cutAtLineBoundary never leaves half a surrogate pair', () => {
  const { text } = cutAtLineBoundary(`a${'😀'.repeat(20)}`, 4);
  const last = text.charCodeAt(text.length - 1);
  expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
});
