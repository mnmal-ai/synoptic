import { describe, expect, it } from 'vitest';
import { controlKids, cut, hostOf, remoteTurnText, toolSummary } from '../src/pane-text.ts';

describe('toolSummary', () => {
  it("uses the tool's own description and never its command", () => {
    expect(toolSummary('Bash', { command: 'cat ~/.env', description: 'Run the relay tests' })).toBe(
      'Run the relay tests'
    );
    expect(toolSummary('Bash', { command: 'cat ~/.env' })).toBe('Bash');
  });
  it('names a file by its basename and a URL by its host', () => {
    expect(toolSummary('Read', { file_path: '/home/someone/repo/src/relay.ts' })).toBe('relay.ts');
    expect(toolSummary('WebFetch', { url: 'https://example.com/a?token=x' })).toBe('example.com');
  });
  it('cuts a long description', () => {
    expect(toolSummary('Agent', { description: 'x'.repeat(500) })).toHaveLength(160);
  });
});

describe('controlKids', () => {
  it('keeps only kid-shaped names', () => {
    expect(controlKids(' a-b@host-1, c_d@h2  junk ; @x ')).toEqual(['a-b@host-1', 'c_d@h2']);
    expect(controlKids('')).toEqual([]);
  });
});

describe('remoteTurnText', () => {
  it('says who sent the turn before their words', () => {
    const t = remoteTurnText('peer@host', 'run the tests');
    expect(t.startsWith('[Remote turn from peer@host')).toBe(true);
    expect(t.endsWith('\n\nrun the tests')).toBe(true);
  });
});

describe('cut', () => {
  it('trims and ellipsizes', () => {
    expect(cut('  hi  ', 10)).toBe('hi');
    expect(cut('abcdef', 4)).toBe('abc…');
  });
});

describe('hostOf', () => {
  it('takes the lowercase host of a kid, domain dropped', () => {
    expect(hostOf('peer@Host-A.local')).toBe('host-a');
    expect(hostOf('nohost')).toBe('unknown');
  });
});
