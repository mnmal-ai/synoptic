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

declare module 'claude-code' {
  interface PluginState {
    cortext: {
      inboxDelivered: string[];
      inboxCursor: string;
      /** SYNOPTIC_INBOX_PROMPT_CHECK as the session found it, before any watcher set it; null = unset. */
      inboxPromptCheckOrig: string | null;
    };
  }
}
