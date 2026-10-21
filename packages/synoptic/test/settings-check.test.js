import assert from 'node:assert/strict';
import { test } from 'vitest';
import { checkSettings } from '../src/settings-check.js';

test('valid settings with project MCP enabled is all ok', () => {
  const out = checkSettings({
    settingsText: '{"enableAllProjectMcpServers": true}',
    hasProjectMcp: true
  });
  assert.ok(out.every((f) => f.state === 'ok'));
});

test('invalid JSON warns that the WHOLE file is inert', () => {
  // A missing comma. The file said enableAllProjectMcpServers: true and
  // `claude mcp get substrate` said pending approval; nothing reconciled them.
  const out = checkSettings({
    settingsText: '{"a": 1 "b": 2}',
    hasProjectMcp: true
  });
  assert.equal(out[0].state, 'warn');
  assert.match(out[0].text, /NOT VALID JSON/);
  assert.match(out[0].detail, /every key in this file is inert/);
});

test('a file that does not parse produces exactly ONE finding', () => {
  // Reporting "enablement missing" too would be a second finding caused
  // entirely by the first, and would send someone to fix the wrong thing.
  const out = checkSettings({ settingsText: '{ bad', hasProjectMcp: true });
  assert.equal(out.length, 1);
});

test('a project .mcp.json with no enabling key warns with the observed symptom', () => {
  const out = checkSettings({ settingsText: '{}', hasProjectMcp: true });
  const w = out.find((f) => f.state === 'warn');
  assert.match(w.detail, /pending approval/);
  assert.match(w.detail, /substrate offline/);
});

test('enabledMcpjsonServers naming substrate counts as enabled', () => {
  const out = checkSettings({
    settingsText: '{"enabledMcpjsonServers": ["substrate"]}',
    hasProjectMcp: true
  });
  assert.ok(out.every((f) => f.state === 'ok'));
});

test('an absent settings file is ok when there is no project .mcp.json', () => {
  const out = checkSettings({ settingsText: null, hasProjectMcp: false });
  assert.ok(out.every((f) => f.state === 'ok'));
  assert.equal(out.length, 1);
});

test('an absent settings file WARNS when a project .mcp.json exists', () => {
  const out = checkSettings({ settingsText: null, hasProjectMcp: true });
  assert.ok(out.some((f) => f.state === 'warn'));
});

test('no MCP enablement finding at all when the repo has no project .mcp.json', () => {
  const out = checkSettings({ settingsText: '{}', hasProjectMcp: false });
  assert.equal(out.length, 1);
  assert.equal(out[0].state, 'ok');
});
