/**
 * `lexical.source` declarations.
 *
 * substrate ships the MECHANISM; a namespace has to OPT IN, and until it does
 * `GET /substrate/v1/embed-stats` answers `lexicalTypes: []` and the backfill answers
 * `unknown_type` for every type — correctly, because nothing is declared.
 *
 * These tests exist because that failure is silent from inside this repo. The
 * declaration sits on a type-def interface with an `[key: string]: unknown`
 * index signature, so a misspelled `lexial:` compiles, publishes, and indexes
 * nothing. What follows asserts the DECLARED TEXT rather than the presence of a
 * key, so a typo in a field name fails here rather than in production.
 */

import {
  createRecallPlugin,
  InMemoryEmbeddingsStore,
  InMemoryLexicalStore
} from '@mnmal-ai/substrate/recall';
import type { Row } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import { buildClaudeNamespace } from '../src/namespace.js';

type LexicalSource = (row: Row) => string | null | undefined;

/** The `lexical.source` declared for `type`, or undefined when there is none. */
function sourceFor(type: string): LexicalSource | undefined {
  const nsDef = buildClaudeNamespace('cortext');
  const def = (nsDef.types as Record<string, { lexical?: { source: LexicalSource } }>)[type];
  return def?.lexical?.source;
}

const EXPECTED = [
  'AgentRule',
  'AnchorIntent',
  'Concept',
  'Decision',
  'Memory',
  'SessionLog'
] as const;

describe('lexical.source declarations', () => {
  it('declares a lexical source on exactly the six embeddable types', () => {
    const nsDef = buildClaudeNamespace('cortext');
    const declared = Object.entries(nsDef.types as Record<string, { lexical?: unknown }>)
      .filter(([, def]) => def.lexical !== undefined)
      .map(([name]) => name)
      .sort();
    expect(declared).toEqual([...EXPECTED].sort());
  });

  it('every declared source is callable and returns a string or the null sentinel', () => {
    for (const type of EXPECTED) {
      const source = sourceFor(type);
      expect(source, `${type} should declare lexical.source`).toBeTypeOf('function');
      const out = source!({ id: 'x' });
      expect(out === null || typeof out === 'string').toBe(true);
    }
  });

  it('an all-empty row is declared un-indexable (null), not indexed as an empty string', () => {
    // Matches embed.source's sentinel contract: `''` indexes normally, so
    // returning it to mean "skip" would put every such row at the same point.
    for (const type of EXPECTED) {
      expect(sourceFor(type)!({ id: 'x' }), `${type} on an empty row`).toBeNull();
    }
  });

  describe('the declared text is the LONG form, and carries what the synopsis drops', () => {
    it('SessionLog: synopsis + summary + body', () => {
      const out = sourceFor('SessionLog')!({
        id: 'x',
        synopsis: 'onboarding pipeline',
        summary: 'reworked IntakeChannel',
        body: 'details about host-a'
      });
      expect(out).toBe('onboarding pipeline\n\nreworked IntakeChannel\n\ndetails about host-a');
    });

    it('Memory: synopsis + description + body', () => {
      expect(sourceFor('Memory')!({ id: 'x', synopsis: 's', description: 'd', body: 'b' })).toBe(
        's\n\nd\n\nb'
      );
    });

    it('Concept: synopsis + description + body', () => {
      expect(sourceFor('Concept')!({ id: 'x', synopsis: 's', description: 'd', body: 'b' })).toBe(
        's\n\nd\n\nb'
      );
    });

    it('AnchorIntent: synopsis + body', () => {
      expect(sourceFor('AnchorIntent')!({ id: 'x', synopsis: 's', body: 'b' })).toBe('s\n\nb');
    });

    it('AgentRule: synopsis + rule + rationale, and NOT category', () => {
      const out = sourceFor('AgentRule')!({
        id: 'x',
        synopsis: 's',
        rule: 'the rule body',
        rationale: 'why it exists',
        category: 'verification'
      });
      expect(out).toBe('s\n\nthe rule body\n\nwhy it exists');
      expect(out).not.toContain('verification');
    });

    it('Decision: topic + choice + rationale', () => {
      expect(sourceFor('Decision')!({ id: 'x', topic: 't', choice: 'c', rationale: 'r' })).toBe(
        't\n\nc\n\nr'
      );
    });
  });

  it('keeps the token a synopsis-only embed.source would drop — the defect the arm exists for', () => {
    const row: Row = {
      id: 'x',
      synopsis: 'how recall ranks rows',
      body: 'RRF over IntakeChannel',
      description: 'd'
    };
    // embed.source prefers the synopsis alone, so `IntakeChannel` is unreachable there.
    const embedSource = (
      buildClaudeNamespace('cortext').types as unknown as Record<
        string,
        { embed: { source: (r: Row) => unknown } }
      >
    ).Memory!.embed.source;
    expect(embedSource(row)).toBe('how recall ranks rows');
    expect(sourceFor('Memory')!(row)).toContain('IntakeChannel');
  });

  it('drops empty parts rather than emitting blank paragraphs', () => {
    expect(
      sourceFor('SessionLog')!({ id: 'x', synopsis: '', summary: 'only this', body: null })
    ).toBe('only this');
  });
});

/**
 * The declarations above are only worth anything if substrate's own registry picks
 * them up. This asserts that through `createRecallPlugin` — the same code path
 * the running binary uses — rather than by re-reading our own namespace object.
 */
describe('substrate-recall picks the declarations up', () => {
  it('contributes a lexical postWrite for each declared type when a lexicalStore is wired', () => {
    const recall = createRecallPlugin({
      store: new InMemoryEmbeddingsStore(),
      lexicalStore: new InMemoryLexicalStore()
    });
    const contribs = recall.contributePostWrites!(buildClaudeNamespace('cortext'));
    expect(Object.keys(contribs).sort()).toEqual([...EXPECTED].sort());
  });

  it('contributes NOTHING when no lexicalStore is wired — the declaration alone is not enough', () => {
    // Worth pinning because it is the live failure mode: registration is gated
    // on `cfg.lexicalStore`, so a runtime that bumps its cortext pins but does
    // not configure a lexical store still reports `lexicalTypes: []`. That reads
    // identically to "cortext declared nothing", which is what this repo just
    // fixed — so the two causes must not be conflated when checking the rollout.
    const recall = createRecallPlugin({ store: new InMemoryEmbeddingsStore() });
    const contribs = recall.contributePostWrites!(buildClaudeNamespace('cortext'));
    expect(Object.keys(contribs)).toHaveLength(0);
  });

  it('indexes the LONG form on write, not the handle the embedder takes', async () => {
    const lexicalStore = new InMemoryLexicalStore();
    const recall = createRecallPlugin({
      store: new InMemoryEmbeddingsStore(),
      lexicalStore
    });
    const contribs = recall.contributePostWrites!(buildClaudeNamespace('cortext'));

    await contribs.Memory!(
      {
        id: 'm1',
        synopsis: 'how recall ranks rows',
        description: 'ranking',
        body: 'RRF over IntakeChannel'
      },
      // biome-ignore lint/suspicious/noExplicitAny: the hook only reads `row`
      undefined as any
    );

    const hits = await lexicalStore.search({
      namespace: 'cortext',
      type: 'Memory',
      query: 'IntakeChannel',
      k: 10
    });
    expect(hits.map((h) => h.rowId)).toContain('m1');
  });
});
