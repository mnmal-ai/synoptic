// Behavioural tests for the OpenCode 2.x entrypoint (`setup` on the default
// export). Substrate is stubbed at the fetch boundary exactly like the V1 suite:
// every frame query answers `{ data: { <key>: [] } }`. What is asserted is
// SKIN behaviour — inject-once-per-session, prewarm, cache invalidation,
// never-throw — against the V2 hook surface (`prompt` / `context` /
// `compaction`, `event.system` as `SystemPart[]`).

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../src/plugin.js';

const DIRECTORY = '/tmp/cortext-opencode-test';

type SystemPart = { type: string; text: string };
type HookEvent = { sessionID: string; system?: SystemPart[] };
type SessionHook = (event: HookEvent) => Promise<void> | void;

function fakeCtx(options?: Record<string, unknown>): {
  ctx: {
    location: { directory: string };
    session: { hook: (kind: string, cb: SessionHook) => Promise<void> };
    options: Record<string, unknown>;
  };
  hooks: Record<string, SessionHook>;
} {
  const hooks: Record<string, SessionHook> = {};
  const ctx = {
    location: { directory: DIRECTORY },
    session: {
      hook: async (kind: string, cb: SessionHook) => {
        hooks[kind] = cb;
      }
    },
    options: options ?? {}
  };
  return { ctx, hooks };
}

async function setup(options?: Record<string, unknown>): Promise<Record<string, SessionHook>> {
  const { ctx, hooks } = fakeCtx(options);
  await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0]);
  return hooks;
}

/** Stub fetch: every frame key in the request body answers `[]`. */
function stubFetch(calls: string[], authHeaders?: string[]): void {
  vi.stubGlobal('fetch', (async (
    url: unknown,
    init?: { body?: unknown; headers?: Record<string, string> }
  ) => {
    calls.push(String(url));
    if (authHeaders !== undefined) authHeaders.push(init?.headers?.authorization ?? '');
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

/** Ed25519 PEM in a tmpdir — the key half of an options-path identity. */
function makeKeyFile(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'cortext-opencode-auth-'));
  const keyPath = join(dir, 'agent.key');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return keyPath;
}

/** Decode a `Bearer <jwt>` string's header (kid lives there). */
function jwtHeader(bearer: string): Record<string, unknown> {
  const [h] = bearer.replace(/^Bearer /, '').split('.');
  const fromB64url = (x: string) => Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return JSON.parse(fromB64url(h ?? '').toString('utf8'));
}

const ENV_KEYS = [
  'SUBSTRATE_URL',
  'SUBSTRATE_NAMESPACE',
  'SYNOPTIC_PROJECT_SCOPE',
  'SUBSTRATE_AGENT_KEY_ID',
  'SUBSTRATE_AGENT_KEY_PATH',
  'SYNOPTIC_COLD_START_MAX_BYTES',
  'SYNOPTIC_INBOX_PUSH'
];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.SUBSTRATE_URL = 'https://substrate.test:3100';
  process.env.SUBSTRATE_NAMESPACE = 'cortext';
  delete process.env.SYNOPTIC_PROJECT_SCOPE;
  // Agent identity starts unset so every suite is deterministic regardless
  // of the ambient shell; identity tests set their own pair explicitly.
  delete process.env.SUBSTRATE_AGENT_KEY_ID;
  delete process.env.SUBSTRATE_AGENT_KEY_PATH;
  // The cold-start alone: a running watcher would add its own signed
  // requests to what the identity tests read. It has its own suite.
  process.env.SYNOPTIC_INBOX_PUSH = 'off';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

describe('V2 default export shape', () => {
  it('exposes id + setup for V2 and server for V1', async () => {
    const mod = await import('../src/plugin.js');
    expect(mod.default.id).toBe('cortext');
    expect(typeof mod.default.setup).toBe('function');
    expect(typeof mod.default.server).toBe('function');
  });

  it('registers prompt, context and compaction hooks', async () => {
    const hooks = await setup();
    expect(typeof hooks.prompt).toBe('function');
    expect(typeof hooks.context).toBe('function');
    expect(typeof hooks.compaction).toBe('function');
  });
});

describe('context cold-start injection (V2)', () => {
  it('injects exactly one SystemPart on first dispatch', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const hooks = await setup();
    const event = { sessionID: 's1', system: [] as Array<{ type: string; text: string }> };
    await hooks.context?.(event);
    expect(event.system).toHaveLength(2); // cold-start + conventions
    expect(event.system?.[0]?.type).toBe('text');
    expect(event.system?.[0]?.text.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('serves repeat dispatches in the same session from cache', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const hooks = await setup();
    const first = { sessionID: 's1', system: [] as SystemPart[] };
    await hooks.context?.(first);
    const afterFirst = calls.length;
    const second = { sessionID: 's1', system: [] as SystemPart[] };
    await hooks.context?.(second);
    expect(second.system).toEqual(first.system);
    expect(calls.length).toBe(afterFirst);
  });

  it('renders a fresh cold-start for a new session', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const hooks = await setup();
    await hooks.context?.({ sessionID: 's1', system: [] });
    const afterFirst = calls.length;
    await hooks.context?.({ sessionID: 's2', system: [] });
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it('injects the packaged conventions as their own part, outside the byte cap', async () => {
    stubFetch([]);
    process.env.SYNOPTIC_COLD_START_MAX_BYTES = '400';
    const hooks = await setup();
    const event = { sessionID: 's1', system: [] as SystemPart[] };
    await hooks.context?.(event);
    const last = event.system?.at(-1)?.text ?? '';
    expect(last).toContain('# Substrate interaction conventions');
    expect(Buffer.byteLength(last)).toBeGreaterThan(400);
  });

  it('plugin options can carry the URL a GUI launch has no env for', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    delete process.env.SUBSTRATE_URL;
    const hooks = await setup({ url: 'https://options.test:3100' });
    await hooks.context?.({ sessionID: 's1', system: [] as SystemPart[] });
    expect(calls.some((u) => u.startsWith('https://options.test:3100'))).toBe(true);
  });

  it('honours SYNOPTIC_COLD_START_MAX_BYTES, like the other skins', async () => {
    stubFetch([]);
    process.env.SYNOPTIC_COLD_START_MAX_BYTES = '400';
    const hooks = await setup();
    const event = { sessionID: 's1', system: [] as SystemPart[] };
    await hooks.context?.(event);
    expect(Buffer.byteLength(event.system?.[0]?.text ?? '')).toBeLessThanOrEqual(400);
  });

  it('degrades to a note — never throws — when Substrate is unreachable', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new Error('connect refused');
    }) as typeof fetch);
    const hooks = await setup();
    const event = { sessionID: 's1', system: [] as SystemPart[] };
    await expect(hooks.context?.(event)).resolves.toBeUndefined();
    expect(event.system).toHaveLength(2); // cold-start + conventions
  });
});

describe('session lifecycle hooks (V2)', () => {
  it('prewarms on prompt so context is served from cache', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const hooks = await setup();
    await hooks.prompt?.({ sessionID: 's9' });
    // Prewarm is fire-and-forget: wait for the render to land.
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const event = { sessionID: 's9', system: [] as SystemPart[] };
    await hooks.context?.(event);
    expect(event.system).toHaveLength(2); // cold-start + conventions
  });

  it('compaction drops the cache and leaves a pointer for the summary', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const hooks = await setup();
    await hooks.context?.({ sessionID: 's1', system: [] });
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    const compactEvent = { sessionID: 's1', system: [] as Array<{ type: string; text: string }> };
    await hooks.compaction?.(compactEvent);
    expect(compactEvent.system).toHaveLength(1);
    await hooks.context?.({ sessionID: 's1', system: [] });
    expect(calls.length).toBeGreaterThan(afterFirst);
  });
});

// ---- identity via plugin options ----
//
// V2 delivers per-project identity through the object plugin entry
// `{ package, options: { kid, key } }` in opencode.json(c), surfaced to
// setup as `ctx.options`. Tri-state: options beat env, options alone mint
// with no env pair, partial stays anonymous + VISIBLE warning.

describe('identity from plugin options (V2 ctx.options)', () => {
  it('ctx.options kid/key mint a signed cold-start — options beat env', async () => {
    const keyPath = makeKeyFile();
    process.env.SUBSTRATE_AGENT_KEY_ID = 'envkid@host';
    process.env.SUBSTRATE_AGENT_KEY_PATH = keyPath;
    const calls: string[] = [];
    const authHeaders: string[] = [];
    stubFetch(calls, authHeaders);
    const hooks = await setup({ kid: 'optionskid@host', key: keyPath });
    await hooks.context?.({ sessionID: 's1', system: [] as SystemPart[] });
    expect(calls.length).toBeGreaterThan(0);
    expect(authHeaders[0]).toMatch(/^Bearer /);
    expect(jwtHeader(authHeaders[0] ?? '').kid).toBe('optionskid@host');
  });

  it('options alone sign with no env pair set', async () => {
    const keyPath = makeKeyFile();
    const calls: string[] = [];
    const authHeaders: string[] = [];
    stubFetch(calls, authHeaders);
    const hooks = await setup({ kid: 'optionskid@host', key: keyPath });
    await hooks.context?.({ sessionID: 's1', system: [] as SystemPart[] });
    expect(calls.length).toBeGreaterThan(0);
    expect(authHeaders[0]).toMatch(/^Bearer /);
    expect(jwtHeader(authHeaders[0] ?? '').kid).toBe('optionskid@host');
  });

  it('partial options (kid, no key) → visible warning in the doc, anonymous reads', async () => {
    const calls: string[] = [];
    const authHeaders: string[] = [];
    stubFetch(calls, authHeaders);
    const hooks = await setup({ kid: 'kid-only' });
    const event = { sessionID: 's1', system: [] as SystemPart[] };
    await hooks.context?.(event);
    expect(event.system?.[0]?.text).toContain('agent identity misconfigured');
    expect(authHeaders.every((h) => h === '')).toBe(true);
  });

  it('no options, no env pair → anonymous reads, no warning (open mode)', async () => {
    const calls: string[] = [];
    const authHeaders: string[] = [];
    stubFetch(calls, authHeaders);
    const hooks = await setup();
    const event = { sessionID: 's1', system: [] as SystemPart[] };
    await hooks.context?.(event);
    expect(calls.length).toBeGreaterThan(0);
    expect(authHeaders.every((h) => h === '')).toBe(true);
    expect(event.system?.[0]?.text).not.toContain('misconfigured');
  });
});
