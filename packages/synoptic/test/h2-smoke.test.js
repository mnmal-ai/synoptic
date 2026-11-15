// The default transport against a real HTTP/2-only substrate: every helper is
// called WITHOUT a fetchImpl, so what runs is what a hook runs in production.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeSignedFetch } from '../src/agent-auth.js';
import { probeWhoami, substrateMutate, substrateQuery } from '../src/substrate-http.js';
import { startSubstrate } from './fixtures/substrate-server.js';

let server;
beforeAll(async () => {
  server = await startSubstrate();
}, 30000);
afterAll(() => server?.stop());

describe('synoptic over HTTP/2 (h2c) against a real substrate', () => {
  it('whoami answers', async () => {
    const who = await probeWhoami(server.url);
    expect(who).toMatchObject({ ok: true, authEnabled: false, authenticated: false });
  });

  it('a mutate writes and a query reads it back', async () => {
    const created = await substrateMutate(server.url, {
      'cortext/createMemory': {
        params: {
          name: 'h2-smoke',
          description: 'transport check',
          type: 'note',
          body: 'b',
          archived: false
        },
        fields: { id: true }
      }
    });
    const id = created['cortext/createMemory'].id;
    expect(id).toEqual(expect.any(String));

    const data = await substrateQuery(server.url, {
      'cortext/Memory': { params: { where: { id: { eq: id } } }, fields: { id: true, name: true } }
    });
    expect(data['cortext/Memory']).toEqual([{ id, name: 'h2-smoke' }]);
  });

  it('an unsigned request still goes out when there is no credential', async () => {
    const signed = makeSignedFetch(() => null);
    const who = await probeWhoami(server.url, { fetchImpl: signed });
    expect(who).toMatchObject({ ok: true, authenticated: false });
  });
});
