import { describe, expect, it } from 'vitest';
import { cortext, createCortext } from '../src/capabilities/cortext.js';

describe('cortext capability', () => {
  it('is the cross-agent coordination capability over the cortext/* namespace', () => {
    expect(cortext.name).toBe('cortext');
    expect(cortext.namespaces).toContain('cortext');
    expect(cortext.requiresIdentity).toBe(true);
  });

  it('carries the interaction conventions', () => {
    expect(cortext.conventions).toMatch(/qualified/i);
    expect(cortext.conventions).toMatch(/_metadata/);
  });

  it('produces a project-scoped cold-start self-query', () => {
    const body = cortext.coldStart({ project: 'tools' });
    expect(body).toMatch(/AgentRule/);
    expect(body).toMatch(/active/);
    expect(body).toContain('tools');
  });

  it('cold-start is handoff-aware: resumes from the latest AnchorIntent', () => {
    const body = cortext.coldStart({ project: 'tools' });
    expect(body).toMatch(/RESUME/);
    expect(body).toMatch(/AnchorIntent/);
    expect(body).toMatch(/createAnchorIntent/); // prompts leaving a breadcrumb too
  });
});

describe('createCortext — born-neutral namespace factory', () => {
  it('builds a capability bound to a custom namespace', () => {
    const c = createCortext('cortext');
    expect(c.name).toBe('cortext');
    // `recall` rides alongside the coordination namespace at EVERY binding.
    // It is not decoration: the cold-start issues recall/Hit,
    // recall/boost and recall/fetchEmbeddings, and `onboard` hands this list
    // straight to `substrate-admin --ns`, so a namespace missing here becomes a
    // namespace missing on the registered key.
    expect(c.namespaces).toEqual(['cortext', 'recall']);
    expect(c.requiresIdentity).toBe(true);
  });

  it('templates conventions + cold-start onto the custom namespace (no claude/ leakage)', () => {
    const c = createCortext('cortext');
    expect(c.conventions).toContain('cortext/Todo');
    expect(c.conventions).not.toMatch(/claude\//);
    const body = c.coldStart({ project: 'tools' });
    expect(body).toContain('cortext/AgentRule');
    expect(body).toContain('cortext/AnchorIntent');
    expect(body).not.toMatch(/claude\//);
  });

  it('a custom coordination namespace still carries recall, and only these two', () => {
    // The pairing must survive re-binding — a born-neutral instance that
    // dropped recall would provision keys that silently lose hybrid ranking on
    // exactly the instances least likely to have anyone checking.
    const c = createCortext('othertext');
    expect(c.namespaces).toEqual(['othertext', 'recall']);
  });

  it('the default cortext export uses the cortext namespace', () => {
    expect(cortext.namespaces).toEqual(['cortext', 'recall']);
    expect(cortext.coldStart({ project: 'p' })).toContain('cortext/AgentRule');
  });
});
