// The injected cold-start must fit 5 KB on a live-shaped rule set, render every
// binding and always-on rule once, and never clip a synopsis.

import { expect, it } from 'vitest';
import { runColdStart } from '../src/cold-start.js';
import { ruleFixture } from './fixtures/rule-index.js';

const BUDGET = 5120;

function jsonOk(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function fetchFor(rules, inbox) {
  return (_url, init) => {
    const payload = JSON.parse(init.body);
    const data = {};
    for (const key of Object.keys(payload)) {
      data[key] = key.endsWith('/AgentRule')
        ? rules
        : key.endsWith('/AgentIdentity')
          ? [{ id: 'me' }]
          : key.endsWith('/AgentMessage')
            ? inbox
            : [];
    }
    return Promise.resolve(jsonOk({ data }));
  };
}

it('a live-shaped payload fits 5 KB with every must and pinned rule once', async () => {
  const rules = ruleFixture();
  const inbox = [{ shortId: 990 }, { shortId: 1000 }, { shortId: 1004 }];
  const out = await runColdStart({
    substrateUrl: 'https://h:3100',
    namespace: 'cortext',
    projectSlug: 'synoptic',
    agentKid: 'synoptic-claude@Box',
    sessionId: '770ea2cd-da45-412e-9fed-06bd4b126d11',
    hostReport: false,
    fetchImpl: fetchFor(rules, inbox)
  });
  expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(BUDGET);
  for (const r of rules.filter((r) => r.severity === 'must' || r.pinned)) {
    expect(out.split(`#${r.shortId} (`).length - 1).toBe(1);
    expect(out).toContain(r.synopsis);
  }
});
