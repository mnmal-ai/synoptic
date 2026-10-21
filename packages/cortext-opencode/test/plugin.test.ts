// Behavioural tests for the OpenCode skin. Substrate is stubbed at the fetch
// boundary: every frame query answers `{ data: { <key>: [] } }`, so the
// render runs the full pipeline (concepts → memory → rules → inbox) against
// empty rows. What is asserted is SKIN behaviour — inject-once-per-session,
// prewarm, cache invalidation, never-throw — not host rendering (the host
// suite owns that).

import type { PluginInput } from '@opencode-ai/plugin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CortextPlugin } from '../src/plugin.js';

const DIRECTORY = '/tmp/cortext-opencode-test';

function input(): PluginInput {
  return { directory: DIRECTORY } as unknown as PluginInput;
}

type Hooks = Awaited<ReturnType<typeof CortextPlugin>>;

async function hooks(): Promise<Hooks> {
  return CortextPlugin(await input());
}

/** Stub fetch: every frame key in the request body answers `[]`. */
function stubFetch(calls: string[]): void {
  vi.stubGlobal('fetch', (async (url: unknown, init?: { body?: unknown }) => {
    calls.push(String(url));
    const data: Record<string, unknown> = {};
    try {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      for (const k of Object.keys(body)) data[k] = [];
    } catch {
      // Non-frame request (e.g. a GET): empty data degrades cleanly.
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  }) as typeof fetch);
}

const ENV_KEYS = ['SUBSTRATE_URL', 'SUBSTRATE_NAMESPACE', 'SYNOPTIC_PROJECT_SCOPE'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.SUBSTRATE_URL = 'https://substrate.test:3100';
  process.env.SUBSTRATE_NAMESPACE = 'cortext';
  delete process.env.SYNOPTIC_PROJECT_SCOPE;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

describe('CortextPlugin shape', () => {
  it('is a plugin function with a dual V1+V2 default export', async () => {
    const mod = await import('../src/plugin.js');
    expect(typeof mod.CortextPlugin).toBe('function');
    // Dual entrypoint: V2 calls setup(), V1 (>=1.18.29) calls server().
    expect(mod.default.id).toBe('cortext');
    expect(typeof mod.default.setup).toBe('function');
    expect(mod.default.server).toBe(mod.CortextPlugin);
    const h = await hooks();
    expect(typeof h.event).toBe('function');
    expect(typeof h['chat.message']).toBe('function');
    expect(typeof h['experimental.chat.system.transform']).toBe('function');
    expect(typeof h['experimental.session.compacting']).toBe('function');
  });
});

describe('system.transform cold-start injection', () => {
  it('injects exactly one context block on first dispatch', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const h = await hooks();
    const output = { system: [] as string[] };
    await h['experimental.chat.system.transform']?.(
      { sessionID: 's1', model: {} as never },
      output
    );
    expect(output.system).toHaveLength(2); // cold-start + conventions
    expect(output.system[0]?.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('serves repeat dispatches in the same session from cache', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const h = await hooks();
    const first = { system: [] as string[] };
    await h['experimental.chat.system.transform']?.({ sessionID: 's1', model: {} as never }, first);
    const afterFirst = calls.length;
    const second = { system: [] as string[] };
    await h['experimental.chat.system.transform']?.(
      { sessionID: 's1', model: {} as never },
      second
    );
    expect(second.system).toEqual(first.system);
    expect(calls.length).toBe(afterFirst);
  });

  it('renders a fresh cold-start for a new session', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const h = await hooks();
    await h['experimental.chat.system.transform']?.(
      { sessionID: 's1', model: {} as never },
      { system: [] }
    );
    const afterFirst = calls.length;
    await h['experimental.chat.system.transform']?.(
      { sessionID: 's2', model: {} as never },
      { system: [] }
    );
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it('degrades to a note — never throws — when Substrate is unreachable', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new Error('connect refused');
    }) as typeof fetch);
    const h = await hooks();
    const output = { system: [] as string[] };
    await expect(
      h['experimental.chat.system.transform']?.({ sessionID: 's1', model: {} as never }, output)
    ).resolves.toBeUndefined();
    expect(output.system).toHaveLength(2); // cold-start + conventions
  });
});

describe('session lifecycle hooks', () => {
  it('prewarms on session.created so first dispatch is served from cache', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const h = await hooks();
    await h.event?.({
      event: {
        type: 'session.created',
        properties: { info: { id: 's9', directory: DIRECTORY } }
      } as never
    });
    // Prewarm is fire-and-forget: wait for the render to land.
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const output = { system: [] as string[] };
    await h['experimental.chat.system.transform']?.(
      { sessionID: 's9', model: {} as never },
      output
    );
    expect(output.system).toHaveLength(2); // cold-start + conventions
  });

  it('ignores unrelated bus events', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const h = await hooks();
    await h.event?.({ event: { type: 'session.idle', properties: {} } as never });
    expect(calls).toHaveLength(0);
  });

  it('compacting drops the cache and leaves a pointer for the summary', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const h = await hooks();
    await h['experimental.chat.system.transform']?.(
      { sessionID: 's1', model: {} as never },
      { system: [] }
    );
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    const output = { context: [] as string[] };
    await h['experimental.session.compacting']?.({ sessionID: 's1' }, output);
    expect(output.context).toHaveLength(1);
    await h['experimental.chat.system.transform']?.(
      { sessionID: 's1', model: {} as never },
      { system: [] }
    );
    expect(calls.length).toBeGreaterThan(afterFirst);
  });
});
