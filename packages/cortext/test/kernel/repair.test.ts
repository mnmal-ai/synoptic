/**
 * Unit coverage for the opt-in repair gate.
 *
 * The DDL half lives in `repair.pg.test.ts`. This file covers the decisions
 * made BEFORE any SQL runs, which are the ones that keep repair from touching
 * a schema it should not: the env gate, and the refusal to guess a target.
 */

import { describe, expect, it, vi } from 'vitest';
import { CORTEXT_NAMESPACE } from '../../src/kernel/cortext-namespace.js';
import { REPAIR_ENV_VAR, repairIfRequested, repairRequested } from '../../src/kernel/repair.js';

describe('the env gate', () => {
  it('is off when unset — repair is opt-in, so absence must mean no', () => {
    expect(repairRequested({})).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' true '])('accepts %o', (value) => {
    expect(repairRequested({ [REPAIR_ENV_VAR]: value })).toBe(true);
  });

  it.each(['0', 'false', 'no', 'off', ''])('rejects %o', (value) => {
    // The important half. A bare presence check would read
    // `SYNOPTIC_CORTEXT_REPAIR=false` as a yes and re-scope a production
    // schema on the strength of an operator explicitly saying not to.
    expect(repairRequested({ [REPAIR_ENV_VAR]: value })).toBe(false);
  });
});

describe('repairIfRequested', () => {
  const on = { [REPAIR_ENV_VAR]: '1' };

  it('returns null when not asked, without touching sql', async () => {
    const sql = vi.fn();
    const result = await repairIfRequested(
      { sql, namespace: CORTEXT_NAMESPACE, env: {}, metric: vi.fn() },
      vi.fn()
    );
    expect(result).toBeNull();
    expect(sql).not.toHaveBeenCalled();
  });

  it('DECLINES rather than guessing when the target is unknown', async () => {
    // The load-bearing refusal. `namespace: null` means the host predates
    // coordinatorNamespacesByPlugin, or cortext is not loaded. Defaulting to
    // CORTEXT_NAMESPACE here would either be a no-op (if nothing drifted, so
    // repair was not needed) or re-scope a production schema to the wrong
    // target — which is the failure this whole lineage exists to remove.
    const sql = vi.fn();
    const metric = vi.fn();
    const warn = vi.fn();
    const result = await repairIfRequested({ sql, namespace: null, env: on, metric }, warn);

    expect(result).toBeNull();
    expect(sql).not.toHaveBeenCalled();
    expect(metric).toHaveBeenCalledWith(
      'cortext_kernel.repair_declined',
      expect.objectContaining({ reason: 'target_unknown' })
    );
    expect(warn.mock.calls[0]?.[0]).toContain('will not guess');
  });

  it('does nothing on the in-memory dataset', async () => {
    const metric = vi.fn();
    const result = await repairIfRequested(
      { sql: null, namespace: CORTEXT_NAMESPACE, env: on, metric },
      vi.fn()
    );
    expect(result).toBeNull();
  });

  it('reports a failure instead of throwing it into the boot', async () => {
    // Repair runs during onKernelReady. An operator who set an env var for
    // one maintenance restart must not be able to brick the service with it.
    const metric = vi.fn();
    const warn = vi.fn();
    // Shaped like the postgres.js tag the rescope helpers actually call —
    // `s.unsafe(...)` — rather than a bare function. A looser double passed for
    // the wrong reason: it failed at "is not a function" instead of at the
    // error under test, so the assertion never exercised the path it names.
    const sql = { unsafe: () => Promise.reject(new Error('deadlock detected')) };
    await expect(
      repairIfRequested({ sql, namespace: 'codex', env: on, metric }, warn)
    ).resolves.toBeNull();
    expect(metric).toHaveBeenCalledWith(
      'cortext_kernel.repair_failed',
      expect.objectContaining({ error: 'deadlock detected' })
    );
    expect(warn.mock.calls.at(-1)?.[0]).toContain('may have been re-scoped');
  });

  it('warns that leaving the var set makes repair automatic', async () => {
    // The whole distinction between opt-in and automatic is that the operator
    // takes it back off again, so the run has to say so.
    const warn = vi.fn();
    // Returns [] for the violation/duplicate COUNT queries, which the helpers
    // read defensively (`?.count ?? 0`), so the whole run completes cleanly.
    const sql = { unsafe: () => Promise.resolve([]) };
    await repairIfRequested({ sql, namespace: CORTEXT_NAMESPACE, env: on, metric: vi.fn() }, warn);
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain(`Unset ${REPAIR_ENV_VAR}`);
  });
});
