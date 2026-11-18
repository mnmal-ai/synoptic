import { describe, expect, it } from 'vitest';
import {
  buildCheckpoint,
  type Checkpoint,
  lastRequest,
  mergeSteps,
  NEXT_ACTION,
  redact,
  renderPointer,
  renderSteps,
  resultFacts,
  resultText,
  type Step,
  saveCheckpoint
} from '../src/checkpoint.js';

const mk = (s: Partial<Step> & { call: string }): Step => ({
  brief: s.call,
  tool: s.call.split('(')[0] as string,
  hint: s.call,
  key: s.call,
  result: null,
  facts: '',
  error: false,
  count: 1,
  ...s
});

const cp: Checkpoint = {
  completed: '- read(x) → ok',
  nextAction: NEXT_ACTION,
  steps: [mk({ call: 'read(x)', result: 'ok' })],
  note: ''
};
const call = (id: string, name: string, args: object) => ({
  type: 'toolCall',
  id,
  name,
  arguments: args
});

describe('buildCheckpoint', () => {
  it('pairs each tool call with the first line of its result, and keeps the last note', () => {
    const out = buildCheckpoint([
      { role: 'user', content: 'sum them' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'starting' }, call('a', 'query', { id: 1 })]
      },
      {
        role: 'toolResult',
        toolCallId: 'a',
        content: [{ type: 'text', text: '\n42 rows\nmore' }]
      } as never,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'total so far 42' }, call('b', 'read', { p: 'f' })]
      },
      {
        role: 'toolResult',
        toolCallId: 'b',
        isError: true,
        content: [{ type: 'text', text: 'ENOENT' }]
      } as never
    ]);
    expect(out?.completed).toBe(
      '- query({"id":1}) → "42 rows"\n- read({"p":"f"}) → error "ENOENT"\nLast note: total so far 42'
    );
    expect(out?.nextAction).toBe(NEXT_ACTION);
  });

  it('lists the last 30 steps and counts the rest', () => {
    const msgs = Array.from({ length: 35 }, (_, i) => ({
      role: 'assistant',
      content: [call(String(i), 't', { n: i })]
    }));
    const lines = buildCheckpoint(msgs)?.completed.split('\n') ?? [];
    expect(lines[0]).toBe('(5 earlier steps)');
    expect(lines).toHaveLength(31);
    expect(lines[30]).toBe('- t({"n":34})');
  });

  it('is null with no step and no note', () => {
    expect(buildCheckpoint([{ role: 'user', content: 'hi' }])).toBeNull();
  });
});

describe('redact', () => {
  it('masks secret-shaped text and secret-named arguments', () => {
    expect(redact('curl -H "Authorization: Bearer abc.def" x')).not.toContain('abc.def');
    expect(redact('use ghp_abcdefghijklmnop now')).toBe('use [redacted] now');
    expect(redact('API_TOKEN=s3cr3t ok')).toBe('API_TOKEN=[redacted] ok');
    expect(redact('-H "X: Basic not-a-credential"')).toBe('-H "X: Basic [redacted]"');
    expect(redact('git clone https://me:pw@host/r')).toBe('git clone https://[redacted]@host/r');
    expect(redact('curl -u me:pw x')).toBe('curl -u [redacted] x');
    const escaped = buildCheckpoint([
      { role: 'assistant', content: [call('a', 'bash', { cmd: 'export API_TOKEN="abc def"' })] }
    ]);
    expect(escaped?.completed).not.toContain('abc');
    const keys = buildCheckpoint([
      {
        role: 'assistant',
        content: [
          call('a', 'w', {
            accessToken: 'x1',
            OAUTHTOKEN: 'x2',
            authoredBy: 'me',
            tokensBefore: 5,
            tokens: ['raw'],
            key: 'k'
          })
        ]
      }
    ]);
    expect(keys?.completed).toBe(
      '- w({"accessToken":"[redacted]","OAUTHTOKEN":"[redacted]","authoredBy":"me","tokensBefore":5,"tokens":"[redacted]","key":"k"})'
    );
    const out = buildCheckpoint([
      { role: 'assistant', content: [call('a', 'login', { user: 'u', password: 'hunter2' })] }
    ]);
    expect(out?.completed).toBe('- login({"user":"u","password":"[redacted]"})');
  });
});

describe('step brief', () => {
  it('names the tool without its server prefix and lists the argument values', () => {
    const out = buildCheckpoint([
      {
        role: 'assistant',
        content: [
          call('a', 'mcp__substrate__query', {
            i: 'log 1202',
            where: { shortId: { eq: 1202 } },
            password: 'p'
          })
        ]
      }
    ]);
    expect(out?.steps[0]?.brief).toBe('query(log 1202, 1202, [redacted])');
  });
});

describe('lastRequest', () => {
  it('takes the newest user message on the branch', () => {
    const user = (text: string) => ({ type: 'message', message: { role: 'user', content: text } });
    expect(lastRequest([user('first'), { type: 'compaction' }, user('second')])).toBe('second');
    expect(
      lastRequest([{ type: 'message', message: { role: 'assistant', content: 'x' } }])
    ).toBeNull();
  });
});

/** A fake Substrate answering by frame key. */
function server(answer: (key: string, params: Record<string, unknown>) => object) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const [key, frame] = Object.entries(JSON.parse(init.body))[0] as [
      string,
      { params: Record<string, unknown> }
    ];
    calls.push(key);
    return new Response(JSON.stringify(answer(key, frame.params)));
  }) as unknown as typeof fetch;
  return {
    calls,
    access: { substrateUrl: 'http://s', namespace: 'cortext', project: 'p', fetchImpl }
  };
}

describe('saveCheckpoint', () => {
  it('creates the Task, then writes revision one above the latest', async () => {
    const s = server((key, params) => {
      if (key === 'cortext/createTask') expect(params.status).toBe('paused');
      if (key === 'cortext/createTask')
        return { data: { [key]: { id: 'u1', shortId: 7, title: params.title } } };
      if (key === 'cortext/ExecutionCheckpoint') return { data: { [key]: [{ revision: 2 }] } };
      return { data: { [key]: { id: 'c1' } } };
    });
    expect(await saveCheckpoint(s.access, null, cp, 'T')).toEqual({
      task: { id: 'u1', shortId: 7, title: 'T' },
      revision: 3
    });
  });

  it('re-reads once on unique_violation, and is null on any other refusal', async () => {
    let latest = 0;
    let refuse = 'unique_violation';
    const s = server((key) => {
      if (key === 'cortext/ExecutionCheckpoint')
        return { data: { [key]: [{ revision: latest++ }] } };
      if (refuse === 'unique_violation' && latest === 1)
        return { data: {}, errors: [{ code: refuse, message: 'dup', path: [key] }] };
      if (refuse === 'forbidden')
        return { data: {}, errors: [{ code: refuse, message: 'no', path: [key] }] };
      return { data: { [key]: { id: 'c' } } };
    });
    const task = { id: 'u1', shortId: 7, title: 'T' };
    expect((await saveCheckpoint(s.access, task, cp, 'f'))?.revision).toBe(2);
    refuse = 'forbidden';
    expect(await saveCheckpoint(s.access, task, cp, 'f')).toBeNull();
  });
});

describe('renderPointer', () => {
  it('carries the request, every step so far and the last note', () => {
    const out = renderPointer(
      { id: 'u1', shortId: 7, title: 'T' },
      3,
      'sum them',
      [mk({ call: 'a()', result: '1' }), mk({ call: 'b()', count: 2 })],
      'half way'
    );
    expect(out).toContain('(saved as Task #7, revision 3)');
    expect(out).toContain('Request: sum them');
    expect(out).toContain('Steps done so far: 2 distinct (3 calls;');
    expect(out).toContain('- a() → "1"\n- b()\nLast note: half way');
    expect(out).toContain(`Next: ${NEXT_ACTION}`);
  });
});

/** A substrate MCP query result as it really arrives: the envelope on one line. */
const envelope = (id: number) =>
  JSON.stringify({
    schemaVersion: '19bb7e12f068',
    data: {
      'cortext/SessionLog': [
        {
          shortId: id,
          startedAt: '2026-10-25T00:00:00Z',
          decisionsCount: id % 3,
          summary: `Opened PR #85 for the thing ${'and more '.repeat(20)}`
        }
      ]
    },
    shapes: { 'cortext/SessionLog': 'list' }
  });

describe('resultText', () => {
  it('flattens a JSON envelope to its leaves, short values first', () => {
    expect(resultText(envelope(1202))).toBe(
      'shortId=1202 decisionsCount=2 startedAt=2026-10-25T00:00:00Z summary=Opened PR #85 for the thing and more an…'
    );
  });
  it('masks secret-named keys and keeps plain text to its first line', () => {
    expect(resultText('{"user":"u","apiToken":"t"}')).toBe('user=u apiToken=[redacted]');
    expect(resultText('\nfirst\nsecond')).toBe('first');
    expect(resultText('42')).toBe('42');
  });
});

describe('mergeSteps', () => {
  it('folds a repeated call into its step, keeping its place and the latest result', () => {
    const merged = mergeSteps(
      [mk({ call: 'q(1)', result: 'old' }), mk({ call: 'q(2)', result: 'x' })],
      [mk({ call: 'q(1)', result: 'new' }), mk({ call: 'q(3)' }), mk({ call: 'q(1)' })]
    );
    expect(merged.map((s) => [s.call, s.result, s.count])).toEqual([
      ['q(1)', 'new', 3],
      ['q(2)', 'x', 1],
      ['q(3)', null, 1]
    ]);
  });
  it('dedupes calls whose only difference is the reworded intent', () => {
    const out = buildCheckpoint([
      {
        role: 'assistant',
        content: [
          call('a', 'query', { i: 'Reading log 7', id: 7 }),
          call('b', 'query', { i: 'Re-reading SessionLog 7', id: 7 })
        ]
      }
    ]);
    expect(out?.steps).toHaveLength(1);
    expect(out?.steps[0]?.count).toBe(2);
  });

  it('keeps a result attributable when it omits its key: the intent rides as the hint', () => {
    const out = buildCheckpoint([
      {
        role: 'assistant',
        content: [call('a', 'query', { i: 'SessionLog 1241 decisions', id: 1241 })]
      },
      {
        role: 'toolResult',
        toolCallId: 'a',
        content: [{ type: 'text', text: '{"decisionsCount":0}' }]
      } as never
    ]);
    const lines = renderSteps([
      ...(out?.steps ?? []),
      ...Array.from({ length: 5 }, (_, n) => mk({ call: `x(${n})` }))
    ]);
    expect(lines[0]).toBe('- query(SessionLog 1241 decisions) → "decisionsCount=0"');
  });

  it('dedupes within one compaction too', () => {
    const out = buildCheckpoint([
      { role: 'assistant', content: [call('a', 'read', { p: 1 }), call('b', 'read', { p: 1 })] }
    ]);
    expect(out?.steps).toHaveLength(1);
    expect(out?.steps[0]?.count).toBe(2);
  });
});

describe('renderSteps', () => {
  const step = (i: number) =>
    mk({
      call: `query(${JSON.stringify({ i: `Reading session log ${i}`, pad: 'x'.repeat(120) })})`,
      brief: `query(Reading session log ${i}, ${'x'.repeat(120)})`,
      tool: 'query',
      hint: `Reading session log ${i}`,
      result: resultText(envelope(i)),
      facts: resultFacts(envelope(i))
    });
  it('lists 48 real-shaped reads whole: older ones as their facts', () => {
    const out = renderSteps(Array.from({ length: 48 }, (_, i) => step(1200 + i)));
    expect(out).toHaveLength(48);
    expect(out[0]).toBe('- query(Reading session log 1200) → "shortId=1200 decisionsCount=0"');
    expect(out.at(-1)).toContain('Reading session log 1247');
    expect(out.join('\n').length).toBeLessThan(4600);
  });
  it('drops the oldest only past the budget, and says where the list starts', () => {
    const out = renderSteps(Array.from({ length: 300 }, (_, i) => step(i)));
    expect(out[0]).toMatch(
      /^\(\d+ earliest steps not listed; first listed: query\(Reading session log \d+, x+…\)$/
    );
    expect(out.join('\n').length).toBeLessThan(5700);
  });
  it('lists everything when it fits', () => {
    expect(renderSteps([mk({ call: 'a', result: 'b', error: true })])).toEqual(['- a → error "b"']);
  });
});
