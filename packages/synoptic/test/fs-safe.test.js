import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listDirsOrNull, listOrNull, readOrNull } from '../src/fs-safe.js';

const dir = mkdtempSync(join(tmpdir(), 'fs-safe-'));
writeFileSync(join(dir, 'f.txt'), 'hello');
mkdirSync(join(dir, 'sub'));

describe('fs-safe', () => {
  it('readOrNull reads utf8, or null when absent', () => {
    expect(readOrNull(join(dir, 'f.txt'))).toBe('hello');
    expect(readOrNull(join(dir, 'missing'))).toBeNull();
  });
  it('listOrNull returns dirents, or null when absent', () => {
    expect(
      listOrNull(dir)
        ?.map((d) => d.name)
        .sort()
    ).toEqual(['f.txt', 'sub']);
    expect(listOrNull(join(dir, 'missing'))).toBeNull();
  });
  it('listDirsOrNull returns directory names only, or null when absent', () => {
    expect(listDirsOrNull(dir)).toEqual(['sub']);
    expect(listDirsOrNull(join(dir, 'missing'))).toBeNull();
  });
});
