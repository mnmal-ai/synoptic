/**
 * Open Work renders an ASSIGNMENT, not an inventory.
 *
 * `owner` and `revisitWhen` gate a row; ignoring them shows every open row as
 * equally available, including `[SG]` rows whose `blockedBy` says not yet.
 *
 * These pin the classification, because every way of getting it wrong renders
 * as a plausible-looking list.
 */

import { describe, expect, it } from 'vitest';
import { classifyTodo, renderTodos } from '../src/render.js';

const ME = 'id-me';
const todo = (over = {}) => ({
  shortId: 1,
  title: 't',
  status: 'open',
  priority: 'medium',
  ...over
});

describe('classifyTodo', () => {
  it('an ungated, unowned row is ready', () => {
    expect(classifyTodo(todo(), ME)).toBe('ready');
  });

  it('blockedBy or revisitWhen makes it waiting', () => {
    expect(classifyTodo(todo({ blockedBy: 'until X ships' }), ME)).toBe('waiting');
    expect(classifyTodo(todo({ revisitWhen: 'if drift recurs' }), ME)).toBe('waiting');
  });

  it('status blocked is waiting even with no gate prose', () => {
    // The worst-recorded rows are the ones with a status and no reason. If
    // absent prose read as "no gate" they would file under ready, which is
    // exactly backwards.
    expect(classifyTodo(todo({ status: 'blocked' }), ME)).toBe('waiting');
  });

  it('whitespace-only gate prose does not count as a gate', () => {
    expect(classifyTodo(todo({ blockedBy: '   \n ' }), ME)).toBe('ready');
  });

  it('separates mine from owned elsewhere', () => {
    expect(classifyTodo(todo({ owner: ME }), ME)).toBe('mine');
    expect(classifyTodo(todo({ owner: 'id-someone-else' }), ME)).toBe('elsewhere');
  });

  it('A GATE OUTRANKS AN OWNER', () => {
    // A row with both is not work someone is doing — it is work someone put
    // their name to that the world is not ready for. Filing it under an owner
    // would present it as in-flight.
    expect(classifyTodo(todo({ owner: ME, blockedBy: 'until X' }), ME)).toBe('waiting');
  });

  it('with no identity resolved, an owned row is NOT claimed as mine', () => {
    // A session with no kid cannot know. Guessing "mine" would invent
    // ownership; `elsewhere` is the conservative reading and is at least
    // honest that someone holds it.
    expect(classifyTodo(todo({ owner: ME }), null)).toBe('elsewhere');
  });
});

describe('renderTodos', () => {
  const rows = [
    todo({ shortId: 1, title: 'ready one', priority: 'high' }),
    todo({ shortId: 2, title: 'gated', blockedBy: 'Signal-gated on DEMAND: a consumer asks.' }),
    todo({ shortId: 3, title: 'theirs', owner: 'id-other' }),
    todo({ shortId: 4, title: 'claimed', owner: ME })
  ];

  it('leads the header with what can be acted on', () => {
    const out = renderTodos(rows, { myIdentityId: ME });
    expect(out).toContain('## Open Work (4 total — 2 ready, 1 owned elsewhere, 1 waiting)');
  });

  it('groups the rows under headings', () => {
    const out = renderTodos(rows, { myIdentityId: ME });
    expect(out).toContain('### Claimed by me (1)');
    expect(out).toContain('### Ready — unclaimed, no gate (1)');
    expect(out).toContain('### Owned elsewhere (1)');
    expect(out).toContain('### Waiting on a condition (1)');
  });

  it('shows the gate CONDITION on a waiting row', () => {
    // "waiting" alone sends the reader to open the row. The condition is what
    // makes it re-derivable from the digest.
    expect(renderTodos(rows, { myIdentityId: ME })).toContain('Signal-gated on DEMAND');
  });

  it('omits empty groups rather than printing (0)', () => {
    // A heading with nothing under it spends budget to say nothing, and the
    // header totals already carry the fact.
    const out = renderTodos([todo({ shortId: 9, title: 'only ready' })], { myIdentityId: ME });
    expect(out).toContain('### Ready');
    expect(out).not.toContain('Waiting on a condition');
    expect(out).not.toContain('Owned elsewhere');
  });

  it('still returns empty string for no rows', () => {
    expect(renderTodos([], { myIdentityId: ME })).toBe('');
    expect(renderTodos(null, { myIdentityId: ME })).toBe('');
  });

  it('works with no options at all, for callers that pass none', () => {
    expect(renderTodos([todo()])).toContain('## Open Work (1 total — 1 ready)');
  });

  it('degrades to "elsewhere" when the identity frame is ABSENT from the envelope', () => {
    // The production degradation path, and the reason this is safe to batch:
    // Substrate's partial-success envelope drops a failing frame's key rather than
    // failing the request, so a refused AgentIdentity lookup yields
    // `myIdentityId: null` while open work still renders. Every owned row then
    // reads as someone else's — conservative, and never invents ownership.
    const out = renderTodos([todo({ shortId: 5, title: 'owned', owner: ME })], {
      myIdentityId: null
    });
    expect(out).toContain('### Owned elsewhere (1)');
    expect(out).not.toContain('Claimed by me');
  });

  it('sorts by priority within a group', () => {
    const out = renderTodos(
      [
        todo({ shortId: 10, title: 'low one', priority: 'low' }),
        todo({ shortId: 11, title: 'high one', priority: 'high' })
      ],
      { myIdentityId: ME }
    );
    expect(out.indexOf('high one')).toBeLessThan(out.indexOf('low one'));
  });
});
