import { describe, expect, it } from 'vitest';
import { inferTodoResolution } from '../src/todo-resolution.js';

describe('inferTodoResolution', () => {
  it.each([
    [{ title: 'Add X', notes: 'Merged in PR #812' }, 'completed'],
    [{ title: 'Add X', notes: 'Merged into #861 (same defect)' }, 'superseded'],
    [{ title: 'Add X', notes: 'shipped in v6.2.0' }, 'completed'],
    [{ title: 'Add X', notes: 'Superseded by #1201' }, 'superseded'],
    [{ title: 'Add X', notes: 'folded into #990, which shipped' }, 'superseded'],
    [{ title: 'Add X', notes: 'duplicate of #400' }, 'duplicate'],
    [{ title: 'Add X', notes: 'moot after the rewrite' }, 'obsolete'],
    [{ title: 'Add X', notes: "won't do: not worth the complexity" }, 'wont_do'],
    [{ title: 'Add X', notes: 'cancelled' }, 'wont_do'],
    [{ title: "[CLOSED won't-do 2026-10-02, operator] thing" }, 'wont_do'],
    [{ notes: 'Closed 2026-05-04 as stale. v2 shipped since.' }, 'obsolete'],
    [{ notes: 'Surfaced while landing Todo #85 (PR #246).' }, 'unspecified'],
    [{ notes: 'CLOSED 2026-07-31 by PR #409.' }, 'completed'],
    [{ notes: 'Delivered in v1.9.0.' }, 'completed'],
    [{ title: 'Add X' }, 'unspecified'],
    [{ title: 'Add X', notes: null, body: null }, 'unspecified']
  ])('%o -> %s', (todo, expected) => {
    expect(inferTodoResolution(todo)).toBe(expected);
  });

  it('the earliest cue wins: a closure statement leads, later prose is incidental', () => {
    expect(inferTodoResolution({ notes: 'superseded by #12; the replacement shipped' })).toBe(
      'superseded'
    );
    expect(
      inferTodoResolution({ notes: 'DONE via PR #93. The old path was dropped as a duplicate.' })
    ).toBe('completed');
  });

  it('ignores cues beyond the opening of the notes', () => {
    expect(inferTodoResolution({ notes: `${'x '.repeat(200)}cancelled` })).toBe('unspecified');
  });

  it('reads only the bracketed verdict of a title, not the problem it describes', () => {
    expect(inferTodoResolution({ title: 'A declined source falls to a deep tier' })).toBe(
      'unspecified'
    );
    expect(
      inferTodoResolution({ title: '[FIXED + VERIFIED LIVE 2026-08-21 — PR #683] thing' })
    ).toBe('completed');
  });
});
