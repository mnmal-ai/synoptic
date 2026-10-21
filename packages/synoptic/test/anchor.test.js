import { describe, expect, it } from 'vitest';
import { resolveAnchorHttp } from '../src/anchor.js';

// Serves canned /substrate/v1/query responses keyed by the payload's frame key.
function queryMock(byKey) {
  return (_url, init) => {
    const payload = JSON.parse(init.body);
    const key = Object.keys(payload)[0];
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { [key]: byKey[key] ?? [] } })
    });
  };
}

describe('resolveAnchorHttp', () => {
  it('uses newest AnchorIntent and counts SessionLogs since for staleness', async () => {
    const fetchImpl = queryMock({
      'claude/AnchorIntent': [
        {
          id: 'a1',
          shortId: '7',
          synopsis: 'NEXT: build the plugin',
          authoredBy: { kind: 'agent' },
          _metadata: { createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z' }
        }
      ],
      'claude/SessionLog': [
        { id: 's3', _metadata: { createdAt: '2026-06-03T00:00:00Z' } },
        { id: 's2', _metadata: { createdAt: '2026-06-02T00:00:00Z' } },
        { id: 's1', _metadata: { createdAt: '2026-06-01T12:00:00Z' } }
      ]
    });
    const anchor = await resolveAnchorHttp({
      substrateUrl: 'https://h',
      namespace: 'claude',
      projectSlug: 'demo',
      staleThreshold: 3,
      fetchImpl
    });
    expect(anchor.source).toBe('intent');
    expect(anchor.text).toContain('build the plugin');
    expect(anchor.sessionLogsSince).toBe(3);
    expect(anchor.stale).toBe(true);
    expect(anchor.lastSessionLogAt).toBe('2026-06-03T00:00:00Z');
    expect(anchor.body.shortId).toBe('7');
    expect(anchor.body.updatedAt).toBe('2026-06-01T00:00:00Z');
    expect(anchor.body.authoredBy.kind).toBe('agent');
  });

  it('is not stale when fewer SessionLogs than threshold', async () => {
    const fetchImpl = queryMock({
      'claude/AnchorIntent': [
        { id: 'a1', synopsis: 'x', _metadata: { createdAt: '2026-06-01T00:00:00Z' } }
      ],
      'claude/SessionLog': [{ id: 's1', _metadata: { createdAt: '2026-06-02T00:00:00Z' } }]
    });
    const anchor = await resolveAnchorHttp({
      substrateUrl: 'https://h',
      namespace: 'claude',
      projectSlug: 'demo',
      staleThreshold: 3,
      fetchImpl
    });
    expect(anchor.sessionLogsSince).toBe(1);
    expect(anchor.stale).toBe(false);
  });

  it('falls back to newest SessionLog when no AnchorIntent', async () => {
    const fetchImpl = queryMock({
      'claude/AnchorIntent': [],
      'claude/SessionLog': [
        {
          id: 's1',
          shortId: '4',
          synopsis: 'last session did X',
          branch: 'main',
          _metadata: { createdAt: '2026-06-03T00:00:00Z', updatedAt: '2026-06-03T00:00:00Z' }
        }
      ]
    });
    const anchor = await resolveAnchorHttp({
      substrateUrl: 'https://h',
      namespace: 'claude',
      projectSlug: 'demo',
      fetchImpl
    });
    expect(anchor.source).toBe('sessionlog');
    expect(anchor.text).toContain('last session');
    expect(anchor.body.branch).toBe('main');
    expect(anchor.stale).toBe(false);
  });

  it('returns null when neither exists', async () => {
    const fetchImpl = queryMock({ 'claude/AnchorIntent': [], 'claude/SessionLog': [] });
    const anchor = await resolveAnchorHttp({
      substrateUrl: 'https://h',
      namespace: 'claude',
      projectSlug: 'demo',
      fetchImpl
    });
    expect(anchor).toBeNull();
  });
});
