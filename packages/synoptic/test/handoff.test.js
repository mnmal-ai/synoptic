import { describe, expect, it } from 'vitest';
import { handoffFrames, resumeQuery, watchFrame } from '../src/handoff.js';

describe('handoffFrames — leave a breadcrumb', () => {
  it('emits a createAnchorIntent frame scoped to the project', () => {
    const f = handoffFrames({ project: 'app', synopsis: 'on X; next: Y', body: 'detail' });
    const frame = f['cortext/createAnchorIntent'];
    expect(frame.params.synopsis).toBe('on X; next: Y');
    expect(frame.params.project).toBe('app');
    expect(frame.params.body).toBe('detail');
    expect(frame.params.archived).toBe(false);
  });

  it('omits body when not given, and never names the writer (attribution is server-side)', () => {
    const frame = handoffFrames({ project: 'p', synopsis: 's' })['cortext/createAnchorIntent'];
    expect('body' in frame.params).toBe(false);
    expect('authoredBy' in frame.params).toBe(false);
    expect('createdBy' in frame.params).toBe(false);
  });

  it('requires project and synopsis', () => {
    expect(() => handoffFrames({ synopsis: 's' })).toThrow(/project/);
    expect(() => handoffFrames({ project: 'p' })).toThrow(/synopsis/);
  });
});

describe('resumeQuery — pick up the latest breadcrumb (async handoff)', () => {
  it('queries the newest non-archived AnchorIntent for the project', () => {
    const q = resumeQuery('app')['cortext/AnchorIntent'];
    expect(q.params.where.project).toEqual({ eq: 'app' });
    expect(q.params.where.archived).toEqual({ eq: false });
    expect(q.params.orderBy).toEqual([{ createdAt: 'desc' }]);
    expect(q.params.limit).toBe(1);
    expect(q.fields.synopsis).toBe(true);
    expect(q.fields.body).toBe(true);
  });
});

describe('watchFrame — live handoff (subscribe; harness-neutral, for substrate-client watch())', () => {
  it('is a single-key subscribe frame on AnchorIntent scoped to the project', () => {
    const w = watchFrame('app');
    expect(Object.keys(w)).toEqual(['cortext/AnchorIntent']);
    expect(w['cortext/AnchorIntent'].params.where.project).toEqual({ eq: 'app' });
    expect(w['cortext/AnchorIntent'].fields.synopsis).toBe(true);
  });
});

describe('namespace parameterization (born-neutral cortext instance)', () => {
  it('handoffFrames emits the createAnchorIntent frame under a custom namespace', () => {
    const f = handoffFrames({ project: 'p', synopsis: 's', ns: 'cortext' });
    expect(Object.keys(f)).toEqual(['cortext/createAnchorIntent']);
  });

  it('resumeQuery queries the custom namespace', () => {
    expect(Object.keys(resumeQuery('p', 'cortext'))).toEqual(['cortext/AnchorIntent']);
  });

  it('watchFrame subscribes on the custom namespace', () => {
    expect(Object.keys(watchFrame('p', 'cortext'))).toEqual(['cortext/AnchorIntent']);
  });

  it('defaults to the cortext namespace when none is given', () => {
    expect(Object.keys(handoffFrames({ project: 'p', synopsis: 's' }))).toEqual([
      'cortext/createAnchorIntent'
    ]);
    expect(Object.keys(resumeQuery('p'))).toEqual(['cortext/AnchorIntent']);
    expect(Object.keys(watchFrame('p'))).toEqual(['cortext/AnchorIntent']);
  });
});
