// The setup command is opencode-prose, not shared bytes — but two
// regressions have a shape worth pinning: a `claude/` frame key (the
// legacy namespace answers `unknown_namespace`) and a
// `${SUBSTRATE_*}` env ref (opencode does not substitute shell-style refs;
// identity would arrive literally and every signed read would 401).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEXT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'substrate-setup', 'SKILL.md'),
  'utf8'
);

describe('substrate-setup command (opencode)', () => {
  it('opens no query frame against the retired `claude` namespace', () => {
    expect(/\{\s*"claude\//.test(TEXT)).toBe(false);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${} in this name is intentional — it pins the forbidden spelling.
  it('uses {env:} interpolation refs, never shell-style ${} refs, for identity', () => {
    expect(TEXT).toContain('{env:SUBSTRATE_AGENT_KEY_PATH}');
    expect(TEXT).toContain('{env:SUBSTRATE_AGENT_KEY_ID}');
    expect(/\$\{SUBSTRATE_AGENT_/.test(TEXT)).toBe(false);
  });

  it('documents the opencode MCP dialect keys', () => {
    expect(TEXT).toContain('"mcp"');
    expect(TEXT).toContain('"type": "local"');
    expect(TEXT).toContain('"environment"');
    expect(TEXT).toContain('"instructions"');
    // `mcpServers` appears only contrastively (naming the Claude dialect the
    // reader must NOT carry over); the emitted shape is never stdio-style.
    expect(TEXT).not.toContain('"type": "stdio"');
  });
});
