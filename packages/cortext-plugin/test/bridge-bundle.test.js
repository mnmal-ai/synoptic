import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../hooks/inbox-bridge.mjs', import.meta.url), 'utf8');

describe('hooks/inbox-bridge.mjs', () => {
  it('imports only claude-code — no Node built-ins, nothing left unbundled', () => {
    const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specs).toEqual(['claude-code']);
    // `process.` as the Node global only: `$.process.spawn` is the engine's noun, not Node's.
    expect(src).not.toMatch(/\bnode:|\brequire\(|(?<![.\w$])process\.|\bBuffer\b/);
  });
  it('holds no dynamic import() — a module holding one does not load', () => {
    expect(src).not.toMatch(/\bimport\s*\(/);
  });
  it('exports register', () => {
    expect(src).toMatch(/export\s*\{[^}]*\bregister\b/);
  });
});
