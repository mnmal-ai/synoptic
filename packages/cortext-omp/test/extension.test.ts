import { describe, expect, it } from 'vitest';
import cortext, { type OmpApi, type OmpContext } from '../src/extension.js';

type Handler = (event: never, ctx: OmpContext) => Promise<unknown>;

function load(env: NodeJS.ProcessEnv, usage = 0) {
  let percent = usage;
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, h: Handler) => handlers.set(name, h) } as unknown as OmpApi;
  cortext(pi, env);
  const ctx: OmpContext = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => 's1' },
    getContextUsage: () => ({ percent })
  };
  const fire = (name: string, event: unknown) =>
    (handlers.get(name) as (e: unknown, c: OmpContext) => Promise<unknown>)(event, ctx);
  return {
    handlers,
    fire,
    setPercent: (p: number) => {
      percent = p;
    }
  };
}

describe('cortext OMP extension', () => {
  it('registers its seams', () => {
    expect([...load({}).handlers.keys()].sort()).toEqual([
      'before_agent_start',
      'session_before_compact',
      'session_stop'
    ]);
  });

  it('appends the cold-start after the base prompt, never replacing it', async () => {
    const { fire } = load({});
    const out = (await fire('before_agent_start', {
      reason: 'prompt',
      systemPrompt: ['base a', 'base b']
    })) as { systemPrompt: string[] };
    expect(out.systemPrompt.slice(0, 2)).toEqual(['base a', 'base b']);
    expect(out.systemPrompt[2]).toContain('SUBSTRATE_URL not set');
  });

  it('leaves a revived subagent alone', async () => {
    const { fire } = load({});
    expect(
      await fire('before_agent_start', { reason: 'revive', systemPrompt: [] })
    ).toBeUndefined();
  });

  it('never continues a stop that is already a continuation', async () => {
    const { fire } = load({});
    expect(await fire('session_stop', { stop_hook_active: true })).toBeUndefined();
  });

  it('does not nudge with no Substrate configured', async () => {
    const { fire } = load({});
    expect(await fire('session_stop', { stop_hook_active: false })).toBeUndefined();
  });

  it('asks for a checkpoint past the threshold, then again every 10 points', async () => {
    const low = load({}, 49);
    expect(await low.fire('session_stop', { stop_hook_active: false })).toBeUndefined();
    const high = load({}, 50);
    const out = (await high.fire('session_stop', { stop_hook_active: false })) as {
      additionalContext: string;
    };
    expect(out.additionalContext).toContain('```checkpoint');
    expect(await high.fire('session_stop', { stop_hook_active: false })).toBeUndefined();
    high.setPercent(59);
    expect(await high.fire('session_stop', { stop_hook_active: false })).toBeUndefined();
    high.setPercent(60);
    expect(await high.fire('session_stop', { stop_hook_active: false })).toBeDefined();
  });

  it('asks nothing with SYNOPTIC_OMP_COMPACT=off', async () => {
    const { fire } = load({ SYNOPTIC_OMP_COMPACT: 'off' }, 99);
    expect(await fire('session_stop', { stop_hook_active: false })).toBeUndefined();
  });

  it('leaves compaction to OMP when no checkpoint was stated', async () => {
    const { fire } = load({ SUBSTRATE_URL: 'http://127.0.0.1:9' });
    const event = {
      preparation: { firstKeptEntryId: 'e9', tokensBefore: 1000 },
      branchEntries: [{ type: 'message', message: { role: 'assistant', content: 'done' } }]
    };
    expect(await fire('session_before_compact', event)).toBeUndefined();
  });
});
