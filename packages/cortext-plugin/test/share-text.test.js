import { describe, expect, it } from 'vitest';
import {
  isPersonsPrompt,
  mailFeedText,
  splitMailFeedText,
  TOOL_TEXT_MAX,
  toolSummary
} from '../src/share-text.ts';

describe('toolSummary', () => {
  it("prefers the call's own description, cut to the feed's limit", () => {
    expect(toolSummary('Bash', { command: 'rm -rf build', description: 'Clean the build' })).toBe(
      'Clean the build'
    );
    expect(toolSummary('Bash', { description: 'x'.repeat(500) })).toHaveLength(TOOL_TEXT_MAX);
  });
  it('names a file by its base name and a URL by its host, never more', () => {
    expect(toolSummary('Edit', { file_path: '/repo/src/relay.ts', old_string: 'a' })).toBe(
      'relay.ts'
    );
    expect(toolSummary('WebFetch', { url: 'https://example.com/private?token=abc' })).toBe(
      'example.com'
    );
  });
  it('drops credentials and the port from a URL', () => {
    for (const url of [
      'https://user:secret@example.com/',
      'https://a@b@example.com:8443/x',
      'HTTP://token@example.com'
    ])
      expect(toolSummary('WebFetch', { url }), url).toBe('example.com');
    expect(toolSummary('WebFetch', { url: 'https://user:secret@/' })).toBe('WebFetch');
    expect(toolSummary('WebFetch', { url: 'example.com/no-scheme' })).toBe('WebFetch');
  });
  it('falls back to the tool name, so a command line is never shared', () => {
    expect(toolSummary('Bash', { command: 'cat ~/.ssh/id_ed25519' })).toBe('Bash');
  });
});

describe('mail feed text', () => {
  it('round-trips subject and body', () => {
    expect(splitMailFeedText(mailFeedText('Hi', 'line one\n\nline two'))).toEqual({
      subject: 'Hi',
      body: 'line one\n\nline two'
    });
    expect(splitMailFeedText(mailFeedText('Only a subject', ''))).toEqual({
      subject: 'Only a subject',
      body: ''
    });
  });
});

describe('isPersonsPrompt', () => {
  it("takes the person's own words only", () => {
    expect(isPersonsPrompt({ origin: { kind: 'composer' } })).toBe(true);
    expect(isPersonsPrompt({ origin: { kind: 'bridge' } })).toBe(true);
    expect(isPersonsPrompt({ origin: { kind: 'plugin' } })).toBe(false);
    expect(isPersonsPrompt({ origin: { kind: 'peer' } })).toBe(false);
    expect(isPersonsPrompt({ origin: { kind: 'composer' }, isMeta: true })).toBe(false);
    expect(
      isPersonsPrompt({ origin: { kind: 'composer' }, command: { name: 'x', args: '' } })
    ).toBe(false);
    expect(isPersonsPrompt({})).toBe(false);
  });
});
