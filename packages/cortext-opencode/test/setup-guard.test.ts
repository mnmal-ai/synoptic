// setup() must never throw into OpenCode, even if building the inbox push
// fails: the cold-start and inbox seams carry on without it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/inbox-bridge.js', () => ({
  createInboxBridge: () => {
    throw new Error('bridge construction failed');
  }
}));

import plugin from '../src/plugin.js';

type SessionHook = (event: {
  sessionID: string;
  system?: Array<{ type: string; text: string }>;
}) => Promise<void> | void;

let savedUrl: string | undefined;

beforeEach(() => {
  savedUrl = process.env.SUBSTRATE_URL;
  delete process.env.SUBSTRATE_URL;
});

afterEach(() => {
  if (savedUrl === undefined) delete process.env.SUBSTRATE_URL;
  else process.env.SUBSTRATE_URL = savedUrl;
});

describe('setup guard', () => {
  it('still registers the hooks and injects context when the bridge cannot be built', async () => {
    const hooks: Record<string, SessionHook> = {};
    const ctx = {
      location: { directory: '/tmp/cortext-opencode-test' },
      options: {},
      session: {
        hook: async (kind: string, cb: SessionHook) => {
          hooks[kind] = cb;
        },
        synthetic: async () => ({}),
        interrupt: async () => ({})
      },
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) }
    };
    const cleanup = (await plugin.setup(
      ctx as unknown as Parameters<typeof plugin.setup>[0]
    )) as () => void;
    const system: Array<{ type: string; text: string }> = [];
    await hooks.prompt?.({ sessionID: 's1' });
    await hooks.context?.({ sessionID: 's1', system });
    expect(system.some((p) => p.text.includes('SUBSTRATE_URL not set'))).toBe(true);
    cleanup();
  });
});
