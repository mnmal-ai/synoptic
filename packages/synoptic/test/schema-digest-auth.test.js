// The schema digest under a gated schema route.
//
// substrate can put /substrate/v1/schema* behind a `read` key. Two things must hold
// when it does, and each is pinned here because each has a silent failure:
//
//   1. The schema fetch goes out SIGNED. It has no header of its own — it
//      rides the `makeSignedFetch` seam every entry point installs — so the
//      pin is that the request reaching the server carries the header the
//      seam minted, not that `schema-digest.js` mentions one.
//
//   2. A REFUSED fetch is visible. If a 401 returned null, the Write
//      contract section would vanish — indistinguishable from a server that
//      never had one. That is exactly what a missing or rejected
//      key produces, so it must say so.
//
// A 404 stays silent on purpose: that is an older server without the route,
// and a missing digest must cost the session nothing.

import { describe, expect, it } from 'vitest';
import { makeSignedFetch } from '../src/agent-auth.js';
import { runColdStart } from '../src/cold-start.js';
import { fetchNamespaceSchema } from '../src/schema-digest.js';

function jsonOk(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

const SCHEMA = { types: { Todo: { fields: { title: { type: 'string' } } } } };

/** A server whose schema route answers `schemaStatus`; everything else is empty. */
function server(schemaStatus, seen = []) {
  return (url, init = {}) => {
    seen.push({ url: String(url), authorization: init.headers?.authorization ?? null });
    if (url.endsWith('/substrate/v1/query')) {
      const payload = JSON.parse(init.body);
      const data = {};
      for (const key of Object.keys(payload)) data[key] = [];
      return Promise.resolve(jsonOk({ data }));
    }
    if (url.endsWith('/substrate/v1/embed-stats'))
      return Promise.resolve(jsonOk({ enabled: false }));
    if (url.includes('/substrate/v1/schema')) {
      return Promise.resolve(
        schemaStatus === 200
          ? jsonOk(SCHEMA)
          : { ok: false, status: schemaStatus, json: () => Promise.resolve({}) }
      );
    }
    return Promise.resolve(jsonOk({}));
  };
}

const base = {
  substrateUrl: 'https://h:3100',
  namespace: 'cortext',
  projectSlug: 'demo',
  nowMs: Date.UTC(2026, 8, 30),
  ruleSalience: false
};

describe('fetchNamespaceSchema — refusal reporting', () => {
  it('reports the status of a refused fetch, and still returns null', async () => {
    const statuses = [];
    const out = await fetchNamespaceSchema('http://h', 'cortext', {
      fetchImpl: async () => new Response('{}', { status: 401 }),
      onRefused: (s) => statuses.push(s)
    });
    expect(out).toBeNull();
    expect(statuses).toEqual([401]);
  });

  it('does not report a success, a throw, or a junk body', async () => {
    const statuses = [];
    const onRefused = (s) => statuses.push(s);
    await fetchNamespaceSchema('http://h', 'cortext', {
      fetchImpl: async () => new Response(JSON.stringify(SCHEMA), { status: 200 }),
      onRefused
    });
    await fetchNamespaceSchema('http://h', 'cortext', {
      fetchImpl: async () => {
        throw new Error('network');
      },
      onRefused
    });
    expect(statuses).toEqual([]);
  });
});

describe('runColdStart — schema route behind a read key', () => {
  it('sends the schema fetch through the signed seam', async () => {
    const seen = [];
    await runColdStart({
      ...base,
      fetchImpl: makeSignedFetch(() => 'Bearer t0k', server(200, seen))
    });
    const schemaCalls = seen.filter((r) => r.url.includes('/substrate/v1/schema'));
    expect(schemaCalls).toHaveLength(1);
    expect(schemaCalls[0].authorization).toBe('Bearer t0k');
  });

  it.each([401, 403])(
    'a %i renders a visible degradation line naming the schema route',
    async (status) => {
      const out = await runColdStart({ ...base, fetchImpl: server(status) });
      expect(out).toContain('Cold-start is INCOMPLETE');
      expect(out).toContain('/substrate/v1/schema/cortext');
      expect(out).toContain(String(status));
      expect(out).not.toContain('## Write contract');
    }
  );

  it('a 404 stays silent — an older server without the route costs nothing', async () => {
    const out = await runColdStart({ ...base, fetchImpl: server(404) });
    expect(out).not.toContain('Cold-start is INCOMPLETE');
  });

  it('a 200 renders the Write contract and no banner', async () => {
    const out = await runColdStart({ ...base, fetchImpl: server(200) });
    expect(out).toContain('## Write contract');
    expect(out).not.toContain('Cold-start is INCOMPLETE');
  });
});
