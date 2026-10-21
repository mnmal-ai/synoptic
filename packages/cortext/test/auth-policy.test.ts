/**
 * Unit contract for the auth-posture → policy mapping ("open initially,
 * retrofit-capable"). The posture knob maps onto existing
 * substrate policy combinators — autoCRUD type definitions are untouched, which
 * is the load-bearing property: any deployment can tighten posture later by
 * config alone, no schema or client changes.
 */

import type { Policy, PolicyDecision, RequestContext } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import { buildAuthPolicies, DEFAULT_AUTH, isMonotonicAuth } from '../src/auth-policy.js';

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    identity: null,
    namespace: 'claude',
    operation: 'mutate',
    now: new Date(),
    headers: {},
    meta: {},
    ...overrides
  };
}

/** Evaluate a policy list the way the engine composes them: all must allow. */
function evaluate(policies: readonly Policy[], c: RequestContext): PolicyDecision {
  for (const p of policies) {
    const d = p(c, {});
    if (!d.allow) return d;
  }
  return { allow: true };
}

// `grants` is required on Identity. These fixtures
// exercise cortext's verb posture, so the grant is a type requirement here.
const IDENT = { id: 'gate-test', agentKeyId: 'gate-test', grants: { '*': ['read', 'mutate'] } };
const SYSTEM = { kind: 'system', id: 'cortext:compact', grants: { '*': ['read', 'mutate'] } };

describe('buildAuthPolicies — default posture (deletes identity-gated)', () => {
  const policies = buildAuthPolicies(DEFAULT_AUTH);

  it('default posture is reads/writes open, deletes identity', () => {
    expect(DEFAULT_AUTH).toEqual({ reads: 'open', writes: 'open', deletes: 'identity' });
  });

  it('allows anonymous get/create/update', () => {
    for (const verb of ['get', 'create', 'update'] as const) {
      expect(evaluate(policies, ctx({ verb })).allow).toBe(true);
    }
  });

  it('allows anonymous verbless type queries', () => {
    expect(evaluate(policies, ctx({ operation: 'query', entry: 'Todo' })).allow).toBe(true);
  });

  it('denies anonymous delete with an actionable reason', () => {
    const d = evaluate(policies, ctx({ verb: 'delete' }));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('authenticated identity');
  });

  it('allows identified delete', () => {
    expect(evaluate(policies, ctx({ identity: IDENT, verb: 'delete' })).allow).toBe(true);
  });
});

describe('buildAuthPolicies — writes=identity', () => {
  const policies = buildAuthPolicies({ reads: 'open', writes: 'identity', deletes: 'identity' });

  it('denies anonymous create/update/delete', () => {
    for (const verb of ['create', 'update', 'delete'] as const) {
      const d = evaluate(policies, ctx({ verb }));
      expect(d.allow).toBe(false);
      expect(d.reason).toContain('authenticated identity');
    }
  });

  it('allows anonymous get and verbless type queries (reads stay open)', () => {
    expect(evaluate(policies, ctx({ verb: 'get' })).allow).toBe(true);
    expect(evaluate(policies, ctx({ operation: 'query', entry: 'Memory' })).allow).toBe(true);
  });

  it('allows identified create', () => {
    expect(evaluate(policies, ctx({ identity: IDENT, verb: 'create' })).allow).toBe(true);
  });

  it('allows the internal system envelope (compact) to write', () => {
    expect(evaluate(policies, ctx({ identity: SYSTEM, verb: 'update' })).allow).toBe(true);
  });
});

describe('buildAuthPolicies — reads=identity (full lockdown)', () => {
  const policies = buildAuthPolicies({
    reads: 'identity',
    writes: 'identity',
    deletes: 'identity'
  });

  it('denies anonymous verbless type queries', () => {
    const d = evaluate(policies, ctx({ operation: 'query', entry: 'Memory' }));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('authenticated identity');
  });

  it('denies anonymous get', () => {
    expect(evaluate(policies, ctx({ verb: 'get' })).allow).toBe(false);
  });

  it('allows identified queries and mutations', () => {
    expect(
      evaluate(policies, ctx({ identity: IDENT, operation: 'query', entry: 'Memory' })).allow
    ).toBe(true);
    expect(evaluate(policies, ctx({ identity: IDENT, verb: 'delete' })).allow).toBe(true);
  });
});

describe('buildAuthPolicies — fully open', () => {
  it('contributes no policies at all', () => {
    expect(buildAuthPolicies({ reads: 'open', writes: 'open', deletes: 'open' })).toEqual([]);
  });
});

describe('isMonotonicAuth', () => {
  it('accepts postures whose strictness is non-decreasing reads → writes → deletes', () => {
    expect(isMonotonicAuth({ reads: 'open', writes: 'open', deletes: 'open' })).toBe(true);
    expect(isMonotonicAuth({ reads: 'open', writes: 'open', deletes: 'identity' })).toBe(true);
    expect(isMonotonicAuth({ reads: 'open', writes: 'identity', deletes: 'identity' })).toBe(true);
    expect(isMonotonicAuth({ reads: 'identity', writes: 'identity', deletes: 'identity' })).toBe(
      true
    );
  });

  it('rejects gated reads over open writes, and gated writes over open deletes', () => {
    expect(isMonotonicAuth({ reads: 'identity', writes: 'open', deletes: 'identity' })).toBe(false);
    expect(isMonotonicAuth({ reads: 'identity', writes: 'identity', deletes: 'open' })).toBe(false);
    expect(isMonotonicAuth({ reads: 'open', writes: 'identity', deletes: 'open' })).toBe(false);
  });

  it('buildAuthPolicies throws on a non-monotonic posture (programmatic-caller guard)', () => {
    expect(() => buildAuthPolicies({ reads: 'identity', writes: 'open', deletes: 'open' })).toThrow(
      /monotonic/i
    );
  });
});
