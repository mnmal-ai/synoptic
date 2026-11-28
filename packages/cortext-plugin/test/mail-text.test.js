import { describe, expect, it } from 'vitest';
import { renderPushRow } from '../../synoptic/src/inbox-push.js';
import { mailCallLine, parseMailRow, parseMailSend } from '../src/mail-text.ts';

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
      body: 'line one\n\nline three'
    });
  });
  it('reads back relayed mail with the relaying server', () => {
    const row = parseMailRow(
      renderPushRow(
        {
          ...m,
          from: 'agent-b@host-b.example',
          external: { domain: 'peer.example.net', relayKid: 'k' }
        },
        'cortext'
      )
    );
    expect(row).toMatchObject({
      shortId: 42,
      from: 'agent-b@host-b.example',
      via: 'peer.example.net',
      date: '2026-11-25',
      subject: 'Gate green'
    });
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
});

describe('mailCallLine', () => {
  const at = new Date(2026, 10, 25, 18, 5).getTime();
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
