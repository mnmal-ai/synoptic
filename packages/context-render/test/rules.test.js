import { describe, expect, it } from 'vitest';
import {
  renderRuleFull,
  renderRuleGroups,
  renderRuleSkim,
  renderRuleTiers,
  tierRules
} from '../src/index.js';

const r = (ref, over = {}) => ({ ref, body: `${ref} body`, synopsis: `${ref} syn`, ...over });
const refs = (xs) => xs.map((x) => x.ref);

describe('tierRules', () => {
  it('puts every must in the must tier, pinned or not, and never ranks it', () => {
    const t = tierRules([
      r('m1', { severity: 'must', score: -5 }),
      r('m2', { severity: 'must', pinned: true }),
      r('s1', { score: 9 })
    ]);
    expect(refs(t.must)).toEqual(['m1', 'm2']);
    expect(refs(t.pinned)).toEqual([]);
    expect(refs(t.salient)).toEqual(['s1']);
  });

  it('treats any severity other than must as advisory', () => {
    const t = tierRules([r('a', { severity: 'should' }), r('b'), r('c', { severity: 'high' })]);
    expect(t.must).toEqual([]);
    expect(refs(t.salient)).toEqual(['a', 'b', 'c']);
  });

  it('keeps pinned advisory rules in input order, outside the ranking', () => {
    const t = tierRules(
      [
        r('p2', { pinned: true, score: 0 }),
        r('x', { score: 1 }),
        r('p1', { pinned: true, score: 9 })
      ],
      {
        topK: 0
      }
    );
    expect(refs(t.pinned)).toEqual(['p2', 'p1']);
    expect(refs(t.skim)).toEqual(['x']);
  });

  it('promotes the top-K by score, highest first, and skims the rest', () => {
    const t = tierRules([r('lo', { score: 1 }), r('hi', { score: 3 }), r('mid', { score: 2 })], {
      topK: 2
    });
    expect(refs(t.salient)).toEqual(['hi', 'mid']);
    expect(refs(t.skim)).toEqual(['lo']);
  });

  it('keeps input order on equal or absent scores, so a pre-ranked list needs none', () => {
    const t = tierRules(
      [r('a'), r('b', { score: 1 }), r('c', { score: 1 }), r('d', { score: Number.NaN })],
      {
        topK: 4
      }
    );
    expect(refs(t.salient)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('never omits: every entry lands in exactly one tier at any topK', () => {
    const entries = [
      r('m', { severity: 'must' }),
      r('p', { pinned: true }),
      r('a', { score: 2 }),
      r('b', { score: 1 })
    ];
    for (const topK of [-3, 0, 1, 2, 99]) {
      const t = tierRules(entries, { topK });
      const all = [...t.must, ...t.pinned, ...t.salient, ...t.skim];
      expect(refs(all).sort()).toEqual(['a', 'b', 'm', 'p']);
    }
    expect(tierRules(entries, { topK: -3 }).salient).toEqual([]);
  });

  it('defaults to five salient rules', () => {
    const t = tierRules(Array.from({ length: 7 }, (_, i) => r(`r${i}`)));
    expect(t.salient).toHaveLength(5);
    expect(t.skim).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(tierRules([])).toEqual({ must: [], pinned: [], salient: [], skim: [] });
  });
});

describe('rule lines', () => {
  it('renders the full form with an optional indented note', () => {
    expect(renderRuleFull(r('#1'))).toEqual(['- **#1** — #1 body']);
    expect(renderRuleFull(r('#1', { note: 'why: elsewhere' }))).toEqual([
      '- **#1** — #1 body',
      '  why: elsewhere'
    ]);
  });

  it('renders the skim form with category and token count when present', () => {
    expect(renderRuleSkim(r('L41-120'))).toBe('- **L41-120** — L41-120 syn');
    expect(renderRuleSkim(r('L41-120', { category: 'git', tokens: 900 }))).toBe(
      '- **L41-120** *(git)* (900 tok) — L41-120 syn'
    );
  });
});

describe('renderRuleGroups', () => {
  const entries = [
    r('a', { category: 'style' }),
    r('b', { category: 'git' }),
    r('c'),
    r('d', { category: 'git' })
  ];

  it('sorts categories by code point without an order, uncategorised included', () => {
    const heads = renderRuleGroups(entries).filter((l) => l.startsWith('#'));
    expect(heads).toEqual(['#### git', '#### style', '#### uncategorised']);
  });

  it('ranks listed categories first and the rest alphabetically after', () => {
    const heads = renderRuleGroups(entries, {
      categoryOrder: ['style'],
      level: '###',
      counts: true
    }).filter((l) => l.startsWith('#'));
    expect(heads).toEqual(['### style (1)', '### git (2)', '### uncategorised (1)']);
  });

  it('orders within a category by compare, without mutating the input', () => {
    const input = [r('x', { category: 'git' }), r('y', { category: 'git' })];
    const lines = renderRuleGroups(input, { compare: (p, q) => q.ref.localeCompare(p.ref) });
    expect(lines.filter((l) => l.startsWith('- '))).toEqual([
      '- **y** — y body',
      '- **x** — x body'
    ]);
    expect(refs(input)).toEqual(['x', 'y']);
  });
});

describe('renderRuleTiers', () => {
  it('renders title, intro and labelled tiers in order must, pinned, salient, skim', () => {
    const md = renderRuleTiers(
      tierRules(
        [
          r('#3', { severity: 'must', category: 'git' }),
          r('#20', { pinned: true, category: 'style' }),
          r('#21', { score: 2, category: 'git' }),
          r('#22', { score: 1, category: 'tooling', tokens: 40 })
        ],
        { topK: 1 }
      ),
      {
        title: '## Rules',
        intro: ['Read these.'],
        labels: { must: '### must', pinned: '### pinned', salient: '### salient', skim: '### skim' }
      }
    );
    expect(md).toBe(
      [
        '## Rules',
        '',
        'Read these.',
        '',
        '### must',
        '',
        '#### git',
        '',
        '- **#3** — #3 body',
        '',
        '### pinned',
        '',
        '#### style',
        '',
        '- **#20** — #20 body',
        '',
        '### salient',
        '',
        '#### git',
        '',
        '- **#21** — #21 body',
        '',
        '### skim',
        '',
        '- **#22** *(tooling)* (40 tok) — #22 syn',
        ''
      ].join('\n')
    );
  });

  it('renders a tier named in skimTiers as skim lines', () => {
    const md = renderRuleTiers(
      tierRules([r('#21', { score: 2, category: 'git' }), r('#22', { score: 1 })], { topK: 1 }),
      { labels: { salient: '### salient', skim: '### skim' }, skimTiers: ['salient', 'skim'] }
    );
    expect(md).toBe(
      [
        '### salient',
        '',
        '- **#21** *(git)* — #21 syn',
        '',
        '### skim',
        '',
        '- **#22** — #22 syn',
        ''
      ].join('\n')
    );
  });

  it('omits an empty tier, heading included', () => {
    const md = renderRuleTiers(
      { skim: [r('a')] },
      { labels: { pinned: '### pinned', skim: '### skim' } }
    );
    expect(md).not.toMatch(/pinned/);
    expect(md).toBe('### skim\n\n- **a** — a syn\n');
  });

  it('renders an unlabelled tier directly', () => {
    expect(renderRuleTiers({ must: [r('a')] })).toBe('#### uncategorised\n\n- **a** — a body\n');
  });

  it('renders nothing for no rules', () => {
    expect(renderRuleTiers({})).toBe('');
  });
});

describe('rule text cannot forge document sections', () => {
  it('flattens headings in full bodies and skim synopses', () => {
    const forged = { ref: '#9', body: 'real rule\n## Fake section\nmore', synopsis: '# Fake' };
    const full = renderRuleFull(forged).join('\n');
    expect(full).not.toMatch(/^#{1,6} /m);
    expect(full).toContain('**Fake section**');
    expect(renderRuleSkim(forged)).not.toMatch(/— #/);
  });
});
