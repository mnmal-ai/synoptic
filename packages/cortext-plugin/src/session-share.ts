import type { EngineInterface, On, RenderElement } from 'claude-code';
import { atom, read, update } from 'claude-code';
import type { FeedEvent, FeedRow } from '../types';
import { el } from './el.js';
import { openMail } from './mail-card.js';
import { mailCard, messageRow, splitKid } from './mail-view.js';
import {
  isPersonsPrompt,
  mailFeedText,
  splitMailFeedText,
  TOOL_TEXT_MAX,
  toolSummary
} from './share-text.js';
import { mutate, query, sub } from './substrate-mcp.js';
import { cut } from './text.js';
import { ago } from './todo-text.js';

// Read-only session sharing. `/cortext-share on` writes this session's prompts, replies, tool
// summaries and mail to a cortext/SessionFeed; `/cortext-watch` opens a pane on a feed someone
// else shares. Nothing a viewer does reaches the shared session: there is no way to send it a turn.

const SESSION_PANE = 'cortext-session';
const POLL_MS = 4_000;
const TITLE_MAX = 80;
const TEXT_MAX = 4_000;
const EVENTS_KEPT = 300;
const FEEDS_LISTED = 50;

// Survives a reload: a session shared before a reload stays shared after it.
const SHARE = { plugin: 'cortext', key: 'shareOn' } as const;

const feeds = atom({ plugin: 'cortext', key: 'shareFeeds' }, []);
const watched = atom({ plugin: 'cortext', key: 'shareWatched' }, null);
const events = atom({ plugin: 'cortext', key: 'shareEvents' }, []);
const shareNote = atom({ plugin: 'cortext', key: 'shareNote' }, '');

// What the hooks share. Module variables reset on every reload; what must survive one lives in $.state.
export type SharePane = {
  ns: string;
  server: string; // the substrate MCP server's name as /mcp lists it
  project: string;
  instance: string; // `session:<8 hex>`, the tag this session stamps on its mail
  kid: string; // this repo's key as whoami names it; '' until asked
  feed: string | undefined; // this session's feed, checked live since the module loaded
  step: number; // the feed's latest step this module wrote or read
  writes: Promise<void>; // feed writes run one at a time, in order
  poll: { cancel: () => void } | undefined;
};

/** The feed's owner: the key that created it, as the server stamped it. */
function ownerOf(f: FeedRow): string {
  return f._metadata?.createdBy?.id ?? 'unknown';
}

async function whoAmI(p: SharePane, $: EngineInterface): Promise<string> {
  if (p.kid) return p.kid;
  const who = (await sub(p, $, 'whoami', {})) as { identity?: { kid?: string } | null };
  p.kid = who.identity?.kid ?? '';
  return p.kid;
}

// --- Sharing this session ------------------------------------------------

function enqueue(p: SharePane, $: EngineInterface, job: () => Promise<void>): void {
  // A failed write is dropped, never retried: the feed is a view of the session, not its record.
  p.writes = p.writes.then(job).catch((err) => {
    $.ui.log(`cortext: a shared step was not written: ${(err as Error).message}`, {
      to: 'debug'
    });
  });
}

/** This session's own feed: its instance AND this repo's key, since anyone may reuse an instance. */
async function findFeed(p: SharePane, $: EngineInterface): Promise<string | undefined> {
  const kid = await whoAmI(p, $);
  if (!kid) return undefined;
  const rows = await query<{ id: string }>(p, $, 'SessionFeed', {
    params: { where: { instance: { eq: p.instance }, createdBy: { eq: kid } }, limit: 1 },
    fields: { id: true }
  });
  return rows[0]?.id;
}

async function latestStep(p: SharePane, $: EngineInterface, feed: string): Promise<number> {
  const rows = await query<{ step: number }>(p, $, 'SessionFeedEvent', {
    params: { where: { feed: { eq: feed } }, orderBy: [{ step: 'desc' }], limit: 1 },
    fields: { step: true }
  });
  return rows[0]?.step ?? 0;
}

async function ensureFeed(p: SharePane, $: EngineInterface, title: string): Promise<string> {
  if (p.feed) return p.feed;
  const at = new Date(await $.clock.now()).toISOString();
  let id = await findFeed(p, $);
  if (id) {
    await mutate(p, $, 'updateSessionFeed', { id, sharing: true, lastEventAt: at });
  } else {
    const row = await mutate<{ id: string }>(p, $, 'createSessionFeed', {
      instance: p.instance,
      title: cut(title || p.project, TITLE_MAX),
      lastEventAt: at,
      project: p.project
    });
    id = row.id;
  }
  p.step = await latestStep(p, $, id);
  p.feed = id;
  return id;
}

async function publish(
  p: SharePane,
  $: EngineInterface,
  kind: FeedEvent['kind'],
  text: string,
  tool: string | null = null
): Promise<void> {
  const { value: on } = await $.state.get(SHARE);
  if (on !== true || text.trim() === '') return;
  enqueue(p, $, async () => {
    const feed = await ensureFeed(p, $, kind === 'prompt' ? text : '');
    const write = (step: number) =>
      mutate(p, $, 'createSessionFeedEvent', {
        feed,
        step,
        kind,
        text: cut(text, kind === 'tool' ? TOOL_TEXT_MAX : TEXT_MAX),
        tool,
        project: p.project
      });
    let step = p.step + 1;
    try {
      await write(step);
    } catch (err) {
      const code = (err as { code?: string }).code;
      // The feed is gone (deleted, or swept after a week idle): the next step starts a new one.
      if (code === 'missing_referent' || code === 'not_found') p.feed = undefined;
      // Another writer took the step (a second window on this session): go one past the latest.
      if (code !== 'unique_violation') throw err;
      step = (await latestStep(p, $, feed)) + 1;
      await write(step);
    }
    p.step = step;
    await mutate(p, $, 'updateSessionFeed', {
      id: feed,
      lastEventAt: new Date(await $.clock.now()).toISOString()
    });
  });
}

async function setSharing(p: SharePane, $: EngineInterface, on: boolean): Promise<string> {
  if (on && !(await whoAmI(p, $))) {
    return 'Sharing needs this repo’s substrate key, and whoami named none. Set SUBSTRATE_AGENT_KEY_ID in .claude/settings.local.json, then restart the session.';
  }
  await $.state.set(SHARE, on);
  if (on) {
    // In the queue, after any write still out: the next step finds the feed again and turns its
    // sharing back on.
    enqueue(p, $, async () => {
      p.feed = undefined;
    });
    return `Sharing is on for ${p.instance}. Your prompts, replies, tool names and mail (never tool output) go to Substrate, where any agent with read access can see them. Viewers can only watch. Turn it off with /cortext-share off.`;
  }
  enqueue(p, $, async () => {
    const id = p.feed ?? (await findFeed(p, $));
    p.feed = undefined;
    if (id) await mutate(p, $, 'updateSessionFeed', { id, sharing: false });
  });
  return 'Sharing is off. Viewers keep what was already shared; new steps stay here.';
}

// --- Watching a shared session -------------------------------------------

async function note($: EngineInterface, text: string): Promise<void> {
  await update($, shareNote, () => text);
}

async function loadFeeds(p: SharePane, $: EngineInterface): Promise<void> {
  try {
    const kid = await whoAmI(p, $);
    const rows = await query<FeedRow>(p, $, 'SessionFeed', {
      params: {
        where: { sharing: { eq: true }, archived: { eq: false } },
        orderBy: [{ lastEventAt: 'desc' }],
        limit: FEEDS_LISTED
      },
      fields: {
        id: true,
        instance: true,
        title: true,
        project: true,
        lastEventAt: true,
        _metadata: { createdBy: true }
      }
    });
    await update($, feeds, () =>
      rows.filter((f) => !(f.instance === p.instance && ownerOf(f) === kid))
    );
    await note($, '');
  } catch (err) {
    await note($, `Could not list shared sessions: ${(err as Error).message}`);
  }
}

async function pollEvents(p: SharePane, $: EngineInterface): Promise<void> {
  const feed = await read($, watched);
  if (!feed) return;
  const after = (await read($, events)).at(-1)?.step ?? 0;
  try {
    const rows = await query<FeedEvent>(p, $, 'SessionFeedEvent', {
      params: {
        where: { feed: { eq: feed }, step: { gt: after } },
        orderBy: [{ step: 'asc' }],
        limit: EVENTS_KEPT
      },
      fields: { step: true, kind: true, text: true, tool: true }
    });
    // A pick made while this read was out wins: its rows are not this feed's.
    if (rows.length > 0 && (await read($, watched)) === feed) {
      await update($, events, (old) => [...old, ...rows].slice(-EVENTS_KEPT));
    }
  } catch (err) {
    await note($, `Could not read the session: ${(err as Error).message}`);
  }
}

async function watch(p: SharePane, $: EngineInterface, feed: string): Promise<void> {
  await update($, watched, () => feed);
  await update($, events, () => []);
  await pollEvents(p, $);
  p.poll?.cancel();
  p.poll = $.clock.every(POLL_MS, () => void pollEvents(p, $));
}

async function drawSession(
  p: SharePane,
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0]
) {
  const els = $.ui.resolve(e);
  const { Box, Text, Button, Select } = els;
  const Markdown = (els as unknown as { Markdown?: typeof Text }).Markdown;
  const list = await read($, feeds);
  const feed = await read($, watched);
  const shown = await read($, events);
  const said = await read($, shareNote);
  const opened = await read($, openMail);
  const now = await $.clock.now();
  const room = Math.max(3, ((e as { viewport?: { rows?: number } }).viewport?.rows ?? 40) - 6);
  const picked = list.find((f) => f.id === feed);
  const owner = splitKid(picked ? ownerOf(picked) : '');

  const step = (ev: FeedEvent): RenderElement => {
    const key = `ev-${ev.step}`;
    if (ev.kind === 'mail-in' || ev.kind === 'mail-out') {
      const { subject, body } = splitMailFeedText(ev.text);
      const id = `feed-${feed}-${ev.step}`;
      return mailCard(els, e.surface, {
        key,
        dir: ev.kind === 'mail-in' ? 'in' : 'out',
        peer: ev.tool ?? 'someone',
        when: '',
        subject,
        body,
        isOpen: opened.includes(id),
        onToggle: () =>
          update($, openMail, (prev) => {
            const ids = prev ?? [];
            return ids.includes(id) ? ids.filter((n) => n !== id) : [...ids, id].slice(-200);
          })
      });
    }
    if (ev.kind === 'tool') {
      // A step of their agent's, indented under the avatar column as the chat does.
      return el(
        Box,
        { key, paddingLeft: e.surface === 'terminal' ? 2 : 14 },
        el(Text, { dimColor: true, wrap: 'truncate-end' }, `${ev.tool ?? 'tool'} · ${ev.text}`)
      );
    }
    const person = ev.kind === 'prompt';
    return messageRow(
      els,
      e.surface,
      {
        key,
        side: 'theirs',
        author: person ? 'person' : 'agent',
        name: person ? 'Their user' : owner.name,
        host: owner.host
      },
      Markdown && !person && e.surface !== 'terminal'
        ? el(Markdown, { text: ev.text })
        : el(Text, { wrap: 'wrap' }, ev.text)
    );
  };

  return el(
    Box,
    { flexDirection: 'column', gap: 1 },
    el(
      Box,
      { flexDirection: 'row', gap: 1 },
      list.length > 0
        ? el(Select, {
            key: 'feed-pick',
            label: 'Session',
            value: feed ?? undefined,
            options: list.map((f) => ({
              value: f.id,
              label: `${ownerOf(f)} · ${f.project ?? '—'} · ${cut(f.title, 40)} · ${ago(f.lastEventAt, now)}`
            })),
            onSelect: (v: string) => void watch(p, $, v)
          })
        : el(
            Text,
            { dimColor: true },
            'No session is shared right now. Its user turns sharing on with /cortext-share on.'
          ),
      el(Button, { key: 'feed-refresh', label: 'Refresh', onPress: () => void loadFeeds(p, $) })
    ),
    picked
      ? el(
          Text,
          { dimColor: true },
          `${picked.instance}, shared by ${ownerOf(picked)}. Read-only: nothing here reaches that session.`
        )
      : null,
    said ? el(Text, { color: said.startsWith('Could not') ? 'error' : 'subtle' }, said) : null,
    ...shown.slice(-room).map(step)
  );
}

// --- Wiring ---------------------------------------------------------------

/** The sharing state, made by the bridge and handed to registerShare, startShare and the share calls. */
export function newSharePane(): SharePane {
  return {
    ns: 'cortext',
    server: 'substrate',
    project: 'unknown',
    instance: 'session:unknown',
    kid: '',
    feed: undefined,
    step: 0,
    writes: Promise.resolve(),
    poll: undefined
  };
}

/** Called from the bridge's session.start hook. Asks the server nothing: whoami waits for first use. */
export async function startShare(p: SharePane, $: EngineInterface, cwd: string): Promise<void> {
  p.ns = (await $.env.get('SUBSTRATE_NAMESPACE')) || 'cortext';
  p.server = (await $.env.get('SYNOPTIC_SUBSTRATE_MCP')) || 'substrate';
  p.project = cwd.split('/').filter(Boolean).at(-1) ?? 'unknown';
  p.instance = `session:${(await $.session.id()).slice(0, 8)}`;
  await $.command.register({
    name: 'cortext-share',
    description: 'Share this session read-only: /cortext-share on | off'
  });
  await $.command.register({
    name: 'cortext-watch',
    description: 'Open a read-only pane on a session someone shared'
  });
}

/** Called from the bridge's main-thread tool.call hook: the tool's name and summary, never its output. */
export async function shareToolCall(
  p: SharePane,
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>
): Promise<void> {
  await publish(p, $, 'tool', toolSummary(tool, input), tool);
}

/** Called from the bridge for mail it delivered and mail this session sent. */
export async function shareMail(
  p: SharePane,
  $: EngineInterface,
  dir: 'in' | 'out',
  peer: string,
  subject: string,
  body: string
): Promise<void> {
  await publish(p, $, dir === 'in' ? 'mail-in' : 'mail-out', mailFeedText(subject, body), peer);
}

/** Called from the bridge's main-thread turn.complete hook. */
export async function shareReply(p: SharePane, $: EngineInterface, answer: string): Promise<void> {
  await publish(p, $, 'reply', answer);
}

export function registerShare(on: On, p: SharePane): void {
  on('command.run', { command: 'cortext-share' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();
    if (arg === 'on' || arg === 'off') return { text: await setSharing(p, $, arg === 'on') };
    const { value } = await $.state.get(SHARE);
    return {
      text: `Sharing is ${value === true ? 'on' : 'off'} for ${p.instance}. Use /cortext-share on or /cortext-share off.`
    };
  });

  on('command.run', { command: 'cortext-watch' }, async ($) => {
    await loadFeeds(p, $);
    await $.ui.open({ id: SESSION_PANE, title: 'Shared session' });
    return { text: 'Shared session pane opened. Pick a session at the top.' };
  });

  on('ui.close', { id: SESSION_PANE }, async (_$, e, next) => {
    p.poll?.cancel();
    p.poll = undefined;
    return next(e);
  });

  // The person's own words only, as they entered the session.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e);
    if (isPersonsPrompt(e) && 'text' in entered) await publish(p, $, 'prompt', entered.text);
    return entered;
  });

  on('ui.render', { component: 'Pane', requestId: SESSION_PANE }, async ($, e) =>
    drawSession(p, $, e)
  );
}
