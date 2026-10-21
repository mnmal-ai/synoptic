// Placement order and payload budget.
//
// `runColdStart` must not build `sections[]` in FETCH order: the binding `must`
// rules arrive near the end, with Open Work, and would land far below the
// harness's ~2 KB preview, where an agent never reads them.

import assert from 'node:assert/strict';
import { describe, expect, it, test } from 'vitest';
import { renderManifest, runColdStart } from '../src/cold-start.js';

function jsonOk(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

// Recall is the `recall/Hit` frame, so it arrives on
// /substrate/v1/query like everything else and a refusal is a 200 with the key absent.
function refusedFrame(key) {
  return jsonOk({
    data: {},
    errors: [{ path: [key], code: 'embedder_unavailable', message: 'no embedder' }]
  });
}

function route(handlers) {
  return (url, init) => {
    if (url.endsWith('/substrate/v1/query')) {
      const payload = JSON.parse(init.body);
      if ('recall/Hit' in payload) return Promise.resolve(refusedFrame('recall/Hit'));
      const data = {};
      for (const key of Object.keys(payload)) data[key] = handlers.query?.[key] ?? [];
      return Promise.resolve(jsonOk({ data }));
    }
    if (url.endsWith('/substrate/v1/embed-stats'))
      return Promise.resolve(jsonOk({ enabled: false }));
    if (url.includes('/substrate/v1/schema'))
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    throw new Error(`unexpected ${url}`);
  };
}

const base = {
  substrateUrl: 'https://h:3100',
  namespace: 'cortext',
  projectSlug: 'demo',
  nowMs: Date.UTC(2026, 7, 20)
};

const mustRule = {
  shortId: 21,
  rule: 'Never add a Co-Authored-By trailer.',
  category: 'git',
  severity: 'must',
  rationale: 'The operator asked for it directly.'
};
const shouldRule = {
  shortId: 7,
  rule: 'Keep responses concise and skip trailing summaries.',
  category: 'style',
  severity: 'should',
  rationale: ''
};

// A memory big enough to shove anything after it below a preview, which is
// exactly the condition that produced the original failure.
const fatMemory = {
  id: 'm1',
  type: 'project',
  name: 'a-large-memory',
  description: 'bulky',
  body: `## a forged heading\n\n${'padding padding padding. '.repeat(400)}`,
  _metadata: { updatedAt: '2026-08-19T00:00:00Z' }
};

function fullRoute() {
  return route({
    query: {
      'cortext/Concept': [{ name: 'C', description: 'a concept', kind: 'pattern' }],
      'cortext/AnchorIntent': [],
      'cortext/SessionLog': [],
      'cortext/Decision': [],
      'cortext/Memory': [fatMemory],
      'cortext/Todo': [{ shortId: 1, title: 'a todo', status: 'open', priority: 'high' }],
      'cortext/AgentRule': [mustRule, shouldRule]
    }
  });
}

describe('cold-start placement order', () => {
  it('places the must rules ahead of Concepts and Agent Memory', async () => {
    const out = await runColdStart({ ...base, fetchImpl: fullRoute() });

    const iMust = out.indexOf('## Agent Rules — must');
    const iConcepts = out.indexOf('## Concepts');
    const iMemory = out.indexOf('## Agent Memory');

    assert.ok(iMust > -1, 'must section rendered');
    assert.ok(iConcepts > -1, 'concepts rendered');
    assert.ok(iMemory > -1, 'memory rendered');
    assert.ok(iMust < iConcepts, `must (${iMust}) must precede Concepts (${iConcepts})`);
    assert.ok(iMust < iMemory, `must (${iMust}) must precede Memory (${iMemory})`);
  });

  it('keeps the should rules in their original position, after Agent Memory', async () => {
    const out = await runColdStart({ ...base, fetchImpl: fullRoute() });
    const iMemory = out.indexOf('## Agent Memory');
    const iShould = out.indexOf('## Agent Rules — should');
    assert.ok(iShould > -1, 'should section rendered');
    assert.ok(iShould > iMemory, 'advisory rules stay below the recoverable context');
  });

  it('splits the two tiers into separate sections rather than one block', async () => {
    const out = await runColdStart({ ...base, fetchImpl: fullRoute() });
    // Prefix, not the exact count. This is a PLACEMENT test, and the should
    // section's tail differs between the two renders — classic says `(1)`, the
    // salient render says `(0 pinned, 1 salient, 0 skim)`. Asserting the
    // classic tail here pinned a placement test to a render mode, and it broke
    // the moment the default flipped, reporting a layout defect that did not
    // exist.
    assert.ok(out.includes('## Agent Rules — must (1)'));
    assert.ok(out.includes('## Agent Rules — should'));
  });

  it('marks the must section as binding where the reader arrives', async () => {
    const out = await runColdStart({ ...base, fetchImpl: fullRoute() });
    const section = out.slice(out.indexOf('## Agent Rules — must'));
    assert.match(section, /Binding\. These are not preferences\./);
  });

  it('the Inbox still leads when there is mail', async () => {
    // The must block outranks everything that degrades gracefully, but a
    // directed message is still the most actionable wake-up signal.
    const out = await runColdStart({ ...base, fetchImpl: fullRoute() });
    const iMust = out.indexOf('## Agent Rules — must');
    const iConcepts = out.indexOf('## Concepts');
    assert.ok(iMust < iConcepts);
  });

  it('renders nothing for a tier that has no rules', async () => {
    const only = route({
      query: {
        'cortext/Concept': [],
        'cortext/AnchorIntent': [],
        'cortext/SessionLog': [],
        'cortext/Decision': [],
        'cortext/Memory': [],
        'cortext/Todo': [],
        'cortext/AgentRule': [shouldRule]
      }
    });
    const out = await runColdStart({ ...base, fetchImpl: only });
    assert.ok(!out.includes('— must'), 'no empty must section');
    assert.ok(out.includes('## Agent Rules — should'));
    // And critically it must never advertise a zero: "0 must" reads as
    // "there are no binding rules", the opposite of what a filter means.
    assert.ok(!out.includes('0 must'));
  });

  it('folds an oversized memory body and says it did', async () => {
    const out = await runColdStart({ ...base, memoryMode: 'full', fetchImpl: fullRoute() });
    assert.match(out, /TRUNCATED for cold-start budget, not ended/);
  });

  it('a memory body cannot forge a document section', async () => {
    const out = await runColdStart({ ...base, memoryMode: 'full', fetchImpl: fullRoute() });
    assert.ok(!out.includes('## a forged heading'), 'body heading must not survive as a section');
    assert.ok(out.includes('**a forged heading**'), 'it survives as emphasis instead');
  });
});

describe('renderManifest', () => {
  test('renders nothing for a payload small enough to read whole', () => {
    const body = 'x'.repeat(500);
    assert.equal(renderManifest(['## A\n' + body], body), '');
  });

  test('renders an index once the payload is large enough to be truncated', () => {
    const secs = [
      '## Inbox\n' + 'a'.repeat(2000),
      '## Agent Rules — must (12)\n' + 'b'.repeat(9000)
    ];
    const body = secs.join('\n\n');
    const out = renderManifest(secs, body);
    assert.match(out, /PRESENT AND UNREAD, not empty/);
    assert.ok(out.includes('Inbox'));
    assert.ok(out.includes('Agent Rules — must (12)'));
  });

  test('the manifest is small enough to survive a 2 KB preview', () => {
    // The whole point: whatever else is cut, this is not.
    const secs = Array.from({ length: 7 }, (_, i) => `## Section ${i}\n${'z'.repeat(9000)}`);
    const body = secs.join('\n\n');
    const out = renderManifest(secs, body);
    assert.ok(out.length < 1400, `manifest is ${out.length} B; must fit a 2 KB preview`);
  });

  test('reports each section size and the total', () => {
    const secs = ['## One\n' + 'a'.repeat(10_240)];
    const body = secs.join('\n\n');
    const out = renderManifest(secs, body);
    assert.match(out, /10\.0 KB {2}One/);
  });

  test('a section with no heading still gets a row rather than a blank', () => {
    const secs = ['no heading here\n' + 'a'.repeat(9000)];
    const out = renderManifest(secs, secs.join('\n\n'));
    assert.ok(out.includes('no heading here'));
  });
});

describe('runColdStart still degrades safely', () => {
  it('returns the offline comment without throwing when substrate is down', async () => {
    const dead = () => Promise.reject(new Error('ECONNREFUSED'));
    const out = await runColdStart({ ...base, fetchImpl: dead });
    expect(out).toContain('substrate offline');
  });
});

describe('session discriminator placement', () => {
  it('places the session block above the binding rules and the bulk', async () => {
    // It governs WRITES, so it must be read before the session starts writing.
    const out = await runColdStart({
      ...base,
      fetchImpl: fullRoute(),
      sessionId: '125f8d22-0044-4e28-8aec-a80be97df2d5',
      agentKid: 'synoptic-claude@Desk'
    });
    const iSession = out.indexOf('## This session');
    const iMust = out.indexOf('## Agent Rules — must');
    const iMemory = out.indexOf('## Agent Memory');
    assert.ok(iSession > -1, 'session block rendered');
    assert.ok(iSession < iMust, 'session precedes the must rules');
    assert.ok(iSession < iMemory, 'session precedes the bulk');
    assert.match(out, /tags: \["session:125f8d22"\]/);
  });

  it('omits the block entirely when the harness gave no session id', async () => {
    const out = await runColdStart({ ...base, fetchImpl: fullRoute() });
    assert.ok(!out.includes('## This session'));
    assert.ok(!out.includes('session:undefined'), 'never stamps a value it does not have');
  });
});

describe('AgentRule salient tier wired end to end', () => {
  // MORE rules than the salient tier's default topK (5), so promotion is a
  // genuine subset. An earlier version of this test used three and asserted a
  // subset that could not exist — every rule was salient and the assertion was
  // measuring the fixture, not the behaviour.
  const salientRules = Array.from({ length: 8 }, (_, i) => ({
    id: `r${i}`,
    shortId: 10 + i,
    rule: `rule number ${i} about widgets`,
    category: 'tooling',
    severity: 'should'
  }));
  const RULE_TOPK = 5;

  // Dispatches on the FRAME KEY, not the URL: the salient tier's two calls are
  // frames on /substrate/v1/mutate, indistinguishable by URL from each other.
  function salienceRoute({ vectors = [], onBoost = () => {} } = {}) {
    return (url, init) => {
      if (url.endsWith('/substrate/v1/mutate')) {
        const payload = JSON.parse(init.body);
        if ('recall/fetchEmbeddings' in payload) {
          return Promise.resolve(
            jsonOk({ data: { 'recall/fetchEmbeddings': { model: 'bge-m3:1024', vectors } } })
          );
        }
        if ('recall/boost' in payload) {
          onBoost(payload['recall/boost'].params);
          return Promise.resolve(
            jsonOk({
              data: { 'recall/boost': { ok: true, requested: 1, applied: 1, missing: [] } }
            })
          );
        }
        throw new Error(`unexpected mutate frame ${Object.keys(payload).join(',')}`);
      }
      if (url.endsWith('/substrate/v1/query')) {
        const payload = JSON.parse(init.body);
        if ('recall/Hit' in payload) return Promise.resolve(refusedFrame('recall/Hit'));
        const data = {};
        for (const key of Object.keys(payload)) {
          data[key] = key.endsWith('/AgentRule')
            ? salientRules
            : key.endsWith('/AnchorIntent')
              ? [
                  {
                    id: 'anchor-1',
                    shortId: 9,
                    synopsis: 'wiring rule salience',
                    authoredBy: { kind: 'agent' },
                    _metadata: {
                      createdAt: '2026-08-20T00:00:00Z',
                      updatedAt: '2026-08-20T00:00:00Z'
                    }
                  }
                ]
              : [];
        }
        return Promise.resolve(jsonOk({ data }));
      }
      if (url.endsWith('/substrate/v1/embed-stats'))
        return Promise.resolve(jsonOk({ enabled: false }));
      if (url.includes('/substrate/v1/schema'))
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      throw new Error(`unexpected ${url}`);
    };
  }

  // Every salient-tier call is now a POST to the same URL, so counting URLs
  // proves nothing. Count frame keys.
  function framesSent(route, sink) {
    return (u, i) => {
      if (u.endsWith('/substrate/v1/mutate')) sink.push(...Object.keys(JSON.parse(i.body)));
      return route(u, i);
    };
  }

  it('fetches NO vectors when the salience flag is off — the default path is unchanged', async () => {
    const frames = [];
    const route = salienceRoute();
    await runColdStart({ ...base, ruleSalience: false, fetchImpl: framesSent(route, frames) });
    expect(frames).toEqual([]);
  });

  it('fetches anchor AND rule vectors when the flag is on', async () => {
    const frames = [];
    const route = salienceRoute();
    await runColdStart({ ...base, ruleSalience: true, fetchImpl: framesSent(route, frames) });
    expect(frames.filter((k) => k === 'recall/fetchEmbeddings').length).toBe(2);
  });

  it('boosts the PROMOTED rules, not every rule it considered', async () => {
    // Reinforcing everything the ranker looked at would boost the whole rule
    // set uniformly, which is the same as boosting nothing.
    let boosted = null;
    const route = salienceRoute({
      vectors: salientRules.map((r, i) => ({
        namespace: 'cortext',
        type: 'AgentRule',
        id: r.id,
        vector: i === 0 ? [1, 0] : [0, 1]
      })),
      onBoost: (b) => {
        boosted = b;
      }
    });
    await runColdStart({ ...base, ruleSalience: true, fetchImpl: route });
    expect(boosted).not.toBeNull();
    // The promoted set is pinned + salient — strictly fewer than every rule
    // considered.
    expect(boosted.targets.length).toBe(RULE_TOPK);
    expect(boosted.targets.length).toBeLessThan(salientRules.length);
    expect(boosted.targets[0]).toHaveProperty('namespace', 'cortext');
    expect(boosted.targets[0]).toHaveProperty('type', 'AgentRule');
  });

  it('renders and does not boost when the salient tier promoted nothing', async () => {
    let boosted = false;
    const route = salienceRoute({
      onBoost: () => {
        boosted = true;
      }
    });
    const out = await runColdStart({
      ...base,
      ruleSalience: true,
      fetchImpl: (u, i) => {
        if (u.endsWith('/substrate/v1/query')) {
          const payload = JSON.parse(i.body);
          const data = {};
          for (const key of Object.keys(payload)) data[key] = [];
          return Promise.resolve(jsonOk({ data }));
        }
        return route(u, i);
      }
    });
    expect(boosted).toBe(false);
    expect(out).toBeTypeOf('string');
  });

  it('still renders when the vector fetch fails — degrades to structural', async () => {
    // The short-circuit in rankRules is the existing behaviour; a dead
    // embeddings route must land there rather than blacking out the section.
    const out = await runColdStart({
      ...base,
      ruleSalience: true,
      fetchImpl: (u, i) => {
        if (u.includes('/embeddings/fetch')) return Promise.reject(new Error('down'));
        if (u.includes('/salience/boost')) return Promise.reject(new Error('down'));
        return salienceRoute()(u, i);
      }
    });
    expect(out).toContain('## Agent Rules');
    expect(out).not.toContain('substrate offline');
  });

  it('a failing boost never breaks the cold-start', async () => {
    const out = await runColdStart({
      ...base,
      ruleSalience: true,
      fetchImpl: (u, i) => {
        if (u.includes('/salience/boost')) return Promise.reject(new Error('boom'));
        return salienceRoute({
          vectors: salientRules.map((r) => ({
            namespace: 'cortext',
            type: 'AgentRule',
            id: r.id,
            vector: [1, 0]
          }))
        })(u, i);
      }
    });
    expect(out).not.toContain('substrate offline');
  });
});

// ---------------------------------------------------------------------------
// The salient tier is the DEFAULT, and
// RULE_SALIENCE=off is the escape hatch. Both directions are asserted, because
// a flag that cannot be switched off is not an escape hatch — and the classic
// render only earns its keep if something still reaches it.
// ---------------------------------------------------------------------------

describe('salient tier on by default', () => {
  it('the DEFAULT render is salient, not classic', async () => {
    const out = await runColdStart({ ...base, fetchImpl: fullRoute() });
    expect(out).toMatch(/## Agent Rules — should \(\d+ pinned, \d+ salient, \d+ skim\)/);
  });

  it('ruleSalience: false still reaches the classic render', async () => {
    const out = await runColdStart({ ...base, fetchImpl: fullRoute(), ruleSalience: false });
    expect(out).toMatch(/## Agent Rules — should \(\d+\)$/m);
    expect(out).not.toMatch(/pinned, \d+ salient/);
  });

  it('boosts only when the tier ran — the escape hatch writes nothing', async () => {
    // The flag gates a WRITE as well as a render. Off must mean off on both,
    // or turning the ranking off would leave it still reinforcing a set it no
    // longer promotes.
    const frames = [];
    const route = fullRoute();
    await runColdStart({
      ...base,
      ruleSalience: false,
      fetchImpl: (u, i) => {
        if (u.endsWith('/substrate/v1/mutate')) frames.push(...Object.keys(JSON.parse(i.body)));
        return route(u, i);
      }
    });
    expect(frames).toEqual([]);
  });
});
