import { describe, expect, it } from 'vitest';
import {
  buildCheckpoint,
  type Checkpoint,
  lastRequest,
  NEXT_ACTION,
  redact,
  renderPointer,
  renderSteps,
  saveCheckpoint
} from '../src/checkpoint.js';

const cp: Checkpoint = {
  completed: '- read(x) → ok',
  nextAction: NEXT_ACTION,
  steps: [{ call: 'read(x)', brief: 'read(x)', result: 'ok', error: false }],
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
      content: [call(String(i), 't', { i })]
    }));
    const lines = buildCheckpoint(msgs)?.completed.split('\n') ?? [];
    expect(lines[0]).toBe('(5 earlier steps)');
    expect(lines).toHaveLength(31);
    expect(lines[30]).toBe('- t({"i":34})');
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
      [
        { call: 'a()', brief: 'a()', result: '1', error: false },
        { call: 'b()', brief: 'b()', result: null, error: false }
      ],
      'half way'
    );
    expect(out).toContain('(saved as Task #7, revision 3)');
    expect(out).toContain('Request: sum them');
    expect(out).toContain('Steps done so far: 2');
    expect(out).toContain('- a() → "1"\n- b()\nLast note: half way');
    expect(out).toContain(`Next: ${NEXT_ACTION}`);
  });
});

describe('renderSteps', () => {
  const step = (i: number) => ({
    call: `query(${JSON.stringify({ i: `Reading session log ${i}`, pad: 'x'.repeat(120) })})`,
    brief: `query(Reading session log ${i}, ${'x'.repeat(120)})`,
    result: `{"decisionsCount":${i % 3},"pad":"${'y'.repeat(150)}"}`,
    error: false
  });
  it('keeps the newest whole, keeps older outcomes, and counts what the budget drops', () => {
    const all = Array.from({ length: 200 }, (_, i) => step(i));
    const out = renderSteps(all);
    expect(out[0]).toMatch(/^\(\d+ earliest steps not listed\)$/);
    expect(out.at(-1)).toContain('Reading session log 199');
    expect(out.at(-6)).toMatch(
      /^- query\(Reading session log 194, x+… → "\{\\"decisionsCount\\":\d/
    );
    expect(out.join('\n').length).toBeLessThan(4600);
  });
  it('lists everything when it fits', () => {
    expect(renderSteps([{ call: 'a', brief: 'a', result: 'b', error: true }])).toEqual([
      '- a → error "b"'
    ]);
  });
});
