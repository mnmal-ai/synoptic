export type InboxMessage = {
  type: 'message';
  id: string;
  shortId: number;
  subject: string;
  body: string | null;
  inReplyTo: string | null;
  tags: string[] | null;
  from: string;
  external: { domain: string; relayKid: string } | null;
  createdAt: string;
  fromSelf: boolean;
  urgent: boolean;
};
export type WatchStatus = {
  type: 'status';
  state: 'live' | 'reconnecting' | 'disabled';
  reason?: string;
  config?: { wake: boolean };
};
export type WatchHandled = { type: 'handled'; id: string };
export type WatchEvent = InboxMessage | WatchStatus | WatchHandled;
export type PaneTodo = {
  id: string;
  shortId: number;
  title: string;
  area: string;
  status: string;
  priority: string;
  project: string | null;
  tags?: string[] | null;
  createdAt?: string;
  updatedAt?: string;
};
export type TodoDetail = {
  id: string;
  notes?: string | null;
  body?: string | null;
  blockedBy?: string | null;
  revisitWhen?: string | null;
  targetDate?: string | null;
  _metadata?: { createdAt?: string; updatedAt?: string };
};

export type FeedRow = {
  id: string;
  instance: string;
  title: string;
  project: string | null;
  lastEventAt: string;
  /** The feed's owner is createdBy.id, the key the server stamped on it. */
  _metadata?: { createdBy?: { id?: string } };
};
export type FeedEvent = {
  step: number;
  kind: 'prompt' | 'reply' | 'tool' | 'mail-in' | 'mail-out';
  text: string;
  /** The tool name on a tool event, the peer's kid on a mail event. */
  tool: string | null;
};

declare module 'claude-code' {
  interface PluginState {
    cortext: {
      inboxDelivered: string[];
      inboxCursor: string;
      /** SYNOPTIC_INBOX_PROMPT_CHECK as the session found it, before any watcher set it; null = unset. */
      inboxPromptCheckOrig: string | null;
      paneTodos: Shaped<PaneTodo[]>;
      paneTodoScope: 'project' | 'all';
      paneDrafts: Record<string, string>;
      paneLayout: 'list' | 'board' | 'grouped';
      paneFolds: string[];
      panePicker: string | null;
      paneCardOpen: boolean;
      paneVocab: { status: readonly string[]; priority: readonly string[] };
      paneRefreshedAt: number;
      paneSplit: number;
      paneTodoView: {
        sort: 'priority' | 'created' | 'updated' | 'status' | 'title';
        status: string;
        priority: string;
        search: string;
      };
      paneNote: string;
      paneSelected: string | null;
      paneDetail: TodoDetail | null;
      /** The brain fact rolled when the Todos pane opened (an index into BRAIN_FACTS), or null. */
      paneBrainFact: number | null;
      /** Mail cards shown open: `in-<shortId>` for received rows, `out-<tool_use_id>` for sends. */
      mailOpen: Shaped<string[]>;
      /** True while this session shares its steps to its SessionFeed (/cortext-share on). */
      shareOn: boolean;
      /** The shared sessions the watch pane lists, newest first, this session's own left out. */
      shareFeeds: FeedRow[];
      /** The feed the watch pane shows, or null before a pick. */
      shareWatched: string | null;
      /** The watched feed's latest steps, oldest first. */
      shareEvents: FeedEvent[];
      shareNote: string;
    };
  }
}
