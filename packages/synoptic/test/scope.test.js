import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectSlug, projectWhere, sessionRoot } from '../src/scope.js';

describe('projectSlug', () => {
  it('is the root directory basename', () => {
    expect(projectSlug('/w/synoptic', {})).toBe('synoptic');
  });
  it('is null (cross-project) under SYNOPTIC_PROJECT_SCOPE=all', () => {
    expect(projectSlug('/w/synoptic', { SYNOPTIC_PROJECT_SCOPE: 'all' })).toBeNull();
  });
});

describe('projectWhere', () => {
  it('scopes to the project plus cross-cutting rows', () => {
    expect(projectWhere('synoptic')).toEqual({
      archived: { eq: false },
      project: { in: ['synoptic', null] }
    });
  });
  it('drops the project filter for a null or absent slug', () => {
    expect(projectWhere(null)).toEqual({ archived: { eq: false } });
    expect(projectWhere(undefined)).toEqual({ archived: { eq: false } });
  });
});

describe('sessionRoot', () => {
  it('resolves a subdirectory to its repository root', () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-root-'));
    mkdirSync(join(root, '.git'));
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(sessionRoot(sub)).toBe(root);
  });
  it('falls back to the start directory outside any repository', () => {
    const bare = mkdtempSync(join(tmpdir(), 'scope-bare-'));
    writeFileSync(join(bare, 'x'), '');
    expect(sessionRoot(bare)).toBe(bare);
  });
});
