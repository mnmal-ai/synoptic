import { describe, expect, it } from 'vitest';
import { renderPushRow } from '../../synoptic/src/inbox-push.js';
import {
  ago,
  controlKids,
  cut,
  hostOf,
  mailCallLine,
  mailFeedText,
  mailReceivedLine,
  parseMailRow,
  parseMailSend,
  parseRemoteTurn,
  remoteTurnText,
  splitMailFeedText,
  toolSummary,
  viewTodos
} from '../src/pane-text.ts';

describe('toolSummary', () => {
  it("uses the tool's own description and never its command", () => {
    expect(toolSummary('Bash', { command: 'cat ~/.env', description: 'Run the relay tests' })).toBe(
      'Run the relay tests'
    );
    expect(toolSummary('Bash', { command: 'cat ~/.env' })).toBe('Bash');
  });
  it('names a file by its basename and a URL by its host', () => {
    expect(toolSummary('Read', { file_path: '/home/someone/repo/src/relay.ts' })).toBe('relay.ts');
    expect(toolSummary('WebFetch', { url: 'https://example.com/a?token=x' })).toBe('example.com');
  });
  it('cuts a long description', () => {
    expect(toolSummary('Agent', { description: 'x'.repeat(500) })).toHaveLength(160);
  });
});

describe('controlKids', () => {
  it('keeps only kid-shaped names', () => {
    expect(controlKids(' a-b@host-1, c_d@h2  junk ; @x ')).toEqual(['a-b@host-1', 'c_d@h2']);
    expect(controlKids('')).toEqual([]);
  });
});

describe('remoteTurnText', () => {
  it('says who sent the turn before their words', () => {
    const t = remoteTurnText('peer@host', 'run the tests');
    expect(t.startsWith('[Remote turn from peer@host')).toBe(true);
    expect(t.endsWith('\n\nrun the tests')).toBe(true);
  });
});

describe('cut', () => {
  it('trims and ellipsizes', () => {
    expect(cut('  hi  ', 10)).toBe('hi');
    expect(cut('abcdef', 4)).toBe('abc…');
  });
});

describe('hostOf', () => {
  it('takes the lowercase host of a kid, domain dropped', () => {
    expect(hostOf('peer@Host-A.local')).toBe('host-a');
    expect(hostOf('nohost')).toBe('unknown');
  });
});

describe('mail lines', () => {
  const at = new Date(2026, 10, 25, 18, 5).getTime();
  it('names number, sender, time and subject for received mail', () => {
    const line = mailReceivedLine({
      shortId: 1465,
      from: 'peer@host',
      subject: 'Re: gate green\nsecond line',
      createdAt: new Date(at).toISOString()
    });
    expect(line).toBe('Mail received #1465 · from peer@host · 18:05 · Re: gate green second line');
  });
  it('reads a send from an act sketch and from a mutate frame', () => {
    expect(
      mailCallLine(
        'mcp__substrate__act',
        { sketch: 'send AgentMessage to=peer@host subject="hi there" body="x"' },
        at
      )
    ).toBe('Mail sent · to peer@host · 18:05 · hi there');
    expect(
      mailCallLine(
        'mcp__substrate__mutate',
        {
          payload: { 'cortext/sendAgentMessage': { params: { to: ['a@h', 'b@h'], subject: 's' } } }
        },
        at
      )
    ).toBe('Mail sent · to a@h, b@h · 18:05 · s');
  });
  it('reads ack and read, and ignores other calls', () => {
    expect(mailCallLine('mcp__substrate__act', { sketch: 'ack AgentMessage #12,#13' }, at)).toBe(
      'Mail acked · #12,#13 · 18:05'
    );
    expect(mailCallLine('mcp__substrate__act', { sketch: 'close Todo #12' }, at)).toBeUndefined();
    expect(mailCallLine('Bash', { command: 'ls' }, at)).toBeUndefined();
  });
});

describe('viewTodos', () => {
  const rows = [
    {
      shortId: 1,
      title: 'Low one',
      status: 'open',
      priority: 'low',
      createdAt: '2026-11-20T00:00:00Z',
      updatedAt: '2026-11-24T00:00:00Z'
    },
    {
      shortId: 2,
      title: 'High one',
      status: 'open',
      priority: 'high',
      createdAt: '2026-11-21T00:00:00Z',
      updatedAt: '2026-11-22T00:00:00Z'
    },
    {
      shortId: 3,
      title: 'Stuck one',
      status: 'blocked',
      priority: 'medium',
      createdAt: '2026-11-22T00:00:00Z',
      updatedAt: '2026-11-23T00:00:00Z'
    }
  ];
  const base = { sort: 'priority', status: 'any', priority: 'any', search: '' };
  const ids = (view) => viewTodos(rows, { ...base, ...view }).map((t) => t.shortId);
  it('sorts by priority, recency and status', () => {
    expect(ids({})).toEqual([2, 3, 1]);
    expect(ids({ sort: 'created' })).toEqual([3, 2, 1]);
    expect(ids({ sort: 'updated' })).toEqual([1, 3, 2]);
    // Status follows the schema's order: open, in_progress, blocked, deferred, closed.
    expect(ids({ sort: 'status' })).toEqual([2, 1, 3]);
    expect(ids({ sort: 'title' })).toEqual([2, 1, 3]);
  });
  it('filters by status, priority and a title or #id search', () => {
    expect(ids({ status: 'blocked' })).toEqual([3]);
    expect(ids({ priority: 'low' })).toEqual([1]);
    expect(ids({ search: 'HIGH' })).toEqual([2]);
    expect(ids({ search: '#3' })).toEqual([3]);
  });
});

describe('ago', () => {
  it('reads seconds, minutes, hours and days', () => {
    const now = Date.parse('2026-11-25T12:00:00Z');
    expect(ago('2026-11-25T11:59:30Z', now)).toBe('30s ago');
    expect(ago('2026-11-25T11:00:00Z', now)).toBe('60m ago');
    expect(ago('2026-11-25T06:00:00Z', now)).toBe('6h ago');
    expect(ago('2026-11-20T12:00:00Z', now)).toBe('5d ago');
  });
});

describe('parseMailRow', () => {
  const m = {
    id: '0190-abc',
    shortId: 42,
    subject: 'Gate green',
    body: 'line one\n\nline three',
    inReplyTo: 'x',
    tags: null,
    from: 'peer@host',
    createdAt: '2026-11-25T18:05:00Z'
  };
  it('reads back what renderPushRow wrote', () => {
    expect(parseMailRow(renderPushRow(m, 'cortext'))).toEqual({
      shortId: 42,
      id: '0190-abc',
      from: 'peer@host',
      date: '2026-11-25',
      subject: 'Gate green',
      isReply: true,
      body: 'line one\n\nline three',
      instance: undefined
    });
  });
  it('reads the instance the sender stamped', () => {
    expect(parseMailRow(renderPushRow({ ...m, instance: 'session:1a2b3c4d' }))?.instance).toBe(
      'session:1a2b3c4d'
    );
  });
  it('reads a row with no body', () => {
    const row = parseMailRow(renderPushRow({ ...m, body: null, inReplyTo: null }));
    expect(row?.body).toBe('');
    expect(row?.isReply).toBe(false);
  });
  it('is undefined for any other text', () => {
    expect(parseMailRow('hello')).toBeUndefined();
  });
});

describe('parseMailSend', () => {
  it('reads an act sketch, quotes and escapes included', () => {
    expect(
      parseMailSend('mcp__substrate__act', {
        sketch:
          'send AgentMessage to=peer@host subject="Gate \\"green\\"" body="one\\ntwo" instance=session:1a2b3c4d'
      })
    ).toEqual({ to: 'peer@host', subject: 'Gate "green"', body: 'one\ntwo' });
  });
  it('reads a mutate frame, single or batched', () => {
    const params = { to: ['a@h', 'b@h'], subject: 's', body: 'b' };
    expect(
      parseMailSend('mcp__substrate__mutate', {
        payload: { 'cortext/sendAgentMessage': { params } }
      })
    ).toEqual({ to: 'a@h, b@h', subject: 's', body: 'b' });
    expect(
      parseMailSend('mcp__substrate__mutate', {
        payload: { 'cortext/sendAgentMessage': [{ params }] }
      })
    ).toEqual({ to: 'a@h, b@h', subject: 's', body: 'b' });
  });
  it('is undefined for any other call', () => {
    expect(parseMailSend('mcp__substrate__act', { sketch: 'close Todo #12' })).toBeUndefined();
    expect(parseMailSend('Bash', { command: 'ls' })).toBeUndefined();
  });
  it('round-trips the feed text', () => {
    expect(splitMailFeedText(mailFeedText('s', 'a\n\nb'))).toEqual({
      subject: 's',
      body: 'a\n\nb'
    });
    expect(splitMailFeedText(mailFeedText('s', ''))).toEqual({ subject: 's', body: '' });
  });
});

describe('parseRemoteTurn', () => {
  it('reads back what remoteTurnText wrote', () => {
    expect(parseRemoteTurn(remoteTurnText('peer@host', 'Hold the merge.\n\nThanks'))).toEqual({
      from: 'peer@host',
      text: 'Hold the merge.\n\nThanks'
    });
  });
  it('is undefined for a prompt someone typed here', () => {
    expect(parseRemoteTurn('Cut the release')).toBeUndefined();
  });
});
