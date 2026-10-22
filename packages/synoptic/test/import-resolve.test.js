/**
 * Tests for the dangling-`@`-import watchdog.
 *
 * The behaviour under test is an ABSENCE being made visible, so the cases that
 * matter are the ones where the check could plausibly say nothing: a relative
 * import resolved against the wrong directory, a second-level import, a repo
 * with no CLAUDE.md at all. Each of those failure modes renders as "clean",
 * which is the same output as working correctly.
 */

import { describe, expect, it } from 'vitest';
import {
  findDanglingImports,
  importResolutionWarning,
  parseImports,
  renderDanglingImports,
  resolveImport
} from '../src/import-resolve.js';

/** A readFile that serves a fixed map and returns null for anything else. */
const fs = (files) => (p) => (Object.hasOwn(files, p) ? files[p] : null);

describe('parseImports', () => {
  it('finds line-anchored imports, absolute and relative', () => {
    const text = '# Title\n@/abs/CLAUDE.md\n@.claude/substrate-conventions.md\n\nprose\n';
    expect(parseImports(text)).toEqual(['/abs/CLAUDE.md', '.claude/substrate-conventions.md']);
  });

  it('ignores an @ that is not at the start of a line', () => {
    // Otherwise every document naming an agent — `substrate-claude@Desk` — or
    // an npm scope would report phantom dangling imports, and a check that
    // fires on correct files is one people learn to skip.
    const text = 'Signed by substrate-claude@Desk using @mnmal-ai/substrate.\nSee foo@bar.\n';
    expect(parseImports(text)).toEqual([]);
  });

  it('returns [] for a non-string', () => {
    expect(parseImports(null)).toEqual([]);
  });
});

describe('resolveImport', () => {
  it('leaves an absolute target alone', () => {
    expect(resolveImport('/work/CLAUDE.md', '/repo/CLAUDE.md')).toBe('/work/CLAUDE.md');
  });

  it('resolves a relative target against the DECLARING file, not the cwd', () => {
    // The distinction the one-level walk exists for: `@.claude/x.md` inside
    // /work/CLAUDE.md means a file beside THAT one, not beside the
    // repo root that imported it.
    expect(resolveImport('.claude/substrate-conventions.md', '/work/CLAUDE.md')).toBe(
      '/work/.claude/substrate-conventions.md'
    );
  });
});

describe('findDanglingImports', () => {
  it('says nothing when every import resolves', () => {
    const readFile = fs({
      '/repo/CLAUDE.md': '@/shared/CLAUDE.md\n@.claude/conv.md\n',
      '/shared/CLAUDE.md': '# shared\n',
      '/repo/.claude/conv.md': '# conv\n'
    });
    expect(findDanglingImports({ cwd: '/repo', readFile })).toEqual([]);
  });

  it('checks CLAUDE.local.md, where /substrate-setup puts the fragment import', () => {
    const out = findDanglingImports({
      cwd: '/r',
      readFile: fs({ '/r/CLAUDE.local.md': '@.claude/substrate-conventions.md\n' })
    });
    expect(out).toEqual([
      {
        target: '.claude/substrate-conventions.md',
        path: '/r/.claude/substrate-conventions.md',
        declaredIn: '/r/CLAUDE.local.md'
      }
    ]);
  });

  it('reports a first-level import that does not resolve', () => {
    const readFile = fs({ '/repo/CLAUDE.md': '@/shared/CLAUDE.md\n' });
    const [d] = findDanglingImports({ cwd: '/repo', readFile });
    expect(d).toMatchObject({ target: '/shared/CLAUDE.md', declaredIn: '/repo/CLAUDE.md' });
  });

  it('reports a SECOND-level import — the shape of the ten-day outage', () => {
    // <repo>/CLAUDE.md resolved fine; the directory CLAUDE.md it imported was
    // the thing that had gone. A check stopping at the first hop reports clean.
    const readFile = fs({
      '/repo/CLAUDE.md': '@/shared/CLAUDE.md\n',
      '/shared/CLAUDE.md': '@.claude/conv.md\n'
    });
    const [d] = findDanglingImports({ cwd: '/repo', readFile });
    expect(d).toMatchObject({
      target: '.claude/conv.md',
      path: '/shared/.claude/conv.md',
      declaredIn: '/shared/CLAUDE.md'
    });
  });

  it('is silent for a repo with no CLAUDE.md', () => {
    // Not a consumer. A different fact from "imports are broken", and the same
    // call fragmentDriftWarning makes about a repo that never onboarded.
    expect(findDanglingImports({ cwd: '/repo', readFile: fs({}) })).toEqual([]);
  });

  it('does not loop on a circular import', () => {
    const readFile = fs({
      '/repo/CLAUDE.md': '@/shared/CLAUDE.md\n',
      '/shared/CLAUDE.md': '@/repo/CLAUDE.md\n'
    });
    expect(findDanglingImports({ cwd: '/repo', readFile })).toEqual([]);
  });
});

describe('rendering and the never-throws contract', () => {
  it('renders nothing when nothing dangles', () => {
    expect(renderDanglingImports([])).toBe('');
  });

  it('names the target, the declaring file and the resolved path', () => {
    const out = renderDanglingImports([
      { target: '/shared/CLAUDE.md', path: '/shared/CLAUDE.md', declaredIn: '/repo/CLAUDE.md' }
    ]);
    expect(out).toContain('/shared/CLAUDE.md');
    expect(out).toContain('/repo/CLAUDE.md');
    // The operator's next move is the symlink, which is how the original hid.
    expect(out).toContain('symlink');
  });

  it('returns empty string rather than throwing when readFile explodes', () => {
    // A cold-start hook degrades to less context, never to no context.
    const boom = () => {
      throw new Error('EIO');
    };
    expect(importResolutionWarning({ cwd: '/repo', readFile: boom })).toBe('');
  });
});
