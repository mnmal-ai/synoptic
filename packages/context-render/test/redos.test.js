import { describe, expect, it } from 'vitest';
import { flattenHeadings } from '../src/fold.js';
import { renderIndexLine } from '../src/index-pull.js';

const fast = (fn) => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

describe('renderIndexLine folds line breaks to one space', () => {
  it('replaces each whitespace run holding a line break, and leaves other runs', () => {
    expect(renderIndexLine({ synopsis: 'a \n\n  b\tc  d\ne' })).toBe('- a b\tc  d e');
  });

  it('stays linear on a long whitespace run with no line break', () => {
    expect(fast(() => renderIndexLine({ synopsis: `a${' '.repeat(20_000)}b` }))).toBeLessThan(50);
  });
});

describe('flattenHeadings', () => {
  it('keeps the heading text after its whitespace', () => {
    expect(flattenHeadings('##   Title  ')).toBe('**Title**');
    expect(flattenHeadings('# ')).toBe('');
  });

  it('stays linear on a long whitespace run before a carriage return', () => {
    expect(fast(() => flattenHeadings(`#${' '.repeat(20_000)}a\rb`))).toBeLessThan(50);
  });
});
