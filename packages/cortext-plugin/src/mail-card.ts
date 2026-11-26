import type { EngineInterface, On, RenderElement } from 'claude-code';
import { atom, read, update } from 'claude-code';
import { el } from './el.js';
import { parseMailRow, parseMailSend } from './mail-text.js';
import { mailCard } from './mail-view.js';

// Agent mail in this session's transcript drawn as cards (mail-view.ts): received rows and sent
// calls. Each card folds to a preview and opens to the whole body; ctrl+o keeps the rows as the
// model read them.

// The tag declines what the first version stored: shortIds as numbers.
export const openMail = atom({ plugin: 'cortext', key: 'mailOpen' }, [], { shape: 'mail-2' });

function toggler($: EngineInterface, id: string): () => Promise<unknown> {
  return () =>
    update($, openMail, (prev) => {
      const ids = prev ?? [];
      return ids.includes(id) ? ids.filter((n) => n !== id) : [...ids, id].slice(-200);
    });
}

export function registerMailCard(on: On): void {
  // A pushed mail row: the user-role row the bridge appends for each delivered message.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e); // ctrl+o shows the row as the model read it
    const row = parseMailRow(e.props.text);
    if (!row) return next(e);
    const id = `in-${row.shortId}`;
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
      onToggle: toggler($, id)
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
