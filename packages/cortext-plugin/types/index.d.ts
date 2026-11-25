export type InboxMessage = {
  type: 'message';
  id: string;
  shortId: number;
  subject: string;
  body: string | null;
  inReplyTo: string | null;
  tags: string[] | null;
  from: string;
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
  host: string;
  title: string;
  project: string | null;
  lastEventAt: string;
};
export type FeedEvent = {
  step: number;
  kind: 'prompt' | 'reply' | 'tool';
  text: string;
  tool?: string | null;
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
      paneLayout: 'list' | 'board';
      paneCardOpen: boolean;
      paneTodoView: {
        sort: 'priority' | 'created' | 'updated' | 'status' | 'title';
        status: string;
        priority: string;
        search: string;
      };
      paneNote: string;
      paneSelected: string | null;
      paneDetail: TodoDetail | null;
      paneFeeds: FeedRow[];
      paneWatched: string | null;
      paneEvents: FeedEvent[];
      /** /cortext-share: off until the person turns it on in this session. */
      shareOn: boolean;
      shareFeed: string;
      shareStep: number;
      /** Kids allowed to send this session turns; empty = nobody. */
      shareControlFrom: string[];
    };
  }
}
