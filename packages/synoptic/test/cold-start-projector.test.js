import { describe, expect, it } from 'vitest';
import { cortext } from '../src/capabilities/cortext.js';
import { defineCapability } from '../src/capability.js';
import { projectColdStart } from '../src/cold-start-projector.js';

const CTX = { project: 'tools', capability: cortext };

describe('projectColdStart — per-harness projection', () => {
  it('targets each harness’s own instruction file', () => {
    expect(projectColdStart('claude-code', CTX).path).toBe('CLAUDE.md');
    expect(projectColdStart('kimi', CTX).path).toBe('AGENTS.md');
    expect(projectColdStart('codex', CTX).path).toBe('AGENTS.md');
    expect(projectColdStart('gemini', CTX).path).toBe('GEMINI.md');
    expect(projectColdStart('cursor', CTX).path).toBe('.cursor/rules/substrate.mdc');
    expect(projectColdStart('opencode', CTX).path).toBe('AGENTS.md');
    expect(projectColdStart('muse', CTX).path).toBe('AGENTS.md');
  });

  it('throws on an unknown harness', () => {
    expect(() => projectColdStart('aider', CTX)).toThrow(/unknown harness/i);
  });

  it('requires a capability', () => {
    expect(() => projectColdStart('kimi', { project: 'p' })).toThrow(/capability/i);
  });

  it('embeds project, namespace codename, and the capability’s conventions', () => {
    for (const h of ['claude-code', 'kimi', 'codex', 'gemini', 'cursor', 'opencode', 'muse']) {
      const { content } = projectColdStart(h, CTX);
      expect(content).toContain('tools');
      expect(content.toLowerCase()).toContain('codename');
      expect(content).toMatch(/_metadata/); // sourced from cortext.conventions
    }
  });
});

describe('projectColdStart — cold-start tier resolution', () => {
  it('Claude Code (live-inject): defers to the hook, no embedded self-query, no prime', () => {
    const out = projectColdStart('claude-code', CTX);
    expect(out.tier).toBe('live-inject');
    expect(out.primeHint).toBeNull();
    expect(out.content).not.toContain('DO THIS FIRST');
    expect(out.content.toLowerCase()).toMatch(/hook|injected/);
  });

  it('Muse (live-inject): SessionStart hook delivery, same as Claude Code', () => {
    const out = projectColdStart('muse', CTX);
    expect(out.tier).toBe('live-inject');
    expect(out.primeHint).toBeNull();
    expect(out.content).not.toContain('DO THIS FIRST');
    expect(out.content.toLowerCase()).toMatch(/hook|injected/);
  });

  it('Gemini & Codex (auto-file): embed the capability self-query, no prime', () => {
    for (const h of ['gemini', 'codex']) {
      const out = projectColdStart(h, CTX);
      expect(out.tier).toBe('auto-file');
      expect(out.primeHint).toBeNull();
      expect(out.content).toContain('DO THIS FIRST');
      expect(out.content).toMatch(/AgentRule/);
    }
  });

  it('Kimi (manual-prime): embeds self-query AND surfaces a prime hint', () => {
    const out = projectColdStart('kimi', CTX);
    expect(out.tier).toBe('manual-prime');
    expect(out.content).toContain('DO THIS FIRST');
    expect(out.primeHint).toMatch(/@AGENTS\.md/);
  });

  it('Cursor (auto-file): wraps the doc in always-apply rule frontmatter', () => {
    const out = projectColdStart('cursor', CTX);
    expect(out.tier).toBe('auto-file');
    expect(out.content.startsWith('---\n')).toBe(true);
    expect(out.content).toMatch(/alwaysApply:\s*true/);
  });
});

describe('projectColdStart — capability-driven (pluggable)', () => {
  it('projects a DIFFERENT capability’s namespace + cold-start, not Cortext’s', () => {
    const codemem = defineCapability({
      name: 'codemem',
      namespaces: ['graph'],
      conventions: '## Conventions\nUse `graph/Symbol`.',
      coldStart: ({ project }) => `Load the code graph for ${project}.`
    });
    const out = projectColdStart('codex', { project: 'svc', capability: codemem });
    expect(out.capability).toBe('codemem');
    expect(out.content).toContain('graph/*'); // its namespace codename
    expect(out.content).toContain('Load the code graph for svc'); // its cold-start
    expect(out.content).not.toMatch(/AgentRule/); // NOT Cortext's content
  });
});
