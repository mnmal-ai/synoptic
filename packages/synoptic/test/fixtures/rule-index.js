/** A live-shaped AgentRule set: 25 musts at 130 chars, one 330-char literal (#21),
 *  5 pinned shoulds at 150 chars, 20 unpinned shoulds. */
const CATS = ['permissions', 'verification', 'git', 'process', 'testing', 'style'];
const text = (n, len) => `Rule ${n} `.padEnd(len - 1, 'x').concat('.');

export function ruleFixture() {
  const rules = [];
  for (let i = 1; i <= 25; i++) {
    rules.push({
      shortId: 100 + i,
      category: CATS[i % CATS.length],
      severity: 'must',
      synopsis: text(100 + i, 130)
    });
  }
  rules.push({ shortId: 21, category: 'git', severity: 'must', synopsis: text(21, 330) });
  for (let i = 1; i <= 5; i++) {
    rules.push({
      shortId: 200 + i,
      category: CATS[i % CATS.length],
      severity: 'should',
      pinned: true,
      synopsis: text(200 + i, 150)
    });
  }
  for (let i = 1; i <= 20; i++) {
    rules.push({
      shortId: 300 + i,
      category: 'style',
      severity: 'should',
      pinned: false,
      synopsis: text(300 + i, 140)
    });
  }
  return rules;
}
