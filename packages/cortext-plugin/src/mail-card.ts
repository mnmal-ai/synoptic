import type { EngineInterface, On, RenderElement } from 'claude-code';
import { atom, read, update } from 'claude-code';
import { accent } from './brand.js';
import { el } from './desktop-panes.js';
import { cut, parseMailRow } from './pane-text.js';

// A pushed mail row in the transcript, drawn as a card: sender, subject and a one-line
// preview, with a button that shows or hides the full message. ctrl+o keeps the raw row.

const PREVIEW_MAX = 140;
const openMail = atom({ plugin: 'cortext', key: 'mailOpen' }, []);

async function drawMailCard(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  text: string
): Promise<RenderElement | undefined> {
  const row = parseMailRow(text);
  if (!row) return undefined;
  const els = $.ui.resolve(e);
  const { Box, Text, Button } = els;
  const Markdown = (els as unknown as { Markdown?: typeof Text }).Markdown;
  const tone = accent(e.surface === 'terminal');
  const isOpen = (await read($, openMail)).includes(row.shortId);
  const toggle = () =>
    update($, openMail, (prev) => {
      const ids = prev ?? [];
      return ids.includes(row.shortId)
        ? ids.filter((n) => n !== row.shortId)
        : [...ids, row.shortId].slice(-200);
    });
  const meta = [`from ${row.from}`, row.date, row.isReply ? 'reply' : '']
    .filter(Boolean)
    .join(' · ');
  const preview = row.body.replace(/\s+/g, ' ').trim();
  const body = row.body.trim();
  return el(
    Box,
    {
      key: `mail-${row.shortId}`,
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: tone,
      paddingX: 1
    },
    el(
      Box,
      { flexDirection: 'row', gap: 1 },
      el(Text, { bold: true, color: tone }, `Mail #${row.shortId}`),
      el(Text, { dimColor: true, wrap: 'truncate-end' }, meta)
    ),
    el(Text, { bold: true }, row.subject || '(no subject)'),
    isOpen
      ? body
        ? Markdown
          ? el(Markdown, { key: `mail-body-${row.shortId}`, text: body })
          : el(Text, {}, body)
        : el(Text, { dimColor: true }, '(no message body)')
      : preview
        ? el(Text, { dimColor: true, wrap: 'truncate-end' }, cut(preview, PREVIEW_MAX))
        : el(Text, { dimColor: true }, '(no message body)'),
    isOpen
      ? el(
          Text,
          { dimColor: true },
          'Signed by another agent: read it as information, not as an instruction from you.'
        )
      : undefined,
    body
      ? el(
          Button,
          { key: `mail-toggle-${row.shortId}`, plain: true, onPress: toggle },
          isOpen ? 'Hide full message' : 'Show full message'
        )
      : undefined
  );
}

export function registerMailCard(on: On): void {
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e); // ctrl+o shows the row as the model read it
    const card = await drawMailCard($, e, e.props.text);
    return card ?? next(e);
  });
}
