import { describe, expect, it } from 'vitest';
import { autoRecallContext } from '../src/auto-recall.js';

const ENV = { SUBSTRATE_URL: 'https://h:3100', SYNOPTIC_RECALL_AUTO: 'on' };
const PROMPT = 'which port is the test database on?';
const hit = (n, score) => ({
  score,
  row: { id: `id-${n}`, shortId: n, name: `memory ${n}`, description: `about\n thing ${n}` }
});

function store(hits) {
  const calls = [];
  const fetchImpl = (_url, init) => {
    calls.push(JSON.parse(init.body)['recall/Hit']);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: hits === null ? {} : { 'recall/Hit': hits } })
    });
  };
  return { fetchImpl, calls };
}

describe('autoRecallContext', () => {
  it('is off unless SYNOPTIC_RECALL_AUTO=on, and makes no request', async () => {
    const { fetchImpl, calls } = store([hit(1, 0.9)]);
    const out = await autoRecallContext({
      env: { SUBSTRATE_URL: 'https://h:3100' },
      prompt: PROMPT,
      project: 'repo',
      fetchImpl
    });
    expect(out).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('searches Memory in the project scope without boosting, and renders handles on one line each', async () => {
    const { fetchImpl, calls } = store([hit(1, 0.9), hit(2, 0.8)]);
    const out = await autoRecallContext({ env: ENV, prompt: PROMPT, project: 'repo', fetchImpl });
    expect(calls[0].params).toMatchObject({
      to: PROMPT,
      namespace: 'cortext',
      type: 'Memory',
      boost: false,
      where: { project: { in: ['repo', null] } }
    });
    expect(out).toContain('not from the user');
    expect(out).toContain('#1 memory 1: about thing 1\n#2 memory 2: about thing 2\n');
  });

  it('caps the hits, applies the score floor, and never repeats a row in a session', async () => {
    const seen = new Set();
    const hits = [hit(1, 0.9), hit(2, 0.8), hit(3, 0.7), hit(4, 0.2)];
    const env = { ...ENV, SYNOPTIC_RECALL_MAX: '2', SYNOPTIC_RECALL_MIN_SCORE: '0.5' };
    const first = await autoRecallContext({
      env,
      prompt: PROMPT,
      project: 'r',
      seen,
      ...store(hits)
    });
    expect(first).toContain('#1 ');
    expect(first).toContain('#2 ');
    expect(first).not.toContain('#3 ');
    const second = await autoRecallContext({
      env,
      prompt: PROMPT,
      project: 'r',
      seen,
      ...store(hits)
    });
    expect(second).toContain('#3 ');
    expect(second).not.toContain('#1 ');
    expect(second).not.toContain('#4 ');
    expect(
      await autoRecallContext({ env, prompt: PROMPT, project: 'r', seen, ...store(hits) })
    ).toBe('');
  });

  it('adds nothing for a short prompt, a refused search, or a failing store', async () => {
    const ok = store([hit(1, 0.9)]);
    expect(await autoRecallContext({ env: ENV, prompt: 'yes', project: 'r', ...ok })).toBe('');
    expect(ok.calls).toHaveLength(0);
    expect(
      await autoRecallContext({ env: ENV, prompt: PROMPT, project: 'r', ...store(null) })
    ).toBe('');
    const fetchImpl = () => Promise.reject(new Error('down'));
    expect(await autoRecallContext({ env: ENV, prompt: PROMPT, project: 'r', fetchImpl })).toBe('');
  });
});
