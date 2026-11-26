import { cut } from './text.js';

// Text a shared session writes to its feed and a viewer reads back. No engine imports, so vitest
// covers it in CI.

export const TOOL_TEXT_MAX = 160;

/** A tool call as a feed shows it: its own description, the file it touched or the URL's host, never its output. */
export function toolSummary(tool: string, input: Record<string, unknown>): string {
  const pick = (k: string): string | undefined =>
    typeof input[k] === 'string' && input[k] !== '' ? (input[k] as string) : undefined;
  const said = pick('description');
  if (said !== undefined) return cut(said, TOOL_TEXT_MAX);
  const file = pick('file_path') ?? pick('notebook_path') ?? pick('path');
  if (file !== undefined) return file.split('/').filter(Boolean).at(-1) ?? file;
  const url = pick('url');
  if (url !== undefined) return /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? tool;
  return tool;
}

/** A mail feed event's text: subject, a blank line, then the body. */
export function mailFeedText(subject: string, body: string): string {
  return body ? `${subject}\n\n${body}` : subject;
}

/** Reads a mail feed event's text back into its subject and body. */
export function splitMailFeedText(text: string): { subject: string; body: string } {
  const at = text.indexOf('\n\n');
  return at < 0
    ? { subject: text, body: '' }
    : { subject: text.slice(0, at), body: text.slice(at + 2) };
}

/**
 * Whether a submitted prompt is the person's own words: typed at the prompt or sent from their
 * phone, never a slash command, a hidden prompt, a plugin's wake-up or a peer's message.
 */
export function isPersonsPrompt(e: {
  command?: unknown;
  isMeta?: true;
  origin?: { kind: string };
}): boolean {
  const kind = e.origin?.kind;
  return e.command === undefined && e.isMeta !== true && (kind === 'composer' || kind === 'bridge');
}
