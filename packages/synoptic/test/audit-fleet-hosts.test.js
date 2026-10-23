import assert from 'node:assert/strict';
import { test } from 'vitest';
import { gatherFleet } from '../src/audit-facts/fleet.js';

const ROW = {
  host: 'laptop',
  project: 'synoptic',
  harness: 'claude-code',
  kid: 'synoptic-claude@laptop',
  pluginVersion: '1.0.0',
  refreshedAt: new Date().toISOString(),
  _metadata: { updatedBy: { id: 'synoptic-claude@laptop' } }
};

const base = (fetchImpl) => ({
  fleetDir: null,
  directoryRows: [{ kid: 'synoptic-claude@laptop', host: 'laptop', project: 'synoptic' }],
  candidates: [],
  substrateUrl: 'https://substrate.test',
  env: {},
  fetchImpl
});

const answering = () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { 'cortext/HostInstall': [ROW] } })
    };
  };
  return { calls, fetchImpl };
};

test('--hosts audits HostInstall rows without a fleet directory', async () => {
  const { calls, fetchImpl } = answering();
  const { fleetFindings, hostFindings } = await gatherFleet({ ...base(fetchImpl), hosts: true });
  assert.equal(fleetFindings, null);
  assert.equal(calls.length, 1);
  assert.ok(hostFindings.some((f) => f.text.includes('laptop/synoptic/claude-code fresh')));
});

test('without --fleet or --hosts, nothing is read and both are null', async () => {
  const { calls, fetchImpl } = answering();
  const out = await gatherFleet(base(fetchImpl));
  assert.deepEqual(out, { fleetFindings: null, hostFindings: null });
  assert.equal(calls.length, 0);
});
