import type { EngineInterface, RenderElement } from 'claude-code';
import { BRAND, tint } from './brand.js';
import { el } from './el.js';
import { icon } from './icons.js';
import { cut } from './pane-text.js';

// How a mail card looks, on every site that draws one: no engine state, so the Remote session
// pane, the transcript hooks and a demo can all draw it. Received mail is cyan, sent magenta.

const PREVIEW_MAX = 140;

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
      ? el(Svg, {
          source: icon(name, hex, size),
          alt: m.dir === 'in' ? 'Received mail' : 'Sent mail',
          width: size,
          height: size
        })
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
      // Received: an envelope with a down arrow; sent: one with an up arrow.
      mark(m.dir === 'in' ? 'mail-down' : 'mail-up', m.dir === 'in' ? '✉↓' : '✉↑', 18),
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
