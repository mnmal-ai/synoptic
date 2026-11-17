import { describe, expect, it } from 'vitest';
import cortext, { type OmpApi, type OmpContext } from '../src/extension.js';

type Handler = (event: never, ctx: OmpContext) => Promise<unknown>;

function load(env: NodeJS.ProcessEnv) {
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, h: Handler) => handlers.set(name, h) } as unknown as OmpApi;
  cortext(pi, env);
  const ctx: OmpContext = { cwd: process.cwd(), sessionManager: { getSessionId: () => 's1' } };
  const fire = (name: string, event: unknown) =>
    (handlers.get(name) as (e: unknown, c: OmpContext) => Promise<unknown>)(event, ctx);
  return { handlers, fire };
}

describe('cortext OMP extension', () => {
  it('registers the two seams', () => {
    expect([...load({}).handlers.keys()].sort()).toEqual(['before_agent_start', 'session_stop']);
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
});
