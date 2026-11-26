import { describe, expect, it } from 'vitest';
import { cut } from '../src/text.ts';
import {
  ago,
  BRAIN_FACTS,
  brainFactLine,
  EMPTY_BOARD,
  laneRows,
  rollBrainFact,
  viewTodos,
  wrapLines
} from '../src/todo-text.ts';

describe('cut', () => {
  it('trims and ellipsizes', () => {
    expect(cut('  hi  ', 10)).toBe('hi');
    expect(cut('abcdef', 4)).toBe('abc…');
  });
});

describe('viewTodos', () => {
  const rows = [
    {
      shortId: 1,
      title: 'Low one',
      status: 'open',
      priority: 'low',
      createdAt: '2026-11-20T00:00:00Z',
      updatedAt: '2026-11-24T00:00:00Z'
    },
    {
      shortId: 2,
      title: 'High one',
      status: 'open',
      priority: 'high',
      createdAt: '2026-11-21T00:00:00Z',
      updatedAt: '2026-11-22T00:00:00Z'
    },
    {
      shortId: 3,
      title: 'Stuck one',
      status: 'blocked',
      priority: 'medium',
      createdAt: '2026-11-22T00:00:00Z',
      updatedAt: '2026-11-23T00:00:00Z'
    }
  ];
  const base = { sort: 'priority', status: 'any', priority: 'any', search: '' };
  const ids = (view) => viewTodos(rows, { ...base, ...view }).map((t) => t.shortId);
  it('sorts by priority, recency and status', () => {
    expect(ids({})).toEqual([2, 3, 1]);
    expect(ids({ sort: 'created' })).toEqual([3, 2, 1]);
    expect(ids({ sort: 'updated' })).toEqual([1, 3, 2]);
    // Status follows the schema's order: open, in_progress, blocked, deferred, closed.
    expect(ids({ sort: 'status' })).toEqual([2, 1, 3]);
    expect(ids({ sort: 'title' })).toEqual([2, 1, 3]);
  });
  it('filters by status, priority and a title or #id search', () => {
    expect(ids({ status: 'blocked' })).toEqual([3]);
    expect(ids({ priority: 'low' })).toEqual([1]);
    expect(ids({ search: 'HIGH' })).toEqual([2]);
    expect(ids({ search: '#3' })).toEqual([3]);
  });
});

describe('ago', () => {
  it('reads seconds, minutes, hours and days', () => {
    const now = Date.parse('2026-11-25T12:00:00Z');
    expect(ago('2026-11-25T11:59:30Z', now)).toBe('30s ago');
    expect(ago('2026-11-25T11:00:00Z', now)).toBe('60m ago');
    expect(ago('2026-11-25T06:00:00Z', now)).toBe('6h ago');
    expect(ago('2026-11-20T12:00:00Z', now)).toBe('5d ago');
  });
});

describe('laneRows', () => {
  it('makes one lane per status, in the schema order, each keeping the list order', () => {
    const rows = [
      { id: 'a', status: 'blocked' },
      { id: 'b', status: 'open' },
      { id: 'c', status: 'open' }
    ];
    const lanes = laneRows(rows, ['open', 'blocked', 'closed']);
    expect(lanes.map((l) => l.lane.key)).toEqual(['open', 'blocked', 'closed']);
    expect(lanes.map((l) => l.rows.map((r) => r.id))).toEqual([['b', 'c'], ['a'], []]);
  });
});

describe('wrapLines', () => {
  it('folds a title into two lines at spaces', () => {
    expect(wrapLines('Ask the owner: OK for the gate to run', 16, 2)).toEqual([
      'Ask the owner:',
      'OK for the gate…'
    ]);
  });
  it('leaves a short title on one line', () => {
    expect(wrapLines('Short one', 20, 2)).toEqual(['Short one']);
  });
  it('splits a word wider than the line', () => {
    expect(wrapLines('abcdefghij', 4, 2)).toEqual(['abcd', 'efg…']);
  });
});

describe('the empty state and the brain fact', () => {
  it('says the cortex is clear when no Todos are open', () => {
    expect(EMPTY_BOARD).toBe('No open Todos. Your cortex is clear.');
  });
  it('fires on a forced roll and names the live open count', () => {
    // The first draw decides whether it fires (under 1 in 50), the second which fact.
    const draws = [0, 0.99];
    const fact = rollBrainFact(() => draws.shift() ?? 0);
    expect(fact).toBe(BRAIN_FACTS.length - 1);
    expect(brainFactLine(fact, 14)).toBe(
      'Some nerve signals travel at about 120 meters per second. This board has 14 open Todos.'
    );
    expect(brainFactLine(0, 1)).toBe(
      'Your brain has about 86 billion neurons. This board has 1 open Todo.'
    );
  });
  it('stays quiet on most opens and on an empty board', () => {
    expect(rollBrainFact(() => 1 / 50)).toBeNull();
    expect(rollBrainFact(() => 0.5)).toBeNull();
    expect(brainFactLine(null, 14)).toBeNull();
    expect(brainFactLine(0, 0)).toBeNull();
  });
});
