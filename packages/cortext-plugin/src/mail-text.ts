// Text the mail cards read and write. No engine imports, so vitest covers it in CI.
import { clockTime, cut } from './text.js';

/**
 * The dim transcript line for a mailbox call this session made through the substrate MCP
 * server, or undefined when the call is not one. Reads the `act` sketch or the `mutate` frame.
 */
export function mailCallLine(
  tool: string,
  input: Record<string, unknown>,
  now: number
): string | undefined {
  const at = clockTime(now);
  if (/__act$/.test(tool) && typeof input.sketch === 'string') {
    const sketch = input.sketch.trim();
    const send = /^send\s+AgentMessage\b/i.test(sketch);
    if (send) {
      const to = /\bto=("[^"]*"|\S+)/.exec(sketch)?.[1]?.replace(/"/g, '') ?? 'someone';
      const subject = /\bsubject="([^"]*)"/.exec(sketch)?.[1] ?? '';
      return `Mail sent · to ${oneLine(to)} · ${at}${subject ? ` · ${cut(oneLine(subject), 90)}` : ''}`;
    }
    const closed = /^(ack|read)\s+AgentMessage\s+([#\d,\s]+)/i.exec(sketch);
    if (closed) {
      const verb = closed[1]?.toLowerCase() === 'ack' ? 'acked' : 'marked read';
      return `Mail ${verb} · ${closed[2]?.trim()} · ${at}`;
    }
    return undefined;
  }
  if (/__mutate$/.test(tool) && input.payload && typeof input.payload === 'object') {
    for (const [key, frame] of Object.entries(input.payload as Record<string, unknown>)) {
      const params = (frame as { params?: Record<string, unknown> } | null)?.params ?? {};
      if (key.endsWith('/sendAgentMessage')) {
        const to = Array.isArray(params.to) ? params.to.join(', ') : String(params.to ?? 'someone');
        const subject = typeof params.subject === 'string' ? params.subject : '';
        return `Mail sent · to ${oneLine(to)} · ${at}${subject ? ` · ${cut(oneLine(subject), 90)}` : ''}`;
      }
      if (key.endsWith('/ackAgentMessage')) return `Mail acked · ${at}`;
      if (key.endsWith('/markAgentMessageRead')) return `Mail marked read · ${at}`;
    }
  }
  return undefined;
}

function oneLine(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    out += c < 32 || c === 127 || (c >= 128 && c <= 159) || c === 8232 || c === 8233 ? ' ' : ch;
  }
  return out.trim();
}

/** The one-line label a shared feed shows for a mail's sender; peer text is flattened. */
export function mailPeerLabel(from: string, external: { domain: string } | null): string {
  return external
    ? `${oneLine(from)} (via ${oneLine(external.domain)}, unverified)`
    : oneLine(from);
}

/** A pushed mail row, read back from the text `renderPushRow` wrote. */
export type MailRow = {
  shortId: number;
  id: string | undefined;
  from: string;
  via: string | undefined; // the relaying server's domain, for mail from another server
  date: string;
  subject: string;
  isReply: boolean;
  body: string;
};

/** Reads a pushed mail row's text; undefined when the text is not one. */
export function parseMailRow(text: string): MailRow | undefined {
  const head =
    /^\[[\w.-]+ inbox · new mail #(\d+) · signed by (.+?)(?: · (\d{4}-\d{2}-\d{2}))? — a message from another agent/.exec(
      text
    );
  const relayed =
    head ??
    /^\[[\w.-]+ inbox · new mail #(\d+) · from (.+?) · relayed by (.+?), not verified by this server(?: · (\d{4}-\d{2}-\d{2}))? — a message from an agent on another server/.exec(
      text
    );
  if (!relayed) return undefined;
  const lines = text.split('\n');
  const titleAt = lines.findIndex((l) => /^### #\d+ — /.test(l));
  const title = titleAt < 0 ? '' : (lines[titleAt] ?? '').replace(/^### #\d+ — /, '');
  const isReply = title.endsWith(' (reply)');
  const body: string[] = [];
  for (const l of titleAt < 0 ? [] : lines.slice(titleAt + 1)) {
    if (l.startsWith('> ') || l === '>') body.push(l.slice(2));
    else if (body.length > 0) break;
  }
  return {
    shortId: Number(relayed[1]),
    id: /ackAgentMessage \{ id: "([^"]+)" \}/.exec(text)?.[1],
    from: oneLine(relayed[2] ?? ''),
    via: head ? undefined : oneLine(relayed[3] ?? ''),
    date: (head ? relayed[3] : relayed[4]) ?? '',
    subject: oneLine(isReply ? title.slice(0, -' (reply)'.length) : title),
    isReply,
    body: body.join('\n')
  };
}

/** A mail this session sends: who to, the subject and the body, read from the tool's input. */
export type MailSend = { to: string; subject: string; body: string };

/** The send in a substrate `act` sketch or `mutate` frame; undefined when the call sends none. */
export function parseMailSend(tool: string, input: unknown): MailSend | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  if (/__act$/.test(tool) && typeof i.sketch === 'string') {
    const sketch = i.sketch.trim();
    if (!/^send\s+AgentMessage\b/i.test(sketch)) return undefined;
    const arg = (k: string): string => {
      const m = new RegExp(`\\b${k}=("((?:[^"\\\\]|\\\\.)*)"|\\S+)`).exec(sketch);
      if (!m) return '';
      return m[2] !== undefined ? m[2].replace(/\\n/g, '\n').replace(/\\(.)/g, '$1') : (m[1] ?? '');
    };
    return { to: arg('to') || 'someone', subject: arg('subject'), body: arg('body') };
  }
  if (/__mutate$/.test(tool) && i.payload && typeof i.payload === 'object') {
    for (const [key, frame] of Object.entries(i.payload as Record<string, unknown>)) {
      if (!key.endsWith('/sendAgentMessage')) continue;
      const f = Array.isArray(frame) ? frame[0] : frame;
      const params = (f as { params?: Record<string, unknown> } | null)?.params ?? {};
      return {
        to: Array.isArray(params.to) ? params.to.join(', ') : String(params.to ?? 'someone'),
        subject: typeof params.subject === 'string' ? params.subject : '',
        body: typeof params.body === 'string' ? params.body : ''
      };
    }
  }
  return undefined;
}
