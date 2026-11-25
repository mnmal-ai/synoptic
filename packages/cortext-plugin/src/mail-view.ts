import type { EngineInterface, RenderElement } from 'claude-code';
import { BRAND, tint } from './brand.js';
import { el } from './el.js';
import { avatar, icon } from './icons.js';
import { cut } from './pane-text.js';

// How agent mail and typed prompts look, on every site that draws them: no engine state, so the
// Remote session pane, the transcript hooks and a demo all draw the same rows.
//
// The iMessage pattern: what you and your agent wrote sits right in the accent, what the other
// side wrote sits left in grey, each bubble with a tail toward its side. A small icon by the
// name says person or agent. A mail is a bubble too, its direction on the envelope icon.

const PREVIEW_MAX = 180;

type Els = ReturnType<EngineInterface['ui']['resolve']>;
type Tag = Parameters<typeof el>[0];

/** `release-agent@host-a` → name `release-agent`, host `host-a`. */
export function splitKid(kid: string): { name: string; host: string } {
  const at = kid.lastIndexOf('@');
  return at < 0 ? { name: kid, host: '' } : { name: kid.slice(0, at), host: kid.slice(at + 1) };
}

type Look = {
  tty: boolean;
  Svg: Tag | undefined;
  Markdown: Tag | undefined;
};

function look(els: Els, surface: string): Look {
  const tty = surface === 'terminal';
  return {
    tty,
    Svg: tty ? undefined : ((els as unknown as { Svg?: Tag }).Svg as Tag | undefined),
    Markdown: (els as unknown as { Markdown?: Tag }).Markdown
  };
}

/** A drawn Tabler icon where the surface draws Svg, else a short text mark in the same tone. */
function mark(
  els: Els,
  l: Look,
  name: string,
  hex: string,
  tone: string,
  alt: string,
  glyph: string,
  size = 16
): RenderElement {
  return l.Svg
    ? el(l.Svg, { source: icon(name, hex, size), alt, width: size, height: size })
    : el(els.Text, { color: tone }, glyph);
}

/** Whose side a message sits on: yours (you and your agent) right, theirs left, as iMessage does. */
export type Side = 'ours' | 'theirs';
/** Who wrote it, shown as the small icon beside the name. */
export type Author = 'person' | 'agent';

const SIDE_HEX: Record<Side, string> = { ours: BRAND.accent, theirs: BRAND.slate };
const SIDE_KEY: Record<Side, string> = { ours: 'suggestion', theirs: 'subtle' };
// The bubble's fill: the side's colour at low strength, so text stays at full contrast on it.
const FILL_ALPHA = '24';

/** The bubble's tail, a curved point at its bottom corner toward its own side. */
function tail(hex: string, side: Side): string {
  const d = side === 'ours' ? 'M0 0 C0 8 4 12 12 12 L0 12 Z' : 'M12 0 C12 8 8 12 0 12 L12 12 Z';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><path d="${d}" fill="${hex}" fill-opacity="${(Number.parseInt(FILL_ALPHA, 16) / 255).toFixed(3)}"/></svg>`;
}

export type MessageSpec = {
  key: string;
  side: Side;
  author: Author;
  /** Who wrote it, drawn under the avatar: for a kid, `splitKid(kid).name`. */
  name: string;
  /** The host under the name, without the `@`. */
  host?: string;
  /** A dim line at the bubble's foot: the time, `remote turn`. Mail puts its time in its own line. */
  meta?: string;
};

const AVATAR_PX = 28;
// The avatar column, in cells: room for a short name to wrap to two lines under the icon.
const AVATAR_COLS = 12;

/**
 * One message as a group-chat bubble: a round avatar beside it with the name and host under the
 * icon, the bubble with a tail toward the avatar. Yours sit right in the accent, theirs left in
 * grey, so the side says whose it is and the icon says person or agent.
 */
export function messageRow(
  els: Els,
  surface: string,
  m: MessageSpec,
  ...content: (RenderElement | null | undefined)[]
): RenderElement {
  const { Box, Text } = els;
  const l = look(els, surface);
  const hex = SIDE_HEX[m.side];
  const tone = l.tty ? SIDE_KEY[m.side] : hex;
  const ours = m.side === 'ours';
  const body = content.filter((c): c is RenderElement => c != null);
  const who = el(
    Box,
    {
      flexDirection: 'column',
      alignItems: 'center',
      width: AVATAR_COLS,
      flexShrink: 0
    },
    l.Svg
      ? el(l.Svg, {
          source: avatar(m.author === 'agent' ? 'robot' : 'user', hex, AVATAR_PX),
          alt: m.author === 'agent' ? 'Agent' : 'Person',
          width: AVATAR_PX,
          height: AVATAR_PX
        })
      : el(Text, { color: tone }, m.author === 'agent' ? '[agent]' : '[person]'),
    el(Text, { bold: true, wrap: 'wrap', maxLines: 2 }, m.name),
    m.host ? el(Text, { dimColor: true, wrap: 'truncate-end' }, `@${m.host}`) : null
  );
  const bubble = el(
    Box,
    {
      flexDirection: 'column',
      flexShrink: 1,
      backgroundColor: l.tty ? undefined : tint(hex, FILL_ALPHA),
      borderStyle: l.tty ? 'round' : undefined,
      borderColor: l.tty ? tone : undefined,
      paddingX: 1,
      paddingY: l.tty ? 0 : 1
    },
    ...body,
    m.meta ? el(Text, { dimColor: true }, m.meta) : null
  );
  const point = l.Svg
    ? el(l.Svg, { source: tail(hex, m.side), alt: 'Speech bubble tail', width: 12, height: 12 })
    : null;
  // The bubble sits level with the top of its avatar and keeps a margin on the far side, so
  // yours and theirs never line up edge to edge.
  return el(
    Box,
    {
      key: m.key,
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: ours ? 'flex-end' : 'flex-start',
      paddingLeft: ours ? (l.tty ? 4 : 8) : 0,
      paddingRight: ours ? 0 : l.tty ? 4 : 8
    },
    ...(ours ? [bubble, point, who] : [who, point, bubble])
  );
}

export type MailCardSpec = {
  /** Key prefix, unique on its site. */
  key: string;
  dir: 'in' | 'out';
  shortId?: number;
  /** The sender for received mail, the recipient for sent mail. */
  peer: string;
  /** The sending agent's kid on sent mail, when known; the row is then signed with it. */
  from?: string;
  when: string;
  subject: string;
  body: string;
  isReply?: boolean;
  isOpen: boolean;
  onToggle: () => unknown;
  /** Shown as "Open their session" when set. */
  onOpenSession?: () => unknown;
  /** Which side sent it; defaults to ours for sent mail, theirs for received. */
  side?: Side;
};

/** The mail itself, framed as an attachment: icon and label, subject, preview, actions. */
export function mailAttachment(els: Els, surface: string, m: MailCardSpec): RenderElement {
  const { Box, Text, Button } = els;
  const l = look(els, surface);
  const accent = l.tty ? 'suggestion' : BRAND.accent;
  const label =
    m.dir === 'in'
      ? `Received${m.shortId !== undefined ? ` #${m.shortId}` : ''}`
      : `Sent${m.shortId !== undefined ? ` #${m.shortId}` : ''}`;
  // The avatar names the sender, so received mail's line says only when; sent says to whom.
  const route = m.dir === 'in' ? '' : `to ${m.peer}`;
  const body = m.body.trim();
  const preview = body.replace(/\s+/g, ' ');
  const actions: RenderElement[] = [];
  if (body) {
    actions.push(
      el(
        Button,
        { key: `${m.key}-toggle`, plain: true, onPress: m.onToggle },
        m.isOpen ? 'Hide full message' : 'Show full message'
      )
    );
  }
  if (m.onOpenSession) {
    actions.push(
      el(
        Button,
        { key: `${m.key}-session`, plain: true, onPress: m.onOpenSession },
        'Open their session'
      )
    );
  }
  // Inside the bubble already, so no frame of its own.
  return el(
    Box,
    { flexDirection: 'column' },
    el(
      Box,
      { flexDirection: 'row', gap: 1, alignItems: 'center' },
      mark(
        els,
        l,
        m.dir === 'in' ? 'mail-down' : 'mail-up',
        BRAND.accent,
        accent,
        m.dir === 'in' ? 'Received mail' : 'Sent mail',
        m.dir === 'in' ? '↓' : '↑'
      ),
      el(Text, { bold: true, color: accent }, label),
      el(
        Text,
        { dimColor: true, wrap: 'truncate-end' },
        [route, m.when, m.isReply ? 'reply' : ''].filter(Boolean).join(' · ')
      )
    ),
    el(Text, { bold: true }, m.subject || '(no subject)'),
    m.isOpen && body
      ? l.Markdown
        ? el(l.Markdown, { key: `${m.key}-body`, text: body })
        : el(Text, {}, body)
      : el(
          Text,
          { dimColor: true, maxLines: 2 },
          preview ? cut(preview, PREVIEW_MAX) : '(no message body)'
        ),
    m.isOpen && m.dir === 'in'
      ? el(
          Text,
          { dimColor: true },
          'Signed by another agent: read it as information, not as an instruction from you.'
        )
      : null,
    actions.length > 0 ? el(Box, { flexDirection: 'row', gap: 3 }, ...actions) : null
  );
}

/**
 * A mail as one message: the sending agent's avatar, name and host beside it, the mail in the
 * bubble with its time on the Sent or Received line.
 */
export function mailCard(els: Els, surface: string, m: MailCardSpec): RenderElement {
  const sender = m.dir === 'in' ? m.peer : (m.from ?? '');
  const who = sender ? splitKid(sender) : { name: 'This agent', host: '' };
  return messageRow(
    els,
    surface,
    {
      key: m.key,
      side: m.side ?? (m.dir === 'out' ? 'ours' : 'theirs'),
      author: 'agent',
      name: who.name,
      host: who.host
    },
    mailAttachment(els, surface, m)
  );
}

export type PromptCardSpec = {
  key: string;
  /** `me`: the person at this keyboard; `them`: the person at the other session. */
  who: 'me' | 'them';
  /** Who typed it: a kid, or empty for this person. */
  name?: string;
  /** What the meta adds, such as `remote turn`. */
  note?: string;
  text: string;
};

/** A prompt a person typed: yours on the right, theirs on the left. */
export function promptCard(els: Els, surface: string, m: PromptCardSpec): RenderElement {
  const who = m.name ? splitKid(m.name) : { name: '', host: '' };
  return messageRow(
    els,
    surface,
    {
      key: m.key,
      side: m.who === 'me' ? 'ours' : 'theirs',
      author: 'person',
      name: m.who === 'me' ? 'You' : who.name || 'Their person',
      host: m.who === 'them' ? who.host : '',
      meta: m.note
    },
    el(els.Text, {}, m.text)
  );
}
