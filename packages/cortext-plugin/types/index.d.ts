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
};
export type TodoDraft = {
  id: string;
  shortId: number;
  title: string;
  area: string;
  priority: string;
  status: string;
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
      paneTodos: PaneTodo[];
      paneTodoScope: 'project' | 'all';
      paneEditing: TodoDraft | null;
      paneNote: string;
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
