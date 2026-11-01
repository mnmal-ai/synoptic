import { describe, expect, it } from 'vitest';
import { runColdStart } from '../src/cold-start.js';
import { loadActiveTasks, renderTasks, TASK_LIMIT } from '../src/tasks.js';

const URL_BASE = 'https://h:3100';

// Answers each /query by its single frame key; `checkpoints` is keyed by task id.
function store({ tasks = [], checkpoints = {}, rejectTask = false } = {}) {
  const asked = [];
  const fetchImpl = (url, init) => {
    if (!url.endsWith('/substrate/v1/query')) throw new Error(`unexpected ${url}`);
    const payload = JSON.parse(init.body);
    asked.push(payload);
    const data = {};
    for (const [key, frame] of Object.entries(payload)) {
      if (key.endsWith('/Task')) {
        if (!rejectTask) data[key] = tasks;
      } else if (key.endsWith('/ExecutionCheckpoint')) {
        const cp = checkpoints[frame.params.where.task.eq];
        data[key] = cp ? [cp] : [];
      } else {
        data[key] = [];
      }
    }
    const errors = rejectTask ? [{ code: 'unknown_type', message: 'no Task' }] : undefined;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data, errors })
    });
  };
  return { fetchImpl, asked };
}

const task = (n) => ({ id: `0000000${n}-uuid`, shortId: 40 + n, title: `task ${n}` });

describe('loadActiveTasks', () => {
  it('reads active, live tasks of this project only, with each latest checkpoint', async () => {
    const { fetchImpl, asked } = store({
      tasks: [task(1), task(2)],
      checkpoints: { '00000001-uuid': { revision: 3, nextAction: 'run the probe', blockers: null } }
    });
    const out = await loadActiveTasks({
      substrateUrl: URL_BASE,
      namespace: 'cortext',
      projectSlug: 'demo',
      fetchImpl
    });
    expect(asked[0]['cortext/Task'].params.where).toEqual({
      project: { eq: 'demo' },
      status: { eq: 'active' },
      archived: { eq: false }
    });
    const cpReads = asked.slice(1).map((p) => p['cortext/ExecutionCheckpoint'].params);
    expect(cpReads).toContainEqual({
      where: { task: { eq: '00000001-uuid' } },
      orderBy: [{ revision: 'desc' }],
      limit: 1
    });
    expect(out).toEqual([
      { task: task(1), checkpoint: { revision: 3, nextAction: 'run the probe', blockers: null } },
      { task: task(2), checkpoint: null }
    ]);
  });

  it('returns null without a project, and when the server has no Task type', async () => {
    const opts = { substrateUrl: URL_BASE, namespace: 'cortext' };
    expect(
      await loadActiveTasks({ ...opts, projectSlug: null, fetchImpl: store().fetchImpl })
    ).toBe(null);
    const { fetchImpl } = store({ rejectTask: true });
    expect(await loadActiveTasks({ ...opts, projectSlug: 'demo', fetchImpl })).toBe(null);
  });
});

describe('renderTasks', () => {
  it('renders nothing for no tasks', () => {
    expect(renderTasks([])).toBe('');
    expect(renderTasks(null)).toBe('');
  });

  it('renders one line per task with its latest step and the write instruction', () => {
    const out = renderTasks(
      [
        {
          task: task(1),
          checkpoint: { revision: 2, nextAction: 'check\nquantisation', blockers: 'needs GPU' }
        },
        { task: task(2), checkpoint: null }
      ],
      { ns: 'cortext' }
    );
    expect(out.split('\n')).toEqual([
      expect.stringMatching(/^Active tasks: 2 — .*`cortext\/createExecutionCheckpoint /),
      '- #41 task 1 (`00000001-uuid`) — rev 2, next: check quantisation; blocked: needs GPU',
      '- #42 task 2 (`00000002-uuid`) — no checkpoint yet'
    ]);
  });

  it('bounds long text and marks a full page as a lower bound', () => {
    const many = Array.from({ length: TASK_LIMIT }, (_, i) => ({
      task: { ...task(i), title: 'x'.repeat(500) },
      checkpoint: null
    }));
    const out = renderTasks(many);
    expect(out).toMatch(/^Active tasks: 10\+/);
    expect(out.split('\n')[1]).toContain(`${'x'.repeat(199)}…`);
    expect(out.split('\n')[1]).not.toContain('x'.repeat(200));
  });
});

describe('runColdStart — active tasks', () => {
  const base = { substrateUrl: URL_BASE, namespace: 'cortext', projectSlug: 'demo' };

  it('renders the block after the session line only when asked', async () => {
    const { fetchImpl } = store({ tasks: [task(1)] });
    const on = await runColdStart({ ...base, sessionId: '125f8d22-0044', fetchImpl, tasks: true });
    expect(on).toContain('- #41 task 1');
    expect(on.indexOf('Session `125f8d22`')).toBeLessThan(on.indexOf('Active tasks:'));

    const off = await runColdStart({ ...base, fetchImpl: store({ tasks: [task(1)] }).fetchImpl });
    expect(off).not.toContain('Active tasks:');
  });

  it('degrades to a comment when the task read fails, and the rules still render', async () => {
    const inner = store({}).fetchImpl;
    const fetchImpl = (url, init) =>
      init.body.includes('/Task"') ? Promise.reject(new Error('boom')) : inner(url, init);
    const out = await runColdStart({ ...base, fetchImpl, tasks: true });
    expect(out).toContain('<!-- tasks unavailable: boom -->');
    expect(out).not.toContain('substrate offline');
  });
});
