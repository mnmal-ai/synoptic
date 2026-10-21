/**
 * `embed.source` for the synopsis-bearing types: the synopsis alone for a
 * short row, the synopsis followed by the long form once the long form passes
 * 1200 chars.
 */

import type { Row } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import { buildClaudeNamespace } from '../src/namespace.js';

type EmbedSource = (row: Row) => string;

function sourceFor(type: string): EmbedSource {
  const nsDef = buildClaudeNamespace('cortext');
  const def = (nsDef.types as Record<string, { embed?: { source: EmbedSource } }>)[type];
  if (def?.embed === undefined) throw new Error(`${type} declares no embed.source`);
  return def.embed.source;
}

const SYN = 'a short handle';
const SHORT = 'x'.repeat(1200);
const LONG = 'y'.repeat(1201);

/** The type, and a row whose long form is exactly `long`. */
const CASES: Array<[string, (long: string) => Row, string]> = [
  ['Memory', (long) => ({ id: 'm', description: 'd', body: long.slice(3) }), ''],
  ['Concept', (long) => ({ id: 'c', description: 'd', body: long.slice(3) }), ''],
  ['SessionLog', (long) => ({ id: 's', summary: long }), ''],
  ['AnchorIntent', (long) => ({ id: 'a', body: long }), ''],
  ['AgentRule', (long) => ({ id: 'r', rule: long, category: 'style' }), ' [style]']
];

describe('embed.source on synopsis-bearing types', () => {
  for (const [type, row, suffix] of CASES) {
    describe(type, () => {
      const source = sourceFor(type);

      it('embeds the synopsis alone when the long form is at most 1200 chars', () => {
        expect(source({ ...row(SHORT), synopsis: SYN })).toBe(`${SYN}${suffix}`);
      });

      it('embeds the synopsis followed by the long form past 1200 chars', () => {
        const r = row(LONG);
        const out = source({ ...r, synopsis: SYN });
        expect(out.startsWith(`${SYN}\n\n`)).toBe(true);
        expect(out.endsWith(`${LONG.slice(3)}${suffix}`)).toBe(true);
      });

      it('embeds the long form alone when there is no synopsis', () => {
        const out = source(row(LONG));
        expect(out.endsWith(`${LONG.slice(3)}${suffix}`)).toBe(true);
        expect(out.includes(SYN)).toBe(false);
      });
    });
  }
});
