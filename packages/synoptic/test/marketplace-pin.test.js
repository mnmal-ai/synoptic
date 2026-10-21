import assert from 'node:assert/strict';
import { test } from 'vitest';
import { compareVersions as compare } from '../src/fragment-resolve.js';
import {
  auditPin,
  auditSkin,
  newestOpencodeSkin,
  readMarketplacePin,
  stripRefPrefix
} from '../src/marketplace-pin.js';

const MP = (ref) =>
  JSON.stringify({
    name: 'mnmal-ai',
    plugins: [
      { name: 'other', source: { ref: 'v9.9.9' } },
      { name: 'cortext', source: { source: 'git-subdir', url: 'x/y', ref } }
    ]
  });

const fs = (files) => ({
  listDir: (d) => (d === '/mp' ? Object.keys(files) : null),
  readFile: (p) => {
    const m = /^\/mp\/([^/]+)\/\.claude-plugin\/marketplace\.json$/.exec(p);
    return m === null ? null : (files[m[1]] ?? null);
  }
});

test('stripRefPrefix drops a leading v', () => {
  assert.equal(stripRefPrefix('v1.10.0'), '1.10.0');
  assert.equal(stripRefPrefix('1.10.0'), '1.10.0');
});

test('reads the cortext pin from a marketplace clone', () => {
  const { listDir, readFile } = fs({ 'mnmal-ai': MP('v1.10.0') });
  const pin = readMarketplacePin({ marketplacesDir: '/mp', listDir, readFile });
  assert.equal(pin.version, '1.10.0');
  assert.equal(pin.ref, 'v1.10.0');
  assert.equal(pin.marketplace, 'mnmal-ai');
});

test('scans several marketplaces rather than hardcoding the owner', () => {
  const { listDir, readFile } = fs({
    someone: JSON.stringify({ plugins: [{ name: 'unrelated', source: { ref: 'v1' } }] }),
    'mnmal-ai': MP('v1.10.0')
  });
  assert.equal(readMarketplacePin({ marketplacesDir: '/mp', listDir, readFile }).version, '1.10.0');
});

test('a marketplace file that does not parse is skipped, not claimed', () => {
  const { listDir, readFile } = fs({ broken: '{ not json', 'mnmal-ai': MP('v1.10.0') });
  assert.equal(readMarketplacePin({ marketplacesDir: '/mp', listDir, readFile }).version, '1.10.0');
});

test('no marketplace at all yields null rather than a guess', () => {
  assert.equal(
    readMarketplacePin({ marketplacesDir: '/mp', listDir: () => null, readFile: () => null }),
    null
  );
});

// ---- reconciliation ----

test('an absent pin is UNKNOWN — "am I current" cannot be answered locally', () => {
  const out = auditPin({ pin: null, installedVersion: '1.10.0', compare });
  assert.equal(out[0].state, 'unknown');
});

test('an unverified clone is reported as UNKNOWN, not trusted', () => {
  // This is the whole defect: a clone two commits behind reported a stale pin
  // as authoritative, and every check said healthy.
  const out = auditPin({
    pin: { version: '1.10.0', ref: 'v1.10.0', marketplace: 'mnmal-ai' },
    installedVersion: '1.10.0',
    cloneFreshness: 'unchecked',
    compare
  });
  const f = out.find((c) => c.id === 'pin.freshness');
  assert.equal(f.state, 'unknown');
  assert.match(f.detail, /a full release behind while every check said healthy/);
});

// ---- three-state clone freshness ----
//
// A boolean would make "no check ran" and "the check ran and the clone is
// behind" the same value, and the second would render as the caveat telling
// you to run the check.

test('a clone verified BEHIND its remote WARNS, and does not read as unchecked', () => {
  const out = auditPin({
    pin: { version: '1.12.1', ref: 'v1.12.1', marketplace: 'mnmal-ai' },
    installedVersion: '1.12.1',
    cloneFreshness: 'behind',
    cloneDetail: 'local c2be569, remote fc3b8ee — 1 commit(s) behind',
    compare
  });
  const f = out.find((c) => c.id === 'pin.freshness');
  assert.equal(f.state, 'warn');
  assert.match(f.text, /BEHIND its remote/);
  assert.match(f.text, /v1\.12\.1 is STALE/);
  assert.match(f.detail, /local c2be569, remote fc3b8ee/);
  // The caveat it must NOT emit — that sentence tells the reader to run the
  // check that has already run.
  assert.doesNotMatch(f.text, /was not checked/);
  assert.doesNotMatch(f.detail, /Re-run with --fetch/);
  // And the trap it exists to defuse: "installed matches the pin" is still ok
  // here, which on its own reads as healthy.
  assert.equal(out.find((c) => c.id === 'pin.installed').state, 'ok');
  assert.match(f.detail, /can be true and still leave this box a release behind/);
});

test('a clone AHEAD of its remote warns that its pin is not the published one', () => {
  const out = auditPin({
    pin: { version: '1.13.0', ref: 'v1.13.0', marketplace: 'mnmal-ai' },
    installedVersion: '1.13.0',
    cloneFreshness: 'ahead',
    cloneDetail: 'local aaaa111, remote bbbb222 — 2 commit(s) ahead',
    compare
  });
  const f = out.find((c) => c.id === 'pin.freshness');
  assert.equal(f.state, 'warn');
  assert.match(f.text, /AHEAD of its remote/);
});

test('an unrecognised freshness degrades to UNKNOWN, never to current', () => {
  // A caller that stops passing the field, or passes a typo, must report a hole
  // rather than claim health. Fail-closed is the property being asserted.
  for (const bad of [undefined, null, true, false, 'verified', 'CURRENT', '']) {
    const out = auditPin({
      pin: { version: '1.10.0', ref: 'v1.10.0', marketplace: 'mnmal-ai' },
      installedVersion: '1.10.0',
      cloneFreshness: bad,
      compare
    });
    const f = out.find((c) => c.id === 'pin.freshness');
    assert.notEqual(f, undefined, `freshness ${String(bad)} silently claimed a verified clone`);
    assert.equal(f.state, 'unknown');
  }
});

test('a verified clone emits no freshness caveat', () => {
  const out = auditPin({
    pin: { version: '1.10.0', ref: 'v1.10.0', marketplace: 'mnmal-ai' },
    installedVersion: '1.10.0',
    cloneFreshness: 'current',
    compare
  });
  assert.equal(
    out.find((c) => c.id === 'pin.freshness'),
    undefined
  );
  assert.equal(out.find((c) => c.id === 'pin.installed').state, 'ok');
});

test('installed BEHIND the pin warns with the remedy', () => {
  const out = auditPin({
    pin: { version: '1.10.0', ref: 'v1.10.0', marketplace: 'mnmal-ai' },
    installedVersion: '1.9.0',
    cloneFreshness: 'current',
    compare
  });
  const c = out.find((x) => x.id === 'pin.installed');
  assert.equal(c.state, 'warn');
  assert.match(c.text, /BEHIND the pin/);
  assert.match(c.detail, /does not update an already-installed plugin/);
});

test('installed AHEAD of the pin also warns, rather than passing silently', () => {
  const out = auditPin({
    pin: { version: '1.9.0', ref: 'v1.9.0', marketplace: 'mnmal-ai' },
    installedVersion: '1.10.0',
    cloneFreshness: 'current',
    compare
  });
  assert.equal(out.find((x) => x.id === 'pin.installed').state, 'warn');
});

test('version comparison is numeric, so 1.10.0 is not behind 1.9.0', () => {
  const out = auditPin({
    pin: { version: '1.9.0', ref: 'v1.9.0', marketplace: 'mnmal-ai' },
    installedVersion: '1.10.0',
    cloneFreshness: 'current',
    compare
  });
  assert.match(out.find((x) => x.id === 'pin.installed').text, /AHEAD/);
});

test('an unknown installed version cannot be compared and says so', () => {
  const out = auditPin({
    pin: { version: '1.10.0', ref: 'v1.10.0', marketplace: 'mnmal-ai' },
    installedVersion: null,
    cloneFreshness: 'current',
    compare
  });
  assert.equal(out.find((x) => x.id === 'pin.installed').state, 'unknown');
});

// ---- the OpenCode skin against the release ----

test('an opencode skin is compared with the release the marketplace serves', () => {
  const row = (v) => auditSkin({ pinVersion: '1.2.0', opencodeInstalledVersion: v, compare })[0];
  assert.equal(row('1.2.0').state, 'ok');
  assert.equal(row('1.1.0').state, 'warn');
  assert.equal(row('1.3.0').state, 'warn');
  assert.equal(row(null).state, 'unknown');
});

test('no pin leaves the skin unreported: the pin group owns that hole', () => {
  assert.deepEqual(auditSkin({ pinVersion: null, opencodeInstalledVersion: '1.2.0', compare }), []);
});

test('newestOpencodeSkin reads the OpenCode 2.x per-version cache and the 1.x layout', () => {
  const pkg = (v) => JSON.stringify({ name: '@mnmal-ai/cortext-opencode', version: v });
  const files = {
    '/c/node_modules/@mnmal-ai/cortext-opencode/package.json': pkg('2.4.0'),
    '/c/npm/@mnmal-ai/cortext-opencode@2.6.0/111/node_modules/@mnmal-ai/cortext-opencode/package.json':
      pkg('2.6.0'),
    '/c/npm/@mnmal-ai/cortext-opencode@2.13.1/222/node_modules/@mnmal-ai/cortext-opencode/package.json':
      pkg('2.13.1')
  };
  const dirs = {
    '/c/npm/@mnmal-ai': ['cortext-opencode@2.6.0', 'cortext-opencode@2.13.1', 'other@1.0.0'],
    '/c/npm/@mnmal-ai/cortext-opencode@2.6.0': ['111'],
    '/c/npm/@mnmal-ai/cortext-opencode@2.13.1': ['222']
  };
  const io = { listDir: (d) => dirs[d] ?? [], readFile: (p) => files[p] ?? null, compare };
  assert.equal(newestOpencodeSkin({ cacheRoot: '/c', ...io }), '2.13.1');
  assert.equal(newestOpencodeSkin({ cacheRoot: '/empty', ...io }), null);
});
