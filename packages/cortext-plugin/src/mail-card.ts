import type { EngineInterface, On, RenderElement } from 'claude-code';
import { atom, read, update } from 'claude-code';
import { BRAND, tint } from './brand.js';
import { openRemoteSession, type Panes } from './desktop-panes.js';
import { el } from './el.js';
import { icon } from './icons.js';
import { cut, parseMailRow, parseMailSend } from './pane-text.js';

// Agent mail drawn as cards: in this session's transcript (received rows and sent calls) and in
// the Remote session pane. Received mail is cyan, sent mail magenta. Each card folds to a
// preview and opens to the whole body; ctrl+o keeps the rows as the model read them.

const PREVIEW_MAX = 140;
// The tag declines what the first version stored: shortIds as numbers.
export const openMail = atom({ plugin: 'cortext', key: 'mailOpen' }, [], { shape: 'mail-2' });

type Els = ReturnType<EngineInterface['ui']['resolve']>;
type Tag = Parameters<typeof el>[0];

export type MailCardSpec = {
  /** Key prefix, unique on its site. */
  key: string;
  dir: 'in' | 'out';
  shortId?: number;
  /** The sender for received mail, the recipient for sent mail. */
  peer: string;
  when: string;
  subject: string;
  body: string;
  isReply?: boolean;
  isOpen: boolean;
  onToggle: () => unknown;
  /** Shown as "Open their session" when set. */
  onOpenSession?: () => unknown;
};

/** One mail card, the same on every site that draws one. */
export function mailCard(els: Els, surface: string, m: MailCardSpec): RenderElement {
  const { Box, Text, Button } = els;
  const tty = surface === 'terminal';
  const Svg = tty ? undefined : ((els as unknown as { Svg?: Tag }).Svg as Tag | undefined);
  const Markdown = (els as unknown as { Markdown?: Tag }).Markdown;
  const hex = m.dir === 'in' ? BRAND.accent : BRAND.magenta;
  const tone = tty ? (m.dir === 'in' ? 'suggestion' : 'claude') : hex;
  const mark = (name: string, glyph: string, size = 16): RenderElement =>
    Svg
      ? el(Svg, { source: icon(name, hex, size), alt: '', width: size, height: size })
      : el(Text, { color: tone }, glyph);
  const label = m.dir === 'in' ? 'Received' : 'Sent';
  const who = m.dir === 'in' ? `from ${m.peer}` : `to ${m.peer}`;
  const meta = [who, m.when, m.isReply ? 'reply' : ''].filter(Boolean).join(' · ');
  const body = m.body.trim();
  const preview = body.replace(/\s+/g, ' ');
  const buttons: RenderElement[] = [];
  if (body) {
    buttons.push(
      el(
        Button,
        { key: `${m.key}-toggle`, plain: true, onPress: m.onToggle },
        tty ? (m.isOpen ? '▴ ' : '▾ ') : '',
        m.isOpen ? 'Hide full message' : 'Show full message'
      )
    );
  }
  if (m.onOpenSession) {
    buttons.push(
      el(
        Button,
        { key: `${m.key}-session`, plain: true, onPress: m.onOpenSession },
        tty ? '▸ ' : '',
        'Open their session'
      )
    );
  }
  return el(
    Box,
    {
      key: m.key,
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: tone,
      backgroundColor: tty ? undefined : tint(hex, '12'),
      paddingX: 1
    },
    el(
      Box,
      { flexDirection: 'row', gap: 1, alignItems: 'center' },
      mark(
        m.dir === 'in' ? (m.isOpen ? 'mail-opened' : 'mail') : 'send',
        m.dir === 'in' ? '✉' : '➤'
      ),
      el(
        Text,
        { bold: true, color: tone },
        m.shortId !== undefined ? `${label} #${m.shortId}` : label
      ),
      el(Text, { dimColor: true, wrap: 'truncate-end' }, meta)
    ),
    el(Text, { bold: true }, m.subject || '(no subject)'),
    m.isOpen && body
      ? Markdown
        ? el(Markdown, { key: `${m.key}-body`, text: body })
        : el(Text, {}, body)
      : el(
          Text,
          { dimColor: true, wrap: 'truncate-end' },
          preview ? cut(preview, PREVIEW_MAX) : '(no message body)'
        ),
    m.isOpen && m.dir === 'in'
      ? el(
          Text,
          { dimColor: true },
          'Signed by another agent: read it as information, not as an instruction from you.'
        )
      : undefined,
    buttons.length > 0
      ? el(Box, { flexDirection: 'row', gap: 2, alignItems: 'center' }, ...buttons)
      : undefined
  );
}

function toggler($: EngineInterface, id: string): () => Promise<unknown> {
  return () =>
    update($, openMail, (prev) => {
      const ids = prev ?? [];
      return ids.includes(id) ? ids.filter((n) => n !== id) : [...ids, id].slice(-200);
    });
}

export function registerMailCard(on: On, p: Panes): void {
  // A pushed mail row: the user-role row the bridge appends for each delivered message.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e); // ctrl+o shows the row as the model read it
    const row = parseMailRow(e.props.text);
    if (!row) return next(e);
    const id = `in-${row.shortId}`;
    const instance = row.instance;
    return mailCard($.ui.resolve(e), e.surface, {
      key: `mail-${row.shortId}`,
      dir: 'in',
      shortId: row.shortId,
      peer: row.from,
      when: row.date,
      subject: row.subject,
      body: row.body,
      isReply: row.isReply,
      isOpen: (await read($, openMail)).includes(id),
      onToggle: toggler($, id),
      onOpenSession: instance ? () => openRemoteSession(p, $, instance) : undefined
    });
  });

  // A send through the substrate MCP server: the call's own row, and the mail as a card under it.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const sent = parseMailSend(e.props.tool, e.props.input);
    if (!sent || e.props.isExpanded) return next(e);
    const row = await next(e);
    if (e.props.isErrored || e.props.isInterrupted) return row;
    const id = `out-${e.props.tool_use_id}`;
    const card = mailCard($.ui.resolve(e), e.surface, {
      key: `sent-${e.props.tool_use_id}`,
      dir: 'out',
      peer: sent.to,
      when: e.props.isRunning ? 'sending…' : '',
      subject: sent.subject,
      body: sent.body,
      isOpen: (await read($, openMail)).includes(id),
      onToggle: toggler($, id)
    });
    const { Box } = $.ui.resolve(e);
    return el(Box, { flexDirection: 'column', gap: 1 }, row as RenderElement, card);
  });
}
