import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  auditFleetFragments,
  normaliseHost,
  readFragment,
  scopeFleetToHost
} from '../src/fleet-fragments.js';

// Deterministic stand-in for sha256/8 — the real digest is injected, so the
// rules are testable without hashing.
const digest = (body) => `d${[...body].reduce((a, c) => (a + c.charCodeAt(0)) % 9973, 0)}`;
const frag = (version, claimed, body) =>
  `<!-- substrate-conventions vsynoptic-${version}${claimed ? `+${claimed}` : ''} -->\n${body}`;

const find = (out, id) => out.findings.find((f) => f.id === id);

test('readFragment splits marker from the body the digest covers', () => {
  const f = readFragment(frag('1.11.0', 'cd38093c', 'the body\n'));
  assert.equal(f.version, '1.11.0');
  assert.equal(f.claimed, 'cd38093c');
  assert.equal(f.body, 'the body\n');
});

test('readFragment returns null for a file with no marker', () => {
  assert.equal(readFragment('# just a heading\nbody'), null);
  assert.equal(readFragment('no newline at all'), null);
});

test('THE HEADLINE: distinct bodies across repos is the finding, not per-repo staleness', () => {
  // A fleet in miniature: several repos, several bodies.
  const best = frag('1.11.0', digest('new'), 'new');
  const out = auditFleetFragments({
    repos: [
      { name: 'synoptic', text: frag('1.11.0', digest('new'), 'new') },
      { name: 'substrate', text: frag('1.5.0', digest('old'), 'old') },
      { name: 'brain', text: frag('1.2.1', digest('ancient'), 'ancient') }
    ],
    best,
    digest
  });
  const spread = find(out, 'fleet.spread');
  assert.equal(spread.state, 'warn');
  assert.match(spread.text, /3 repos hold 3 DISTINCT fragment bodies/);
  assert.match(spread.detail, /propagation mechanism is not reaching every consumer/);
});

test('a consistent fleet reports ok on the spread', () => {
  const body = 'same';
  const out = auditFleetFragments({
    repos: ['a', 'b', 'c'].map((n) => ({ name: n, text: frag('1.11.0', digest(body), body) })),
    best: frag('1.11.0', digest(body), body),
    digest
  });
  assert.equal(find(out, 'fleet.spread').state, 'ok');
  assert.equal(find(out, 'fleet.current').state, 'ok');
});

test('a marker that disagrees with its OWN body is reported, and says why it outranks staleness', () => {
  // A hand-edited fragment keeps its marker and changes its body. Every
  // digest-based check downstream is then reading a claim, not the content.
  const out = auditFleetFragments({
    repos: [{ name: 'tampered', text: frag('1.11.0', 'aaaaaaaa', 'actually different') }],
    best: frag('1.11.0', 'aaaaaaaa', 'actually different'),
    digest
  });
  const m = find(out, 'fleet.marker');
  assert.equal(m.state, 'warn');
  assert.match(m.text, /claims aaaaaaaa, is d/);
  assert.match(m.detail, /reading a claim rather than the content/);
});

test('an honest marker produces no marker finding', () => {
  const body = 'x';
  const out = auditFleetFragments({
    repos: [{ name: 'ok', text: frag('1.11.0', digest(body), body) }],
    best: frag('1.11.0', digest(body), body),
    digest
  });
  assert.equal(find(out, 'fleet.marker'), undefined);
});

test('repos behind the best available are NAMED, with the one-command remedy', () => {
  const out = auditFleetFragments({
    repos: [
      { name: 'current', text: frag('1.11.0', digest('new'), 'new') },
      { name: 'stale', text: frag('1.5.0', digest('old'), 'old') }
    ],
    best: frag('1.11.0', digest('new'), 'new'),
    digest
  });
  const c = find(out, 'fleet.current');
  assert.equal(c.state, 'warn');
  assert.match(c.text, /stale \(1\.5\.0/);
  assert.ok(!c.text.includes('current ('), 'a matching repo is not listed as behind');
  assert.match(c.detail, /resolve-fragment\.mjs --target-dir/);
});

test('no plugin fragment to compare against is UNKNOWN — but the spread still stands', () => {
  // Repos disagreeing with EACH OTHER is a finding regardless of which is right.
  const out = auditFleetFragments({
    repos: [
      { name: 'a', text: frag('1.11.0', digest('x'), 'x') },
      { name: 'b', text: frag('1.5.0', digest('y'), 'y') }
    ],
    best: null,
    digest
  });
  assert.equal(find(out, 'fleet.current').state, 'unknown');
  assert.equal(find(out, 'fleet.spread').state, 'warn');
});

test('an unreadable fragment is UNKNOWN and the spread is called a FLOOR', () => {
  // Counting it as absent would understate the disagreement.
  const out = auditFleetFragments({
    repos: [
      { name: 'a', text: frag('1.11.0', digest('x'), 'x') },
      { name: 'locked', text: null }
    ],
    best: frag('1.11.0', digest('x'), 'x'),
    digest
  });
  const u = find(out, 'fleet.unreadable');
  assert.equal(u.state, 'unknown');
  assert.match(u.detail, /the spread is a floor/);
});

test('a fragment with no marker is reported rather than silently skipped', () => {
  const out = auditFleetFragments({
    repos: [{ name: 'broken', text: 'no marker here\nbody' }],
    best: null,
    digest
  });
  const p = find(out, 'fleet.unparsed');
  assert.equal(p.state, 'warn');
  assert.match(p.detail, /cannot be compared or updated by digest/);
});

test('an empty fleet says nothing rather than claiming consistency', () => {
  const out = auditFleetFragments({ repos: [], best: null, digest });
  assert.equal(find(out, 'fleet.spread'), undefined);
});

// ---- disk and HEAD are different artifacts ----
//
// Where the fragment is TRACKED, an uncommitted /substrate-setup makes the file on
// disk and the file the team shares disagree. Both directions mislead — the
// install looks landed to the audit and absent to anyone who clones — so both
// are reported.

test('fleet: a tracked fragment whose HEAD differs from disk is reported', () => {
  const out = auditFleetFragments({
    repos: [
      {
        name: 'ledger',
        text: frag('1.12.1', 'x', 'new\n'),
        committed: frag('1.5.0', 'y', 'old\n')
      }
    ],
    best: frag('1.12.1', 'x', 'new\n'),
    digest
  });
  const f = find(out, 'fleet.uncommitted');
  assert.ok(f, 'expected a fleet.uncommitted finding');
  assert.equal(f.state, 'warn');
  assert.match(f.text, /ledger/);
  assert.match(f.text, /1\.12\.1/);
  assert.match(f.text, /1\.5\.0/);
});

test('fleet: disk matching HEAD produces no uncommitted finding', () => {
  const same = frag('1.12.1', 'x', 'new\n');
  const out = auditFleetFragments({
    repos: [{ name: 'holomap', text: same, committed: same }],
    best: same,
    digest
  });
  assert.equal(find(out, 'fleet.uncommitted'), undefined);
});

test('fleet: an UNTRACKED fragment is not drift — committed:null is a legitimate state', () => {
  const out = auditFleetFragments({
    repos: [{ name: 'app', text: frag('1.12.1', 'x', 'new\n'), committed: null }],
    best: frag('1.12.1', 'x', 'new\n'),
    digest
  });
  assert.equal(find(out, 'fleet.uncommitted'), undefined);
});

test('fleet: omitting committed entirely claims nothing about git', () => {
  // The caller did not ask the question, so the audit must not answer it.
  const out = auditFleetFragments({
    repos: [{ name: 'substrate', text: frag('1.12.1', 'x', 'new\n') }],
    best: frag('1.12.1', 'x', 'new\n'),
    digest
  });
  assert.equal(find(out, 'fleet.uncommitted'), undefined);
});

test('fleet: the uncommitted check does not override the spread headline', () => {
  // Disk is what the agent in that repo actually reads, so it stays operative
  // for the body-spread comparison. HEAD drift is reported ALONGSIDE, never
  // instead of.
  const out = auditFleetFragments({
    repos: [
      { name: 'a', text: frag('1.12.1', 'x', 'new\n'), committed: frag('1.5.0', 'y', 'old\n') },
      { name: 'b', text: frag('1.12.1', 'x', 'new\n'), committed: frag('1.12.1', 'x', 'new\n') }
    ],
    best: frag('1.12.1', 'x', 'new\n'),
    digest
  });
  assert.equal(find(out, 'fleet.spread').state, 'ok');
  assert.equal(find(out, 'fleet.uncommitted').state, 'warn');
});

// ---- the SOURCE repo is authoritative, not a consumer ----
//
// `best` is the last RELEASED fragment, so the repo that ships it leads the
// release for the whole window between a fragment edit and its publish. Calling
// that tree drifted would name a remedy that overwrites it with the older copy.

const SRC = frag('2.0.0', null, 'NEW source body\n');
const REL = frag('1.0.0', null, 'released body\n');

test('the source repo is not counted as behind, and is reported separately', () => {
  const out = auditFleetFragments({
    repos: [
      { name: 'synoptic', text: SRC },
      { name: 'ledger', text: REL },
      { name: 'holomap', text: REL }
    ],
    best: REL,
    sourceRepo: 'synoptic',
    digest
  });
  const current = find(out, 'fleet.current');
  assert.equal(current.state, 'ok');
  assert.match(current.text, /all consumer repos match/);
  assert.doesNotMatch(current.text, /synoptic/);

  // Reported, never silent — an unpublished edit is what a reader wants to know.
  const src = find(out, 'fleet.source');
  assert.equal(src.state, 'ok');
  assert.match(src.text, /synoptic SHIPS the fragment/);
  assert.match(src.detail, /release trailing the source rather than the source drifting/);
});

test('a source repo in sync emits NO extra finding — no noise in the normal state', () => {
  const out = auditFleetFragments({
    repos: [
      { name: 'synoptic', text: REL },
      { name: 'ledger', text: REL }
    ],
    best: REL,
    sourceRepo: 'synoptic',
    digest
  });
  assert.equal(find(out, 'fleet.source'), undefined);
  assert.equal(find(out, 'fleet.current').state, 'ok');
});

test('a genuinely stale CONSUMER is still named even while the source leads', () => {
  // The source being ahead must not mask a real propagation failure.
  const STALE = frag('0.9.0', null, 'ancient body\n');
  const out = auditFleetFragments({
    repos: [
      { name: 'synoptic', text: SRC },
      { name: 'ledger', text: REL },
      { name: 'substrate', text: STALE }
    ],
    best: REL,
    sourceRepo: 'synoptic',
    digest
  });
  const current = find(out, 'fleet.current');
  assert.equal(current.state, 'warn');
  assert.match(current.text, /substrate/);
  assert.doesNotMatch(current.text, /synoptic/);
  assert.match(current.detail, /resolve-fragment/);
});

test('the spread attributes a source-only difference to the unpublished source', () => {
  const out = auditFleetFragments({
    repos: [
      { name: 'synoptic', text: SRC },
      { name: 'ledger', text: REL },
      { name: 'holomap', text: REL }
    ],
    best: REL,
    sourceRepo: 'synoptic',
    digest
  });
  const spread = find(out, 'fleet.spread');
  // Still a warn, still counting every repo — the source is NOT dropped from
  // the tally. A fleet view that silently omits a repo is the failure this
  // audit exists to catch.
  assert.equal(spread.state, 'warn');
  assert.match(spread.text, /3 repos hold 2 DISTINCT/);
  assert.match(spread.detail, /every consumer agrees/);
  assert.match(spread.detail, /propagation is not implicated/);
  assert.match(spread.detail, /synoptic/);
});

test('consumers disagreeing among themselves still blames propagation', () => {
  const STALE = frag('0.9.0', null, 'ancient body\n');
  const out = auditFleetFragments({
    repos: [
      { name: 'synoptic', text: SRC },
      { name: 'ledger', text: REL },
      { name: 'substrate', text: STALE }
    ],
    best: REL,
    sourceRepo: 'synoptic',
    digest
  });
  const spread = find(out, 'fleet.spread');
  assert.match(spread.detail, /propagation mechanism is not reaching every consumer/);
  assert.doesNotMatch(spread.detail, /every consumer agrees/);
});

test('with NO sourceRepo the old behaviour is preserved exactly', () => {
  // Fails safe: a caller that stops passing it gets the plain drift report rather
  // than a repo silently exempted from the comparison.
  const out = auditFleetFragments({
    repos: [
      { name: 'synoptic', text: SRC },
      { name: 'ledger', text: REL }
    ],
    best: REL,
    digest
  });
  const current = find(out, 'fleet.current');
  assert.equal(current.state, 'warn');
  assert.match(current.text, /synoptic/);
  assert.equal(find(out, 'fleet.source'), undefined);
  assert.match(find(out, 'fleet.spread').detail, /propagation mechanism is not reaching/);
});

// ---- a STALE checkout of the source repo is not "ahead" ----
//
// The source repo is authoritative only while its checkout is current. A clone
// on an old branch carries the OLD body and is behind the release, not ahead.
// The distinguishing fact is cheap: a source repo that is ahead has the released
// body somewhere in its history; a stale clone never received it.

const OLD = frag('0.9.0', null, 'old body\n');

test('a source whose history lacks the released body is BEHIND, not ahead', () => {
  const out = auditFleetFragments({
    repos: [
      { name: 'synoptic', text: OLD },
      { name: 'app', text: REL }
    ],
    best: REL,
    sourceRepo: 'synoptic',
    sourceGit: { releasedInHistory: false },
    digest
  });
  const src = find(out, 'fleet.source');
  assert.equal(src.state, 'warn');
  assert.match(src.text, /BEHIND/);
  assert.doesNotMatch(src.detail, /release trailing the source/);
  assert.match(src.detail, /pull/i);
  // The spread must not attribute it to an unpublished edit either.
  const spread = find(out, 'fleet.spread');
  assert.doesNotMatch(spread.detail, /leads the release/);
  assert.match(spread.detail, /BEHIND/);
});

test('a source whose history HAS the released body is ahead', () => {
  const out = auditFleetFragments({
    repos: [
      { name: 'synoptic', text: SRC },
      { name: 'app', text: REL }
    ],
    best: REL,
    sourceRepo: 'synoptic',
    sourceGit: { releasedInHistory: true },
    digest
  });
  const src = find(out, 'fleet.source');
  assert.equal(src.state, 'ok');
  assert.match(src.detail, /release trailing the source/);
});

test('when git could not answer, the direction is UNKNOWN rather than assumed', () => {
  const out = auditFleetFragments({
    repos: [
      { name: 'synoptic', text: SRC },
      { name: 'app', text: REL }
    ],
    best: REL,
    sourceRepo: 'synoptic',
    sourceGit: { releasedInHistory: null },
    digest
  });
  const src = find(out, 'fleet.source');
  assert.equal(src.state, 'unknown');
  assert.match(src.detail, /ahead|behind/);
});

test('a source checkout behind its upstream is its own finding, even in sync', () => {
  const out = auditFleetFragments({
    repos: [
      { name: 'synoptic', text: REL },
      { name: 'app', text: REL }
    ],
    best: REL,
    sourceRepo: 'synoptic',
    sourceGit: {
      releasedInHistory: true,
      branch: 'main',
      defaultBranch: 'main',
      behindUpstream: 4
    },
    digest
  });
  const co = find(out, 'fleet.source-checkout');
  assert.equal(co.state, 'warn');
  assert.match(co.text, /4 commit/);
});

test('a source checkout on a non-default branch is noted, not warned', () => {
  const out = auditFleetFragments({
    repos: [{ name: 'synoptic', text: REL }],
    best: REL,
    sourceRepo: 'synoptic',
    sourceGit: {
      releasedInHistory: true,
      branch: 'feature/x',
      defaultBranch: 'main',
      behindUpstream: 0
    },
    digest
  });
  const co = find(out, 'fleet.source-checkout');
  assert.equal(co.state, 'ok');
  assert.match(co.text, /feature\/x/);
  assert.match(co.text, /main/);
});

test('a current source checkout on the default branch says nothing', () => {
  const out = auditFleetFragments({
    repos: [{ name: 'synoptic', text: REL }],
    best: REL,
    sourceRepo: 'synoptic',
    sourceGit: {
      releasedInHistory: true,
      branch: 'main',
      defaultBranch: 'main',
      behindUpstream: 0
    },
    digest
  });
  assert.equal(find(out, 'fleet.source-checkout'), undefined);
});

// ---- survey only repos worked on THIS host ----
//
// A checkout on a host that does not work the project is a scratch tree, not
// drift. The directory already says where each project is worked.

// A directory spanning two hosts, with inactive rows.
const DIRECTORY = [
  { kid: 'app-claude@deskbook', active: true, project: 'app', host: 'deskbook' },
  { kid: 'substrate-claude@Desk', active: true, project: 'substrate', host: 'Desk' },
  { kid: 'holomap-claude@Desk', active: true, project: 'holomap', host: 'Desk' },
  { kid: 'synoptic-claude@Desk', active: true, project: 'synoptic', host: 'Desk' },
  // Inactive rows place nothing — a retired identity is not where work happens.
  { kid: 'tools-claude@Desk', active: false, project: 'tools', host: 'Desk' },
  { kid: 'synoptic-claude@deskbook', active: false, project: null, host: 'deskbook' }
];

test('hostnames compare case- and domain-insensitively', () => {
  assert.equal(normaliseHost('Desk'), normaliseHost('desk.local'));
  assert.equal(normaliseHost(null), '');
});

test('repos are split into here, elsewhere and unclaimed', () => {
  const out = scopeFleetToHost({
    repoNames: ['substrate', 'holomap', 'synoptic', 'app', 'tools', 'scratch'],
    thisHost: 'deskbook',
    directoryRows: DIRECTORY
  });
  assert.equal(out.placed, true);
  assert.deepEqual(out.here, ['app']);
  assert.deepEqual(
    out.elsewhere.map((e) => e.name),
    ['substrate', 'holomap', 'synoptic']
  );
  assert.deepEqual(out.elsewhere[0].hosts, ['Desk']);
  // tools has only an INACTIVE row, so nothing claims it.
  assert.deepEqual(out.unclaimed, ['tools', 'scratch']);

  const elsewhere = find(out, 'fleet.elsewhere');
  assert.equal(elsewhere.state, 'unknown');
  assert.match(elsewhere.text, /substrate \(worked on Desk\)/);
  assert.equal(find(out, 'fleet.unclaimed').state, 'unknown');
});

test('on the host that works them, repos are surveyed, case notwithstanding', () => {
  const out = scopeFleetToHost({
    repoNames: ['substrate', 'synoptic'],
    thisHost: 'desk',
    directoryRows: DIRECTORY
  });
  assert.deepEqual(out.here, ['substrate', 'synoptic']);
  assert.deepEqual(out.findings, []);
});

test('a host is read from the kid when the row carries none', () => {
  const out = scopeFleetToHost({
    repoNames: ['substrate'],
    thisHost: 'Desk',
    directoryRows: [{ kid: 'substrate-claude@Desk', active: true, project: 'substrate' }]
  });
  assert.deepEqual(out.here, ['substrate']);
});

test('an unreadable directory places NOTHING — never everything', () => {
  // Surveying every local checkout as if it were worked here IS the bug.
  for (const [thisHost, directoryRows] of [
    ['Desk', null],
    ['', DIRECTORY]
  ]) {
    const out = scopeFleetToHost({ repoNames: ['substrate', 'app'], thisHost, directoryRows });
    assert.equal(out.placed, false);
    assert.deepEqual(out.here, []);
    const pop = find(out, 'fleet.population');
    assert.equal(pop.state, 'unknown');
    assert.match(pop.detail, /2 local checkout\(s\) were NOT surveyed/);
  }
});

test('the spread line states the population it counted', () => {
  const body = 'same';
  const out = auditFleetFragments({
    repos: ['substrate', 'synoptic'].map((n) => ({
      name: n,
      text: frag('1.11.0', digest(body), body)
    })),
    best: frag('1.11.0', digest(body), body),
    digest,
    population: { elsewhere: 3, unclaimed: 0 }
  });
  assert.equal(
    find(out, 'fleet.spread').text,
    'all 2 repos worked here hold the same fragment body (3 local copies of repos not worked here not counted)'
  );
});

test('with nothing surveyed, "all consumers match" is not claimed', () => {
  const body = 'same';
  const out = auditFleetFragments({
    repos: [],
    best: frag('1.11.0', digest(body), body),
    digest,
    population: { elsewhere: 3, unclaimed: 0 }
  });
  assert.equal(find(out, 'fleet.current'), undefined);
});

// A repo the directory places on THIS host has an agent
// that opted in, so no fragment there is a gap, never an omission. The roster
// is the AgentIdentity directory scopeFleetToHost already reads; a checkout it
// does not place stays out, as before.
test('a placed repo with no fragment warns, naming /substrate-setup', () => {
  const out = auditFleetFragments({
    repos: [{ name: 'substrate', text: frag('1.11.0', null, 'body\n') }],
    best: frag('1.11.0', null, 'body\n'),
    digest,
    missing: ['holomap']
  });
  const f = find(out, 'fleet.missing');
  assert.equal(f.state, 'warn');
  assert.match(f.text, /1 repo\(s\) worked here have no conventions fragment: holomap/);
  assert.match(f.detail, /\/substrate-setup/);
});

test('no missing repos, no finding', () => {
  const out = auditFleetFragments({
    repos: [{ name: 'substrate', text: frag('1.11.0', null, 'body\n') }],
    best: frag('1.11.0', null, 'body\n'),
    digest
  });
  assert.equal(find(out, 'fleet.missing'), undefined);
});
