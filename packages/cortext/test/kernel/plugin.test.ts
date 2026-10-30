/**
 * Smoke tests for the cortext-kernel plugin shape. Pure-logic
 * coverage; the migrations themselves are exercised end-to-end by
 * apps/substrate integration tests.
 */

import { describe, expect, it } from 'vitest';
import { createCortextKernelPlugin } from '../../src/kernel/plugin.js';
import { SUBSTRATE_CONTRACT_RANGE } from '../../src/kernel/substrate-contract.js';

describe('createCortextKernelPlugin', () => {
  it('returns a kernel plugin with the expected name + contract version', () => {
    const plugin = createCortextKernelPlugin();
    expect(plugin.name).toBe('cortext-kernel');
    // A range over the BINARY version, checked by the loader; the exact value
    // and its parity with peerDependencies live
    // in the cortext package's substrate-contract-parity.test.ts.
    expect(plugin.contractVersion).toBe(SUBSTRATE_CONTRACT_RANGE);
  });

  it('declares the baseline then the engine-owned index drop, each with a rollback', () => {
    const migrations = createCortextKernelPlugin().migrations ?? [];
    expect(migrations.map((m) => m.id)).toEqual([
      '0001_baseline',
      '0002_drop_engine_owned_indexes'
    ]);
    for (const m of migrations) expect(m.rollback).toBeTypeOf('function');
  });

  it('contributes migrations and the boot audit — no filter operators, routes, or MCP tools', () => {
    // The hook receives a sql handle, and the audit is what it is for. See
    // ../src/kernel/invariant-audit.ts.
    const plugin = createCortextKernelPlugin();
    expect(plugin.filterOperators).toBeUndefined();
    expect(plugin.kernelRoutes).toBeUndefined();
    expect(plugin.mcpTools).toBeUndefined();
    expect(plugin.onKernelReady).toBeTypeOf('function');
  });
});
