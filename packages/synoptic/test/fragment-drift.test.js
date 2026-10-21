/**
 * Cold-start drift detection for the conventions fragment.
 *
 * The cases cover the distinct marker states a fleet holds, each of which
 * needs something different done to it.
 */

import { describe, expect, it, test } from 'vitest';
import {
  compareFragments,
  fragmentDriftCheck,
  fragmentDriftWarning,
  readMarker,
  renderFragmentDrift
} from '../src/fragment-drift.js';

const CURRENT =
  '<!-- substrate-conventions vsynoptic-1.4.1+446ab494 — plugin-owned; do not edit. -->';
const OLD_CONTENT = '<!-- substrate-conventions vsynoptic-1.0.0+77a14d34 — plugin-owned; -->';
const SAME_CONTENT_OLD_VERSION =
  '<!-- substrate-conventions vsynoptic-1.2.1+446ab494 — plugin-owned; -->';
const PRE_DIGEST = '<!-- substrate-conventions vsynoptic-0.1.0 — plugin-owned; do not edit. -->';

describe('readMarker', () => {
  it('reads version and digest', () => {
    expect(readMarker(CURRENT)).toEqual({ version: '1.4.1', digest: '446ab494' });
  });

  it('reports a pre-digest marker as digest:null rather than failing to parse', () => {
    // `null` is an ANSWER — "this marker cannot carry a
    // content comparison" — and collapsing it into a parse failure would make
    // an old-but-parseable file look like a corrupt one.
    expect(readMarker(PRE_DIGEST)).toEqual({ version: '0.1.0', digest: null });
  });

  it('returns null when line 1 is not a marker', () => {
    expect(readMarker('# Substrate interaction conventions')).toBeNull();
    expect(readMarker('')).toBeNull();
  });

  it('only ever looks at line 1', () => {
    // A marker further down the file is prose about the marker, not the marker.
    expect(readMarker(`# Title\n${CURRENT}`)).toBeNull();
  });
});

describe('compareFragments', () => {
  it('is silent for a repo that never installed the fragment', () => {
    expect(compareFragments({ installed: null, plugin: CURRENT })).toEqual({ state: 'absent' });
  });

  it('flags a differing DIGEST as stale — substrate / substrate-client', () => {
    // These two were genuinely missing the paragraph making `namespace`
    // required on recall, so an agent following them hits
    // `missing_namespace` on first use.
    const result = compareFragments({ installed: OLD_CONTENT, plugin: CURRENT });
    expect(result.state).toBe('stale');
    expect(renderFragmentDrift(result)).toContain('content differs');
  });

  it('stays SILENT when only the version differs — brain', () => {
    // The case that decides the whole design. Two minors back with a
    // byte-identical body: keying on version would fire a warning on a correct
    // install, and a warning that fires when nothing is wrong is one people
    // learn to skip.
    const result = compareFragments({ installed: SAME_CONTENT_OLD_VERSION, plugin: CURRENT });
    expect(result.state).toBe('current');
    expect(result.versionDrift).toBe(true);
    expect(renderFragmentDrift(result)).toBe('');
  });

  it('flags a pre-digest marker as unverifiable, not as stale', () => {
    const result = compareFragments({ installed: PRE_DIGEST, plugin: CURRENT });
    expect(result.state).toBe('undigested');
    const rendered = renderFragmentDrift(result);
    expect(rendered).toContain('cannot be verified');
    expect(rendered).not.toContain('content differs');
  });

  it('is silent when installed and plugin agree exactly', () => {
    const result = compareFragments({ installed: CURRENT, plugin: CURRENT });
    expect(result).toMatchObject({ state: 'current', versionDrift: false });
    expect(renderFragmentDrift(result)).toBe('');
  });
});

describe('the check reports its own inability to run', () => {
  /**
   * Silence must mean compared-and-equal and
   * nothing else — so a check that CANNOT compare is louder than one that finds
   * a stale file, because the stale file at least got measured.
   */
  it('reports an unreadable plugin fragment', () => {
    const result = compareFragments({ installed: CURRENT, plugin: null });
    expect(result.state).toBe('uncomparable');
    expect(renderFragmentDrift(result)).toContain('did not run');
  });

  it('reports an installed file whose line 1 is not a marker', () => {
    const result = compareFragments({ installed: '# hand-written notes', plugin: CURRENT });
    expect(result.state).toBe('uncomparable');
  });

  it('does not silently pass when the PLUGIN copy has no digest', () => {
    // Nothing to compare against. Reporting "current" here would be asserting
    // equality that was never established.
    const result = compareFragments({ installed: CURRENT, plugin: PRE_DIGEST });
    expect(result.state).toBe('uncomparable');
  });
});

describe('fragmentDriftWarning', () => {
  const reader = (files) => (path) => files[path] ?? null;

  it('stays silent for a repo with no installed fragment, even if the plugin is unreadable', () => {
    // Order matters: a checkout that never onboarded must not be nagged about
    // the plugin side. Bail on `absent` BEFORE looking at the plugin copy.
    expect(fragmentDriftWarning({ cwd: '/repo', pluginRoot: null, readFile: reader({}) })).toBe('');
  });

  it('warns on a real stale install', () => {
    const out = fragmentDriftWarning({
      cwd: '/repo',
      pluginRoot: '/plugin',
      readFile: reader({
        '/repo/.claude/substrate-conventions.md': OLD_CONTENT,
        '/plugin/fragments/substrate-conventions.md': CURRENT
      })
    });
    expect(out).toContain('STALE');
    expect(out).toContain('resolve-fragment.mjs');
  });

  it('never throws, whatever the reader does', () => {
    // A SessionStart hook must degrade to less context, never to no context.
    expect(
      fragmentDriftWarning({
        cwd: '/repo',
        pluginRoot: '/plugin',
        readFile: () => {
          throw new Error('EACCES');
        }
      })
    ).toBe('');
  });
});

describe('fragmentDriftWarning compares against the BEST available', () => {
  const marker = (v, d) => `<!-- substrate-conventions vsynoptic-${v}+${d} -->\nbody for ${v}\n`;

  // Not ${pluginRoot}: a session running when the plugin updated would compare
  // against a stale reference and report "current" while corrections are missing.
  it('sees a newer cached version than the one that served this session', () => {
    const files = {
      '/repo/.claude/substrate-conventions.md': marker('1.6.0', '09c3e55b'),
      '/cache/1.6.0/fragments/substrate-conventions.md': marker('1.6.0', '09c3e55b'),
      '/cache/1.9.0/fragments/substrate-conventions.md': marker('1.9.0', 'e25b9217')
    };
    const out = fragmentDriftWarning({
      cwd: '/repo',
      pluginRoot: '/cache/1.6.0',
      readFile: (p) => files[p] ?? null,
      listDir: () => ['1.6.0', '1.9.0'],
      cacheDir: '/cache'
    });
    expect(out).toContain('STALE');
    expect(out).toContain('e25b9217');
  });

  it('stays silent when the repo already matches the best available', () => {
    const files = {
      '/repo/.claude/substrate-conventions.md': marker('1.9.0', 'e25b9217'),
      '/cache/1.6.0/fragments/substrate-conventions.md': marker('1.6.0', '09c3e55b'),
      '/cache/1.9.0/fragments/substrate-conventions.md': marker('1.9.0', 'e25b9217')
    };
    const out = fragmentDriftWarning({
      cwd: '/repo',
      pluginRoot: '/cache/1.6.0',
      readFile: (p) => files[p] ?? null,
      listDir: () => ['1.6.0', '1.9.0'],
      cacheDir: '/cache'
    });
    expect(out).toBe('');
  });

  it('falls back to the served copy when the cache cannot be listed', () => {
    // Pre-existing behaviour, so an unlistable cache is not a regression.
    const files = {
      '/repo/.claude/substrate-conventions.md': marker('1.0.0', 'aaaaaaaa'),
      '/cache/1.6.0/fragments/substrate-conventions.md': marker('1.6.0', '09c3e55b')
    };
    const out = fragmentDriftWarning({
      cwd: '/repo',
      pluginRoot: '/cache/1.6.0',
      readFile: (p) => files[p] ?? null,
      listDir: () => null,
      cacheDir: '/cache'
    });
    expect(out).toContain('09c3e55b');
  });

  it('names a single safe command as the remedy, not the nine-step skill', () => {
    // A warning whose remedy is expensive has a predictable steady state:
    // ignored across releases.
    const files = {
      '/repo/.claude/substrate-conventions.md': marker('1.0.0', 'aaaaaaaa'),
      '/cache/1.9.0/fragments/substrate-conventions.md': marker('1.9.0', 'e25b9217')
    };
    const out = fragmentDriftWarning({
      cwd: '/repo',
      pluginRoot: '/cache/1.9.0',
      readFile: (p) => files[p] ?? null,
      listDir: () => ['1.9.0'],
      cacheDir: '/cache'
    });
    expect(out).toContain(`resolve-fragment.mjs" --target-dir "$PWD" --apply`);
    expect(out).not.toContain('Re-run `/substrate-setup`');
  });
});

test('fragmentDriftWarning stays silent in the repo that SHIPS the fragment', () => {
  // The source tree carries an unreleased digest; calling it STALE would advise
  // a command that reverts the edit in progress. A detector contradicting the
  // installer is worse than silence.
  const files = {
    '/repo/.claude/substrate-conventions.md':
      '<!-- substrate-conventions vsynoptic-1.9.0+cccccccc -->\nx',
    '/repo/packages/cortext-plugin/fragments/substrate-conventions.md':
      '<!-- substrate-conventions vsynoptic-1.9.0+cccccccc -->\nx',
    '/cache/1.9.0/fragments/substrate-conventions.md':
      '<!-- substrate-conventions vsynoptic-1.9.0+e25b9217 -->\ny'
  };
  const out = fragmentDriftWarning({
    cwd: '/repo',
    pluginRoot: '/cache/1.9.0',
    readFile: (p) => files[p] ?? null,
    listDir: () => ['1.9.0'],
    cacheDir: '/cache'
  });
  expect(out).toBe('');
});

// A stale-fragment warning with no sense of distance has one volume, so seven
// releases behind reads like one. Distance escalates the headline; the remedy
// stays the same one command.
describe('stale-fragment escalation by distance', () => {
  const stale = (installed, plugin) =>
    renderFragmentDrift(
      compareFragments({
        installed: `<!-- substrate-conventions vsynoptic-${installed}+11111111 -->`,
        plugin: `<!-- substrate-conventions vsynoptic-${plugin}+22222222 -->`
      })
    );

  it('a recent lag keeps the ordinary warning', () => {
    const out = stale('1.3.0', '1.4.1');
    expect(out).toContain('⚠️');
    expect(out).not.toContain('🛑');
  });

  it('three or more minor releases behind escalates and names the distance', () => {
    const out = stale('1.0.0', '1.4.1');
    expect(out).toContain('🛑');
    expect(out).toContain('4 minor releases behind');
    expect(out).toContain('resolve-fragment.mjs');
  });

  it('a major release behind escalates regardless of minors', () => {
    const out = stale('1.9.0', '2.0.0');
    expect(out).toContain('🛑');
    expect(out).toContain('a major release behind');
  });

  it('a lead (installed newer than the plugin) is not called behind', () => {
    const out = stale('2.0.0', '1.4.1');
    expect(out).not.toContain('🛑');
    expect(out).not.toContain('behind');
  });
});

// A repo with an agent identity is onboarded, so a
// missing fragment there is a gap, not a non-consumer. Without an identity the
// checkout never opted in and stays silent.
describe('missing fragment in an onboarded repo', () => {
  const reader = (files) => (path) => files[path] ?? null;

  it('warns, naming /substrate-setup, when the repo has an identity but no fragment', () => {
    const out = fragmentDriftWarning({
      cwd: '/repo',
      pluginRoot: '/plugin',
      readFile: reader({ '/plugin/fragments/substrate-conventions.md': CURRENT }),
      onboarded: true
    });
    expect(out).toContain('no conventions fragment');
    expect(out).toContain('/substrate-setup');
  });

  it('stays silent for a checkout with no identity, as before', () => {
    expect(
      fragmentDriftWarning({ cwd: '/repo', pluginRoot: '/plugin', readFile: reader({}) })
    ).toBe('');
  });

  it('stays silent in the repo that SHIPS the fragment, even onboarded', () => {
    expect(
      fragmentDriftWarning({
        cwd: '/repo',
        pluginRoot: '/plugin',
        readFile: reader({
          '/repo/packages/cortext-plugin/fragments/substrate-conventions.md': CURRENT
        }),
        onboarded: true
      })
    ).toBe('');
  });
});

describe('fragmentDriftCheck', () => {
  const reader = (files) => (path) => files[path] ?? null;

  it('returns the comparison with the installed marker', () => {
    const out = fragmentDriftCheck({
      cwd: '/repo',
      pluginRoot: '/plugin',
      readFile: reader({
        '/repo/.claude/substrate-conventions.md': OLD_CONTENT,
        '/plugin/fragments/substrate-conventions.md': CURRENT
      })
    });
    expect(out.state).toBe('stale');
    expect(out.installed).toEqual({ version: '1.0.0', digest: '77a14d34' });
  });

  it('names the source repo, missing and absent', () => {
    const src = reader({
      '/repo/packages/cortext-plugin/fragments/substrate-conventions.md': CURRENT
    });
    expect(fragmentDriftCheck({ cwd: '/repo', pluginRoot: null, readFile: src }).state).toBe(
      'source'
    );
    expect(
      fragmentDriftCheck({ cwd: '/repo', pluginRoot: null, readFile: reader({}), onboarded: true })
        .state
    ).toBe('missing');
    expect(fragmentDriftCheck({ cwd: '/repo', pluginRoot: null, readFile: reader({}) }).state).toBe(
      'absent'
    );
  });

  it('carries the source repo installed marker when it has one', () => {
    const out = fragmentDriftCheck({
      cwd: '/repo',
      pluginRoot: null,
      readFile: reader({
        '/repo/packages/cortext-plugin/fragments/substrate-conventions.md': CURRENT,
        '/repo/.claude/substrate-conventions.md': CURRENT
      })
    });
    expect(out).toEqual({ state: 'source', installed: { version: '1.4.1', digest: '446ab494' } });
  });

  it('returns null instead of throwing', () => {
    expect(
      fragmentDriftCheck({
        cwd: '/repo',
        pluginRoot: null,
        readFile: () => {
          throw new Error('boom');
        }
      })
    ).toBeNull();
  });
});
