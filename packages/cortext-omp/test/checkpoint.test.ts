import { describe, expect, it } from 'vitest';
import {
  type Checkpoint,
  findCheckpoint,
  keepFrom,
  parseCheckpoint,
  renderPointer,
  saveCheckpoint
} from '../src/checkpoint.js';

const block = (o: unknown) => `text\n\`\`\`checkpoint\n${JSON.stringify(o)}\n\`\`\`\n`;
const cp: Checkpoint = {
  task: 'T',
  completed: 'a',
  nextAction: 'b',
  blockers: null,
  refs: ['f.ts']
};

describe('parseCheckpoint', () => {
  it('takes the last valid block and skips near misses', () => {
    const text =
      block({ completed: 'one', nextAction: 'x' }) +
      '```checkpoint\n{not json}\n```' +
      block({ completed: 'two', nextAction: 'y', refs: ['a', 3, ''] });
    expect(parseCheckpoint(text)).toEqual({
      task: null,
      completed: 'two',
      nextAction: 'y',
      blockers: null,
      refs: ['a']
    });
  });

  it('refuses a block without completed and nextAction', () => {
    expect(parseCheckpoint(block({ completed: 'a' }))).toBeNull();
    expect(parseCheckpoint('no block')).toBeNull();
  });
});

describe('findCheckpoint', () => {
  const said = (text: unknown) => ({
    type: 'message',
    message: { role: 'assistant', content: text }
  });
  it('reads assistant text parts, newest first', () => {
    const entries = [
      said(block({ completed: 'old', nextAction: 'x' })),
      said([{ type: 'text', text: block({ completed: 'new', nextAction: 'y' }) }])
    ];
    expect(findCheckpoint(entries)).toMatchObject({ cp: { completed: 'new' }, at: 1 });
  });

  it('stops at the last compaction and ignores user text', () => {
    expect(
      findCheckpoint([
        said(block({ completed: 'before', nextAction: 'x' })),
        { type: 'compaction' },
        {
          type: 'message',
          message: { role: 'user', content: block({ completed: 'u', nextAction: 'x' }) }
        }
      ])
    ).toBeNull();
  });
});

/** A fake Substrate answering by frame key. */
function server(answer: (key: string, params: Record<string, unknown>) => object) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const [key, frame] = Object.entries(JSON.parse(init.body))[0] as [
      string,
      { params: Record<string, unknown> }
    ];
    calls.push(key);
    return new Response(JSON.stringify(answer(key, frame.params)));
  }) as unknown as typeof fetch;
  return {
    calls,
    access: { substrateUrl: 'http://s', namespace: 'cortext', project: 'p', fetchImpl }
  };
}

describe('keepFrom', () => {
  const e = ['a', 'b', 'c', 'd'].map((id) => ({ type: 'message', id }));
  it("keeps OMP's cut when the block is inside the kept tail", () => {
    expect(keepFrom(e, 2, 'b')).toBe('b');
  });
  it('keeps everything after a block older than the cut', () => {
    expect(keepFrom(e, 1, 'd')).toBe('c');
  });
});

describe('saveCheckpoint', () => {
  it('creates the Task, then writes revision one above the latest', async () => {
    const s = server((key, params) => {
      if (key === 'cortext/createTask')
        return { data: { [key]: { id: 'u1', shortId: 7, title: params.title } } };
      if (key === 'cortext/ExecutionCheckpoint') return { data: { [key]: [{ revision: 2 }] } };
      return { data: { [key]: { id: 'c1' } } };
    });
    expect(await saveCheckpoint(s.access, null, cp, 'fallback')).toEqual({
      task: { id: 'u1', shortId: 7, title: 'T' },
      revision: 3
    });
  });

  it('re-reads once on unique_violation, and is null on any other refusal', async () => {
    let latest = 0;
    let refuse = 'unique_violation';
    const s = server((key) => {
      if (key === 'cortext/ExecutionCheckpoint')
        return { data: { [key]: [{ revision: latest++ }] } };
      if (refuse === 'unique_violation' && latest === 1)
        return { data: {}, errors: [{ code: refuse, message: 'dup', path: [key] }] };
      if (refuse === 'forbidden')
        return { data: {}, errors: [{ code: refuse, message: 'no', path: [key] }] };
      return { data: { [key]: { id: 'c' } } };
    });
    const task = { id: 'u1', shortId: 7, title: 'T' };
    expect((await saveCheckpoint(s.access, task, cp, 'f'))?.revision).toBe(2);
    refuse = 'forbidden';
    expect(await saveCheckpoint(s.access, task, cp, 'f')).toBeNull();
  });
});

describe('renderPointer', () => {
  it('names the task, the revision and the next write', () => {
    const out = renderPointer('cortext', { id: 'u1', shortId: 7, title: 'T' }, 3, cp);
    expect(out).toContain('Task #7 "T" (`u1`), checkpoint revision 3.');
    expect(out).toContain('revision: 4');
    expect(out).toContain('Refs: f.ts');
  });
});
