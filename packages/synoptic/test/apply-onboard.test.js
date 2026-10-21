import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOnboard, planActions } from '../src/apply-onboard.js';
import { onboard } from '../src/onboard.js';

const mk = (harness) =>
  onboard(harness, {
    host: 'Desk',
    project: 'tools',
    substrateUrl: 'https://substrate.example.com',
    mcpBin: '/opt/substrate/node_modules/@mnmal-ai/substrate/dist/substrate.js'
  });

describe('planActions (pure)', () => {
  it('resolves project-relative files under targetDir and ~ under home', () => {
    const a = planActions(mk('cursor'), { targetDir: '/repo', home: '/home/user' });
    const paths = a.writes.map((w) => w.path);
    expect(paths).toContain('/repo/.cursor/mcp.json');
    expect(paths).toContain('/repo/.cursor/rules/substrate.mdc');
  });

  it('resolves a user-scope ~ path against home', () => {
    const k = onboard('kimi', {
      host: 'Desk',
      project: 't',
      substrateUrl: 'https://h',
      mcpBin: '/bin',
      scope: 'user'
    });
    const a = planActions(k, { targetDir: '/repo', home: '/home/user' });
    expect(a.writes.map((w) => w.path)).toContain('/home/user/.kimi-code/mcp.json');
  });

  it('never clobbers an existing file — routes it to `skipped` instead', () => {
    const existing = ['/repo/.cursor/rules/substrate.mdc'];
    const a = planActions(mk('cursor'), { targetDir: '/repo', home: '/home/user', existing });
    expect(a.skipped.map((s) => s.path)).toContain('/repo/.cursor/rules/substrate.mdc');
    expect(a.writes.map((w) => w.path)).not.toContain('/repo/.cursor/rules/substrate.mdc');
  });

  it('flags whether a skipped file needs a structured merge', () => {
    // gemini mcp is merge:true (settings.json fragment)
    const existing = ['/repo/.gemini/settings.json'];
    const a = planActions(mk('gemini'), { targetDir: '/repo', home: '/home/user', existing });
    const skip = a.skipped.find((s) => s.path === '/repo/.gemini/settings.json');
    expect(skip.merge).toBe(true);
  });

  it('assembles an identity script marking safe vs privileged steps', () => {
    const a = planActions(mk('cursor'), { targetDir: '/repo', home: '/home/user' });
    expect(a.identityScript).toMatch(/SAFE/);
    expect(a.identityScript).toMatch(/PRIVILEGED/);
    expect(a.identityScript).toMatch(/genpkey/);
    expect(a.identityScript).toMatch(/substrate-admin register/);
    expect(a.identityScript).toMatch(/systemctl restart/);
  });

  it('passes through the prime hint', () => {
    expect(planActions(mk('kimi'), { targetDir: '/r', home: '/h' }).primeHint).toMatch(
      /@AGENTS\.md/
    );
  });
});

describe('applyOnboard (writes to disk)', () => {
  it('writes resolved files, creating nested dirs, and never overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synoptic-onboard-'));
    const summary = applyOnboard(mk('cursor'), { targetDir: dir, home: dir });
    expect(existsSync(join(dir, '.cursor/mcp.json'))).toBe(true);
    expect(existsSync(join(dir, '.cursor/rules/substrate.mdc'))).toBe(true);
    expect(readFileSync(join(dir, '.cursor/rules/substrate.mdc'), 'utf8')).toContain('tools');
    expect(summary.written).toContain(join(dir, '.cursor/mcp.json'));

    // Re-applying skips the now-existing files (no clobber).
    const second = applyOnboard(mk('cursor'), { targetDir: dir, home: dir });
    expect(second.written).toEqual([]);
    expect(second.skipped.map((s) => s.path)).toContain(join(dir, '.cursor/mcp.json'));
  });

  it('preserves a hand-edited file across a re-apply', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synoptic-onboard-'));
    applyOnboard(mk('kimi'), { targetDir: dir, home: dir });
    writeFileSync(join(dir, 'AGENTS.md'), 'HAND EDITED');
    applyOnboard(mk('kimi'), { targetDir: dir, home: dir });
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('HAND EDITED');
  });
});
