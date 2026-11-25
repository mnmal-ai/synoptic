import type { EngineInterface, RenderElement } from 'claude-code';
import { BRAND, tint } from './brand.js';
import { el } from './el.js';
import { icon } from './icons.js';
import { cut } from './pane-text.js';

// How agent mail and typed prompts look, on every site that draws them: no engine state, so the
// Remote session pane, the transcript hooks and a demo all draw the same rows.
//
// The chat pattern people already read: each message is an avatar, a name with a quiet time
// beside it, then the text, with no box around it. Your own turns sit right as a tinted bubble.
// A mail is the one thing with a frame: an attachment card under the agent that sent it, its
// colour only on the envelope icon. Colour follows who is speaking (you pink, their person
// amber, agents neutral); a mail's direction is its icon and label.

const PREVIEW_MAX = 180;
const AVATAR = 20;

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

type Speaker = 'me' | 'them' | 'agent';

const SPEAKER_HEX: Record<Speaker, string> = {
  me: BRAND.magenta,
  them: BRAND.yellow,
  agent: BRAND.slate
};
const SPEAKER_KEY: Record<Speaker, string> = { me: 'claude', them: 'warning', agent: 'subtle' };

export type MessageSpec = {
  key: string;
  speaker: Speaker;
  /** The bold name; for a kid pass `splitKid(kid).name` and its host as `meta`. */
  name: string;
  /** Dim words after the name: the host, a time, `remote turn`. */
  meta?: string;
};

/**
 * One message row: avatar, name and meta on one line, the content under the name. Your own
 * (`me`) draws as a tinted bubble on the right instead, as every chat app draws the sender's.
 */
export function messageRow(
  els: Els,
  surface: string,
  m: MessageSpec,
  ...content: (RenderElement | null | undefined)[]
): RenderElement {
  const { Box, Text } = els;
  const l = look(els, surface);
  const hex = SPEAKER_HEX[m.speaker];
  const tone = l.tty ? SPEAKER_KEY[m.speaker] : hex;
  const body = content.filter((c): c is RenderElement => c != null);
  const header = el(
    Box,
    { flexDirection: 'row', gap: 1, alignItems: 'center' },
    el(Text, { bold: true, color: m.speaker === 'agent' ? undefined : tone }, m.name),
    m.meta ? el(Text, { dimColor: true, wrap: 'truncate-end' }, m.meta) : null
  );
  if (m.speaker === 'me') {
    return el(
      Box,
      { key: m.key, flexDirection: 'row', justifyContent: 'flex-end' },
      el(
        Box,
        {
          flexDirection: 'column',
          width: l.tty ? undefined : '85%',
          backgroundColor: l.tty ? undefined : tint(hex, '14'),
          borderStyle: l.tty ? 'round' : undefined,
          borderColor: l.tty ? tone : undefined,
          paddingX: 1
        },
        header,
        ...body
      )
    );
  }
  const avatar =
    m.speaker === 'agent'
      ? mark(els, l, 'robot', hex, tone, 'Agent', '[agent]', AVATAR)
      : mark(els, l, 'user', hex, tone, 'Person', '[person]', AVATAR);
  return el(
    Box,
    { key: m.key, flexDirection: 'row', gap: 1 },
    el(Box, { flexDirection: 'column', width: l.tty ? undefined : AVATAR }, avatar),
    el(Box, { flexDirection: 'column', flexGrow: 1 }, header, ...body)
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
};

/** The mail itself, framed as an attachment: icon and label, subject, preview, actions. */
export function mailAttachment(els: Els, surface: string, m: MailCardSpec): RenderElement {
  const { Box, Text, Button } = els;
  const l = look(els, surface);
  const accent = l.tty ? 'suggestion' : BRAND.accent;
  const rule = l.tty ? 'promptBorder' : tint(BRAND.slate, '59');
  const label =
    m.dir === 'in'
      ? `Received${m.shortId !== undefined ? ` #${m.shortId}` : ''}`
      : `Sent${m.shortId !== undefined ? ` #${m.shortId}` : ''}`;
  const route = m.dir === 'in' ? `from ${m.peer}` : `to ${m.peer}`;
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
  return el(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: rule,
      paddingX: 1,
      marginTop: 1
    },
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
        [route, m.isReply ? 'reply' : ''].filter(Boolean).join(' · ')
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
 * A mail as one message: the agent that sent it (robot avatar, name, host and time), then the
 * mail as an attachment under it.
 */
export function mailCard(els: Els, surface: string, m: MailCardSpec): RenderElement {
  const sender = m.dir === 'in' ? m.peer : (m.from ?? '');
  const who = sender ? splitKid(sender) : { name: 'This agent', host: '' };
  return messageRow(
    els,
    surface,
    {
      key: m.key,
      speaker: 'agent',
      name: who.name,
      meta: [who.host ? `@${who.host}` : '', m.when].filter(Boolean).join(' · ')
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

/** A prompt a person typed: your bubble on the right, their person's message on the left. */
export function promptCard(els: Els, surface: string, m: PromptCardSpec): RenderElement {
  const who = m.name ? splitKid(m.name) : { name: '', host: '' };
  return messageRow(
    els,
    surface,
    {
      key: m.key,
      speaker: m.who,
      name: m.who === 'me' ? 'You' : 'Their person',
      meta: [m.who === 'them' && who.name ? who.name : '', m.note].filter(Boolean).join(' · ')
    },
    el(els.Text, {}, m.text)
  );
}
