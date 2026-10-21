import { describe, expect, it } from 'vitest';
import { NULL_CHECK_FIELDS, reportHostInstall, reportHostWithChecks } from '../src/host-report.js';

const RECORD = {
  key: 'desk/synoptic/claude-code',
  host: 'desk',
  hostReported: 'Desk',
  project: 'synoptic',
  kid: 'k@Desk',
  harness: 'claude-code',
  pluginVersion: '2.9.0',
  fragmentVersion: null,
  fragmentDigest: null,
  fragmentState: 'absent',
  refreshedAt: '2026-10-09T12:00:00.000Z'
};

/** A scripted server: each handler gets the parsed payload, returns { data, errors? }. */
function scripted(handlers) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const key = Object.keys(payload)[0];
    calls.push(key);
    const h = handlers[key];
    if (h === 'throw') throw new Error('network down');
    const body = typeof h === 'function' ? h(payload[key], calls) : h;
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

const opts = (fetchImpl, failures = []) => ({
  substrateUrl: 'https://h',
  namespace: 'cortext',
  fetchImpl,
  record: RECORD,
  onFailure: (k, d) => failures.push([k, d])
});

describe('reportHostInstall', () => {
  it('creates when no row has the key', async () => {
    const { fetchImpl, calls } = scripted({
      'cortext/HostInstall': { data: { 'cortext/HostInstall': [] } },
      'cortext/createHostInstall': { data: { 'cortext/createHostInstall': { id: 'r1' } } }
    });
    expect(await reportHostInstall(opts(fetchImpl))).toBe('created');
    // The third call is the one-time lookup for a pre-harness legacy row.
    expect(calls).toEqual([
      'cortext/HostInstall',
      'cortext/createHostInstall',
      'cortext/HostInstall'
    ]);
  });

  // A unique-index violation on a single frame fails the whole request; only
  // the batched form comes back as an in-envelope refusal the race path reads.
  it('sends the create in batched form', async () => {
    let frame = null;
    const { fetchImpl } = scripted({
      'cortext/HostInstall': { data: { 'cortext/HostInstall': [] } },
      'cortext/createHostInstall': (f) => {
        frame = f;
        return { data: { 'cortext/createHostInstall': [{ id: 'r1' }] } };
      }
    });
    expect(await reportHostInstall(opts(fetchImpl))).toBe('created');
    expect(Array.isArray(frame)).toBe(true);
    expect(frame[0].params.key).toBe(RECORD.key);
  });

  it('stops at the shared budget, however many steps remain', async () => {
    const calls = [];
    const fetchImpl = (url, init) =>
      new Promise((resolve, reject) => {
        calls.push(url);
        const timer = setTimeout(
          () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({ data: { 'cortext/HostInstall': [] } })
            }),
          150
        );
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    const started = Date.now();
    const out = await reportHostInstall({ ...opts(fetchImpl), budgetMs: 200 });
    expect(out).toBe('offline');
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('after creating, removes the same-harness row under the old host/project key', async () => {
    const queried = [];
    const deleted = [];
    const { fetchImpl, calls } = scripted({
      'cortext/HostInstall': (frame) => {
        queried.push(frame.params.where);
        return {
          data: {
            'cortext/HostInstall':
              frame.params.where.key.eq === 'desk/synoptic' ? [{ id: 'old1' }] : []
          }
        };
      },
      'cortext/createHostInstall': { data: { 'cortext/createHostInstall': [{ id: 'r1' }] } },
      'cortext/deleteHostInstall': (frame) => {
        deleted.push(frame.params.id);
        return { data: { 'cortext/deleteHostInstall': { id: frame.params.id } } };
      }
    });
    expect(await reportHostInstall(opts(fetchImpl))).toBe('created');
    expect(queried[1]).toEqual({
      key: { eq: 'desk/synoptic' },
      harness: { eq: 'claude-code' }
    });
    expect(deleted).toEqual(['old1']);
    expect(calls.at(-1)).toBe('cortext/deleteHostInstall');
  });

  it('a failed legacy cleanup is silent and does not change the outcome', async () => {
    const failures = [];
    const { fetchImpl } = scripted({
      'cortext/HostInstall': (frame) =>
        frame.params.where.harness
          ? {
              data: {},
              errors: [{ path: ['cortext/HostInstall'], code: 'forbidden', message: 'x' }]
            }
          : { data: { 'cortext/HostInstall': [] } },
      'cortext/createHostInstall': { data: { 'cortext/createHostInstall': [{ id: 'r1' }] } }
    });
    expect(await reportHostInstall(opts(fetchImpl, failures))).toBe('created');
    expect(failures).toEqual([]);
  });

  it('an update does not look for a legacy row', async () => {
    const { fetchImpl, calls } = scripted({
      'cortext/HostInstall': { data: { 'cortext/HostInstall': [{ id: 'r1' }] } },
      'cortext/updateHostInstall': { data: { 'cortext/updateHostInstall': { id: 'r1' } } }
    });
    expect(await reportHostInstall(opts(fetchImpl))).toBe('updated');
    expect(calls).toEqual(['cortext/HostInstall', 'cortext/updateHostInstall']);
  });

  it('updates the existing row, sending its id and never the key change', async () => {
    let sent = null;
    const { fetchImpl } = scripted({
      'cortext/HostInstall': { data: { 'cortext/HostInstall': [{ id: 'r1' }] } },
      'cortext/updateHostInstall': (frame) => {
        sent = frame.params;
        return { data: { 'cortext/updateHostInstall': { id: 'r1' } } };
      }
    });
    expect(await reportHostInstall(opts(fetchImpl))).toBe('updated');
    expect(sent.id).toBe('r1');
    expect(sent.refreshedAt).toBe(RECORD.refreshedAt);
  });

  it('a lost create race re-queries and updates, reporting nothing', async () => {
    const failures = [];
    const { fetchImpl, calls } = scripted({
      'cortext/HostInstall': (_f, c) => ({
        data: { 'cortext/HostInstall': c.length === 1 ? [] : [{ id: 'r9' }] }
      }),
      'cortext/createHostInstall': {
        data: {},
        errors: [
          { path: ['cortext/createHostInstall'], code: 'conflict', message: 'duplicate key' }
        ]
      },
      'cortext/updateHostInstall': { data: { 'cortext/updateHostInstall': { id: 'r9' } } }
    });
    expect(await reportHostInstall(opts(fetchImpl, failures))).toBe('updated');
    expect(calls).toEqual([
      'cortext/HostInstall',
      'cortext/createHostInstall',
      'cortext/HostInstall',
      'cortext/updateHostInstall'
    ]);
    expect(failures).toEqual([]);
  });

  // a runtime predating the type refuses every frame. The
  // session must see one line, not one per attempt.
  it('a runtime without HostInstall reports exactly one failure', async () => {
    const failures = [];
    const refuse = (key) => ({
      data: {},
      errors: [{ path: [key], code: 'unknown_name', message: `unknown name '${key}'` }]
    });
    const { fetchImpl } = scripted({
      'cortext/HostInstall': refuse('cortext/HostInstall')
    });
    expect(await reportHostInstall(opts(fetchImpl, failures))).toBe('refused');
    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toBe('cortext/HostInstall');
    expect(failures[0][1]).toMatch(/unknown_name/);
  });

  it('a transport failure is offline: silent, never thrown', async () => {
    const failures = [];
    const { fetchImpl } = scripted({ 'cortext/HostInstall': 'throw' });
    expect(await reportHostInstall(opts(fetchImpl, failures))).toBe('offline');
    expect(failures).toEqual([]);
  });

  it('a create refused for another reason, with no row on re-query, reports once', async () => {
    const failures = [];
    const { fetchImpl } = scripted({
      'cortext/HostInstall': { data: { 'cortext/HostInstall': [] } },
      'cortext/createHostInstall': {
        data: {},
        errors: [{ path: ['cortext/createHostInstall'], code: 'forbidden', message: 'no mutate' }]
      }
    });
    expect(await reportHostInstall(opts(fetchImpl, failures))).toBe('refused');
    expect(failures).toEqual([['cortext/createHostInstall', 'forbidden: no mutate']]);
  });
});

describe('reportHostWithChecks', () => {
  const base = { key: 'h/p/claude-code' };
  const fields = { pinState: 'ok' };
  const refuse = (detail) => (key, onFailure) => {
    onFailure('cortext/createHostInstall', detail);
    return 'refused';
  };

  it('sends the base record with the check fields', async () => {
    const sent = [];
    const out = await reportHostWithChecks({
      base,
      checks: async () => fields,
      report: async (record) => {
        sent.push(record);
        return 'created';
      }
    });
    expect(out).toEqual({ failure: null, checksNote: null });
    expect(sent).toEqual([{ ...base, ...fields }]);
  });

  it('a runtime predating the fields gets the base record, and says the checks were not recorded', async () => {
    const sent = [];
    const out = await reportHostWithChecks({
      base,
      checks: async () => fields,
      report: async (record, onFailure) => {
        sent.push(record);
        return 'pinState' in record
          ? refuse("unknown_field: Cannot create with undeclared field 'pinState'")(
              record,
              onFailure
            )
          : 'created';
      }
    });
    expect(sent).toEqual([{ ...base, ...fields }, base]);
    expect(out).toEqual({ failure: null, checksNote: 'this runtime predates the check fields' });
  });

  it('any other refusal clears the verdicts, so old ones never read as current', async () => {
    const sent = [];
    const out = await reportHostWithChecks({
      base,
      checks: async () => fields,
      report: async (record, onFailure) => {
        sent.push(record);
        return record.pinState === 'ok'
          ? refuse('invalid_enum_value: pinState')(record, onFailure)
          : 'updated';
      }
    });
    expect(sent[1]).toEqual({ ...base, ...NULL_CHECK_FIELDS });
    expect(out).toEqual({ failure: null, checksNote: 'invalid_enum_value: pinState' });
  });

  it("reports the fallback's own failure when both are refused", async () => {
    const out = await reportHostWithChecks({
      base,
      checks: async () => fields,
      report: async (record, onFailure) => {
        onFailure('k', 'pinState' in record && record.pinState !== null ? 'first' : 'second');
        return 'refused';
      }
    });
    expect(out).toEqual({ failure: ['k', 'second'], checksNote: null });
  });

  it('checks that throw are written as cleared verdicts, not left stale', async () => {
    const sent = [];
    await reportHostWithChecks({
      base,
      checks: async () => {
        throw new Error('boom');
      },
      report: async (record) => {
        sent.push(record);
        return 'updated';
      }
    });
    expect(sent).toEqual([{ ...base, ...NULL_CHECK_FIELDS }]);
  });
});
