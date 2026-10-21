import { describe, expect, it } from 'vitest';
import {
  createProjectionAudit,
  frameErrors,
  unansweredFrames,
  unexpectedProjections,
  unknownEverywhere
} from '../src/projection-audit.js';
import { substrateQuery } from '../src/substrate-http.js';

// The four diagnostics a real cold-start produces. Three of them are the union
// projection in recall-scoring working as designed; the fourth is the legacy
// `intent` fallback in anchor.js. NONE of these four should reach a human.
const LIVE = {
  AnchorIntent: ['intent'],
  Memory: ['topic', 'choice', 'status', 'branch', 'summary'],
  Decision: ['name', 'type', 'description', 'body', 'branch', 'summary'],
  SessionLog: ['name', 'type', 'description', 'topic', 'choice', 'status']
};
const HANDLE_FIELDS = [
  'name',
  'type',
  'description',
  'body',
  'topic',
  'choice',
  'status',
  'branch',
  'summary'
];

function envelope(diagnostics) {
  return { data: {}, _diagnostics: diagnostics };
}

describe('unexpectedProjections', () => {
  it('returns nothing when the envelope carries no sidecar (pre-5.2.0 substrate)', () => {
    expect(unexpectedProjections({ data: {} }, [])).toEqual([]);
    expect(unexpectedProjections(null, [])).toEqual([]);
  });

  it('reports a field the call site did not declare', () => {
    const res = unexpectedProjections(
      envelope({ 'cortext/AnchorIntent': { unknownProjectionFields: ['intent', 'nmae'] } }),
      ['intent']
    );
    expect(res).toEqual([{ key: 'cortext/AnchorIntent', fields: ['nmae'] }]);
  });

  it('is silent on the live cold-start diagnostics once each site declares its own', () => {
    // anchor.js declares ['intent']; recall-scoring declares HANDLE_FIELDS.
    expect(
      unexpectedProjections(
        envelope({ 'cortext/AnchorIntent': { unknownProjectionFields: LIVE.AnchorIntent } }),
        ['intent']
      )
    ).toEqual([]);
    for (const type of ['Memory', 'Decision', 'SessionLog']) {
      expect(
        unexpectedProjections(
          envelope({ [`cortext/${type}`]: { unknownProjectionFields: LIVE[type] } }),
          HANDLE_FIELDS
        )
      ).toEqual([]);
    }
  });

  it('tolerates a malformed sidecar rather than throwing into the cold-start', () => {
    expect(
      unexpectedProjections(envelope({ 'cortext/X': { unknownProjectionFields: 'no' } }), [])
    ).toEqual([]);
    expect(unexpectedProjections(envelope('not-an-object'), [])).toEqual([]);
  });
});

describe('unknownEverywhere', () => {
  it('is empty on the live union projection — every field is declared by some type', () => {
    // This is the assertion that makes the HANDLE_FIELDS allowlist safe. If it
    // ever fails, the allowlist has started hiding a real rename.
    const observed = ['Memory', 'Decision', 'SessionLog'].map((t) => ({
      key: `cortext/${t}`,
      unknown: LIVE[t]
    }));
    expect(unknownEverywhere(observed)).toEqual([]);
  });

  it('catches a field that went missing on EVERY type — the case the allowlist cannot', () => {
    // `summary` is renamed server-side: it disappears from SessionLog too, so
    // it is now unknown on all three. It is IN HANDLE_FIELDS, so the per-call
    // allowlist stays silent and only this check speaks.
    const observed = [
      { key: 'cortext/Memory', unknown: LIVE.Memory },
      { key: 'cortext/Decision', unknown: LIVE.Decision },
      { key: 'cortext/SessionLog', unknown: [...LIVE.SessionLog, 'summary'] }
    ];
    expect(unknownEverywhere(observed)).toEqual(['summary']);
    for (const o of observed) {
      expect(
        unexpectedProjections(
          envelope({ [o.key]: { unknownProjectionFields: o.unknown } }),
          HANDLE_FIELDS
        )
      ).toEqual([]);
    }
  });

  it('refuses to guess from a single type', () => {
    // One type cannot distinguish "this type does not have it" from "nobody
    // has it" — that is exactly what expectUnknown exists for.
    expect(unknownEverywhere([{ key: 'cortext/Memory', unknown: ['topic'] }])).toEqual([]);
    expect(unknownEverywhere([])).toEqual([]);
  });
});

describe('createProjectionAudit', () => {
  it('renders NOTHING when clean — the normal case, and the point of the design', () => {
    const audit = createProjectionAudit();
    audit.record([]);
    audit.recordEverywhere([]);
    expect(audit.render()).toBe('');
  });

  it('dedupes repeats and renders one comment', () => {
    const audit = createProjectionAudit();
    audit.record([{ key: 'cortext/Memory', fields: ['nmae'] }]);
    audit.record([{ key: 'cortext/Memory', fields: ['nmae', 'titel'] }]);
    audit.recordEverywhere(['summary']);
    const out = audit.render();
    expect(out).toMatch(/^<!-- projection drift: /);
    expect(out).toContain('cortext/Memory: nmae, titel');
    expect(out).toContain('(all recall types): summary');
    expect(out.match(/nmae/g)).toHaveLength(1);
    // One line, comment-wrapped, so it cannot break the injected markdown.
    expect(out.trimEnd().endsWith('-->')).toBe(true);
  });
});

describe('substrateQuery integration', () => {
  const url = 'http://h';
  function fetchReturning(body) {
    return async () => new Response(JSON.stringify(body), { status: 200 });
  }

  it('still returns data unchanged — the sidecar must not alter the read', async () => {
    const data = await substrateQuery(
      url,
      {},
      {
        fetchImpl: fetchReturning({
          data: { 'cortext/Memory': [{ id: 'a' }] },
          _diagnostics: { 'cortext/Memory': { unknownProjectionFields: ['nmae'] } }
        })
      }
    );
    expect(data).toEqual({ 'cortext/Memory': [{ id: 'a' }] });
  });

  it('calls the sink only with the residue', async () => {
    const seen = [];
    await substrateQuery(
      url,
      {},
      {
        fetchImpl: fetchReturning({
          data: {},
          _diagnostics: { 'cortext/AnchorIntent': { unknownProjectionFields: ['intent', 'nmae'] } }
        }),
        expectUnknown: ['intent'],
        onUnexpectedProjection: (e) => seen.push(...e)
      }
    );
    expect(seen).toEqual([{ key: 'cortext/AnchorIntent', fields: ['nmae'] }]);
  });

  it('does not call the sink at all when the residue is empty', async () => {
    let called = 0;
    await substrateQuery(
      url,
      {},
      {
        fetchImpl: fetchReturning({
          data: {},
          _diagnostics: { 'cortext/AnchorIntent': { unknownProjectionFields: ['intent'] } }
        }),
        expectUnknown: ['intent'],
        onUnexpectedProjection: () => called++
      }
    );
    expect(called).toBe(0);
  });

  it('a throwing sink cannot break the read', async () => {
    const data = await substrateQuery(
      url,
      {},
      {
        fetchImpl: fetchReturning({
          data: { 'cortext/Memory': [] },
          _diagnostics: { 'cortext/Memory': { unknownProjectionFields: ['x'] } }
        }),
        onUnexpectedProjection: () => {
          throw new Error('sink exploded');
        }
      }
    );
    expect(data).toEqual({ 'cortext/Memory': [] });
  });
});

// --- frame errors ------------------------------------------------------------

describe('frameErrors', () => {
  it('reads a frame-scoped rejection, keyed by path[0]', () => {
    expect(
      frameErrors({
        data: { 'cortext/Todo': [] },
        errors: [
          {
            message: 'each orderBy entry must have exactly one field',
            path: ['cortext/Decision', 'orderBy', '0'],
            code: 'type_mismatch'
          }
        ]
      })
    ).toEqual([
      {
        key: 'cortext/Decision',
        code: 'type_mismatch',
        message: 'each orderBy entry must have exactly one field'
      }
    ]);
  });

  it('files an error with no frame path under (request)', () => {
    expect(frameErrors({ errors: [{ message: 'boom' }] })).toEqual([
      { key: '(request)', code: 'error', message: 'boom' }
    ]);
  });

  it('is empty on a clean envelope and on junk', () => {
    expect(frameErrors({ data: {} })).toEqual([]);
    expect(frameErrors({ errors: 'nope' })).toEqual([]);
    expect(frameErrors(null)).toEqual([]);
  });
});

describe('unansweredFrames', () => {
  it('names a key that was asked for and did not come back', () => {
    // The server's shape: HTTP 200, the rejected key ABSENT
    // from `data` rather than present-and-empty, which is what makes
    // `data[key] ?? []` read as a true negative.
    const payload = { 'cortext/Decision': {}, 'cortext/Todo': {} };
    expect(unansweredFrames(payload, { data: { 'cortext/Todo': [] } })).toEqual([
      'cortext/Decision'
    ]);
  });

  it('treats a present-but-empty answer as answered — [] is a real result', () => {
    const payload = { 'cortext/Todo': {} };
    expect(unansweredFrames(payload, { data: { 'cortext/Todo': [] } })).toEqual([]);
  });

  it('catches a dropped frame even when the envelope carries NO error', () => {
    // This is the half `errors` cannot give you:
    // a silently-absent key with an empty errors array still gets reported.
    const payload = { 'cortext/Memory': {} };
    expect(unansweredFrames(payload, { data: {}, errors: [] })).toEqual(['cortext/Memory']);
  });
});

describe('createProjectionAudit — failures', () => {
  it('renders a LOUD notice, not an HTML comment — a missing section is not a footnote', () => {
    const audit = createProjectionAudit();
    audit.recordFailure('cortext/Todo', 'type_mismatch: bad orderBy');
    const out = audit.render();
    expect(out).toContain('Cold-start is INCOMPLETE');
    expect(out).toContain('cortext/Todo — type_mismatch: bad orderBy');
    // Must NOT be comment-wrapped: projection drift is a footnote for whoever
    // maintains the projections, a dropped frame is a warning to the reader
    // that what follows is not the whole picture.
    expect(out.startsWith('<!--')).toBe(false);
    expect(out).toMatch(/^> ⚠️/);
  });

  it('keeps the server reason over the inferred one for the same key', () => {
    const audit = createProjectionAudit();
    audit.recordFailure('cortext/Todo', 'type_mismatch: bad orderBy');
    audit.recordFailure('cortext/Todo', 'requested but absent from `data`, with no error given');
    expect(audit.render()).toContain('type_mismatch: bad orderBy');
    expect(audit.render()).not.toContain('with no error given');
  });

  it('still renders nothing when clean', () => {
    expect(createProjectionAudit().render()).toBe('');
  });
});

describe('substrateQuery — frame failures', () => {
  it('reports the server error AND does not double-report via the absent-key check', async () => {
    const seen = [];
    await substrateQuery(
      'http://h',
      { 'cortext/Decision': {}, 'cortext/Todo': {} },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: { 'cortext/Todo': [] },
              errors: [{ message: 'bad', code: 'type_mismatch', path: ['cortext/Decision'] }]
            }),
            { status: 200 }
          ),
        onFrameFailure: (k, d) => seen.push([k, d])
      }
    );
    // Both checks fire for the same key by design — the collector dedupes and
    // keeps the server's reason. Asserting both here documents that overlap.
    expect(seen.map(([k]) => k)).toEqual(['cortext/Decision', 'cortext/Decision']);
    expect(seen[0][1]).toBe('type_mismatch: bad');
  });

  it('says nothing when every requested frame comes back', async () => {
    let called = 0;
    await substrateQuery(
      'http://h',
      { 'cortext/Todo': {} },
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: { 'cortext/Todo': [] } }), { status: 200 }),
        onFrameFailure: () => called++
      }
    );
    expect(called).toBe(0);
  });
});
