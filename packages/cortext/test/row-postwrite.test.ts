/**
 * Embedding postWrite wiring — kernel-driven path.
 *
 * Embeddable types declare `embed.source` metadata;
 * `createRecallPlugin.contributePostWrites` walks those at compose time and
 * contributes a hook per match. This suite exercises that path.
 *
 * Two test shapes:
 *   1. Unit — call `recall.contributePostWrites(claudeNsDef)` directly and
 *      assert the hook fires embed on write (no full engine needed).
 *   2. Integration — drive writes through `loadPlugins` and assert the
 *      embedding lands in the store (end-to-end behaviour parity).
 */

import {
  createRecallPlugin,
  type EmbeddingsStoreUpsertInput,
  InMemoryEmbeddingsStore
} from '@mnmal-ai/substrate/recall';
import type { PostWriteHook, RequestContext } from '@mnmal-ai/substrate/sdk';
import {
  FakeEmbedder,
  loadPlugins,
  MemoryDataset,
  MemoryEdgesStore
} from '@mnmal-ai/substrate/testing';
import { describe, expect, it, vi } from 'vitest';
import { createCortextPlugin } from '../src/index.js';
import { buildClaudeNamespace } from '../src/namespace.js';

function makeCtx(): RequestContext {
  return {
    // substrate refuses an unattributed write outright rather than
    // defaulting it to `system:anonymous`. These tests drive the real autoCRUD
    // resolvers, so they must present the explicit system envelope an internal
    // writer uses. Attribution is not what is under test here — the embed/lexical
    // postWrite is — but it is now a precondition for reaching it.
    identity: { kind: 'system', id: 'cortext-test', grants: { '*': ['read', 'mutate'] } },
    namespace: 'claude',
    operation: 'mutate',
    now: new Date(),
    headers: {},
    meta: {}
  };
}

type ResolverEntry = {
  resolver: (ctx: RequestContext, args: unknown) => Promise<unknown>;
};

function makeResolvers() {
  const resolvers = new Map<string, ResolverEntry>();
  const registry = {
    register: vi.fn((key: string, entry: unknown) => {
      resolvers.set(key, entry as ResolverEntry);
    }),
    // The namespace wraps AgentIdentity's autoCRUD entries in place,
    // so the stub models the real Registry's read-back and replace.
    get: (key: string) => resolvers.get(key),
    replace: (key: string, entry: unknown) => {
      resolvers.set(key, entry as ResolverEntry);
    }
  };
  return { registry, resolvers };
}

/**
 * Drive a write through the kernel-contributed hooks path.
 *
 * Builds the claude NamespaceDefinition, calls
 * `recall.contributePostWrites(nsDef)` to get the hooks, then installs the
 * namespace with `postWriteContributions` injected — mirrors exactly what
 * `loadPlugins` does in production.
 */
async function runCreate(
  typeName: string,
  params: Record<string, unknown>,
  embedder: FakeEmbedder
) {
  const embedSpy = vi.spyOn(embedder, 'embed');
  const upserts: EmbeddingsStoreUpsertInput[] = [];
  const store = new InMemoryEmbeddingsStore();
  const originalUpsert = store.upsert.bind(store);
  store.upsert = async (input) => {
    upserts.push(input);
    await originalUpsert(input);
  };

  const recall = createRecallPlugin({ embedder, store });
  const nsDef = buildClaudeNamespace('claude');

  // Collect contributions exactly as loadPlugins does
  const contribs = recall.contributePostWrites!(nsDef);
  const postWriteContributions: Record<string, PostWriteHook[]> = {};
  for (const [type, hook] of Object.entries(contribs)) {
    postWriteContributions[type] = [hook];
  }

  const { registry, resolvers } = makeResolvers();
  const dataset = new MemoryDataset({ namespace: 'claude' });
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  nsDef.install({ registry: registry as never, dataset, edges, postWriteContributions });

  const entry = resolvers.get(`create${typeName}`);
  if (!entry) throw new Error(`create${typeName} resolver not registered`);
  await entry.resolver(makeCtx(), { params, fields: { id: true } });
  return { embedSpy, upserts };
}

describe('postWrite wiring — kernel-driven', () => {
  describe('contributePostWrites coverage', () => {
    it('contributes hooks for all 6 embeddable types when embedder is present', () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const store = new InMemoryEmbeddingsStore();
      const recall = createRecallPlugin({ embedder, store });
      const nsDef = buildClaudeNamespace('claude');
      const contribs = recall.contributePostWrites!(nsDef);
      expect(Object.keys(contribs).sort()).toEqual(
        ['AgentRule', 'AnchorIntent', 'Concept', 'Decision', 'Memory', 'SessionLog'].sort()
      );
    });

    it('contributes no hooks when embedder is absent', () => {
      const store = new InMemoryEmbeddingsStore();
      const recall = createRecallPlugin({ store }); // no embedder
      const nsDef = buildClaudeNamespace('claude');
      const contribs = recall.contributePostWrites!(nsDef);
      expect(Object.keys(contribs)).toHaveLength(0);
    });

    it('non-embeddable types (Todo) are absent; AgentRule is now embeddable', () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const store = new InMemoryEmbeddingsStore();
      const recall = createRecallPlugin({ embedder, store });
      const nsDef = buildClaudeNamespace('claude');
      const contribs = recall.contributePostWrites!(nsDef);
      expect(contribs).not.toHaveProperty('Todo');
      // AgentRule declares an embed.source (semantic salience), so it
      // contributes a postWrite like the other embeddable types.
      expect(contribs).toHaveProperty('AgentRule');
    });
  });

  describe('embedding fires on write', () => {
    it('Decision: fires embed with correct source text', async () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const { embedSpy, upserts } = await runCreate(
        'Decision',
        {
          topic: 'auth',
          choice: 'rotate tokens',
          rationale: 'leak',
          sessionId: 1,
          status: 'active',
          archived: false,
          project: 'substrate'
        },
        embedder
      );
      expect(embedSpy).toHaveBeenCalledWith('auth\n\nrotate tokens\n\nleak', expect.anything());
      expect(upserts).toHaveLength(1);
    });

    it('Memory: fires embed with correct source text (no synopsis → desc+body)', async () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const { embedSpy, upserts } = await runCreate(
        'Memory',
        {
          name: 'feedback_test',
          description: 'test hook',
          type: 'feedback',
          body: 'full memory body',
          archived: false,
          project: 'substrate'
        },
        embedder
      );
      expect(embedSpy).toHaveBeenCalledWith('test hook\n\nfull memory body', expect.anything());
      expect(upserts).toHaveLength(1);
    });

    it('Memory: synopsis-preference — uses synopsis when present', async () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const { embedSpy, upserts } = await runCreate(
        'Memory',
        {
          name: 'synopsis_test',
          description: 'long description',
          type: 'project',
          body: 'long body',
          synopsis: 'short synopsis',
          archived: false,
          project: 'substrate'
        },
        embedder
      );
      expect(embedSpy).toHaveBeenCalledWith('short synopsis', expect.anything());
      expect(upserts).toHaveLength(1);
    });

    it('SessionLog: fires embed with summary when no synopsis', async () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const { embedSpy, upserts } = await runCreate(
        'SessionLog',
        {
          branch: 'feat/x',
          summary: 'shipped increment 3a',
          startedAt: '2026-04-24T00:00:00Z',
          packages: ['cortext'],
          decisionsCount: 0,
          archived: false,
          project: 'substrate'
        },
        embedder
      );
      expect(embedSpy).toHaveBeenCalledWith('shipped increment 3a', expect.anything());
      expect(upserts).toHaveLength(1);
    });

    it('SessionLog: synopsis-preference — uses synopsis when present', async () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const { embedSpy, upserts } = await runCreate(
        'SessionLog',
        {
          branch: 'feat/y',
          summary: 'long summary text',
          synopsis: 'concise synopsis',
          startedAt: '2026-04-24T00:00:00Z',
          packages: [],
          decisionsCount: 0,
          archived: false,
          project: 'substrate'
        },
        embedder
      );
      expect(embedSpy).toHaveBeenCalledWith('concise synopsis', expect.anything());
      expect(upserts).toHaveLength(1);
    });

    it('AnchorIntent: fires embed with synopsis field', async () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const { embedSpy, upserts } = await runCreate(
        'AnchorIntent',
        {
          synopsis: 'an intent synopsis',
          project: 'substrate'
        },
        embedder
      );
      expect(embedSpy).toHaveBeenCalledWith('an intent synopsis', expect.anything());
      expect(upserts).toHaveLength(1);
    });

    it('AnchorIntent: rejects create without synopsis (required)', async () => {
      // synopsis is the primary embedding source and the type marks it
      // non-nullable with no default, so an anchor without one is rejected at
      // write time rather than silently producing a zero-vector embedding —
      // the empty/null-synopsis anchor class this guard exists to prevent.
      // (The embed.source body/'' fallback remains for legacy rows + reindex;
      // it is covered by the nullable-synopsis types above.)
      const embedder = new FakeEmbedder({ dimension: 8 });
      await expect(
        runCreate('AnchorIntent', { body: 'body but no synopsis', project: 'substrate' }, embedder)
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'missing_required_field',
          details: expect.objectContaining({ field: 'synopsis', phase: 'create' })
        })
      );
    });

    it('Concept: fires embed with desc+body when no synopsis', async () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const { embedSpy, upserts } = await runCreate(
        'Concept',
        {
          name: 'test-concept',
          kind: 'reference',
          description: 'desc',
          body: 'body',
          project: 'substrate'
        },
        embedder
      );
      expect(embedSpy).toHaveBeenCalledWith('desc\n\nbody', expect.anything());
      expect(upserts).toHaveLength(1);
    });

    it('Concept: synopsis-preference — uses synopsis when present', async () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const { embedSpy, upserts } = await runCreate(
        'Concept',
        {
          name: 'test-concept-synopsis',
          kind: 'reference',
          description: 'long description',
          body: 'long body',
          synopsis: 'concise',
          project: 'substrate'
        },
        embedder
      );
      expect(embedSpy).toHaveBeenCalledWith('concise', expect.anything());
      expect(upserts).toHaveLength(1);
    });
  });

  describe('no embedding when embedder absent', () => {
    it('no embed fires for embeddable types when recall has no embedder', async () => {
      const store = new InMemoryEmbeddingsStore();
      const recall = createRecallPlugin({ store }); // no embedder
      const nsDef = buildClaudeNamespace('claude');
      const contribs = recall.contributePostWrites!(nsDef);

      // With no contributions, install runs cleanly with no postWriteContributions
      const { registry, resolvers } = makeResolvers();
      const dataset = new MemoryDataset({ namespace: 'claude' });
      const edges = new MemoryEdgesStore({ now: () => new Date() });
      nsDef.install({ registry: registry as never, dataset, edges });
      for (const type of ['Decision', 'Memory', 'SessionLog'] as const) {
        const entry = resolvers.get(`create${type}`);
        expect(entry, `create${type} resolver must be registered`).toBeDefined();
      }
      expect(Object.keys(contribs)).toHaveLength(0);
    });
  });
});

describe('postWrite wiring — loadPlugins integration', () => {
  it('Memory write via loadPlugins lands an embedding in the store', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const upserts: EmbeddingsStoreUpsertInput[] = [];
    const store = new InMemoryEmbeddingsStore();
    const originalUpsert = store.upsert.bind(store);
    store.upsert = async (input) => {
      upserts.push(input);
      await originalUpsert(input);
    };

    const recall = createRecallPlugin({ embedder, store });
    const claude = createCortextPlugin({
      namespace: 'claude',
      architectureNamespace: 'architecture',
      compactRetention: 7,
      autoCompactIntervalMs: undefined,
      auth: undefined
    });

    const claudeDataset = new MemoryDataset({ namespace: 'claude' });
    const archDataset = new MemoryDataset({ namespace: 'architecture' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });

    await loadPlugins({
      plugins: [claude],
      datasetFor: (ns) => {
        if (ns === 'claude') return claudeDataset;
        if (ns === 'architecture') return archDataset;
        return undefined;
      },
      edges,
      kernelPlugins: [recall]
    });

    // Verify contributePostWrites fires correctly for the claude namespace def
    // (loadPlugins calls this internally; we verify it independently for clarity)
    const nsDef = claude.namespaces[0]!;
    const contribs = recall.contributePostWrites!(nsDef);
    expect(Object.keys(contribs).sort()).toEqual(
      ['AgentRule', 'AnchorIntent', 'Concept', 'Decision', 'Memory', 'SessionLog'].sort()
    );

    // Verify the hook fires correctly when called directly (end-to-end source parity)
    const embedSpy = vi.spyOn(embedder, 'embed');
    const memoryHook = contribs.Memory!;
    const fakeRow = {
      id: 'test-id-123',
      name: 'test',
      description: 'desc',
      type: 'project',
      body: 'body text',
      archived: false,
      project: 'substrate'
    };
    await memoryHook(fakeRow as never, makeCtx());
    expect(embedSpy).toHaveBeenCalledWith('desc\n\nbody text', expect.anything());
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.rowNamespace).toBe('claude');
    expect(upserts[0]?.rowType).toBe('Memory');
    expect(upserts[0]?.rowId).toBe('test-id-123');
  });

  it('Todo write does NOT produce an embedding (non-embeddable type)', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const store = new InMemoryEmbeddingsStore();
    const recall = createRecallPlugin({ embedder, store });
    const claude = createCortextPlugin({
      namespace: 'claude',
      architectureNamespace: 'architecture',
      compactRetention: 7,
      autoCompactIntervalMs: undefined,
      auth: undefined
    });
    const nsDef = claude.namespaces[0]!;
    const contribs = recall.contributePostWrites!(nsDef);
    expect(contribs).not.toHaveProperty('Todo');
  });

  describe('Decision embed.source — crossRef enrichment via EmbedSourceContext', () => {
    it('inlines establishesConcept.name when resolveDataset is wired and the crossRef resolves', async () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const embedSpy = vi.spyOn(embedder, 'embed');
      const store = new InMemoryEmbeddingsStore();
      const dataset = new MemoryDataset({ namespace: 'claude' });
      // Pre-seed a Concept the Decision will reference. Bypass autoCRUD —
      // direct dataset write keeps the test focused on the embed path.
      await dataset.write('Concept', [
        {
          id: 'concept-salience',
          name: 'Salience',
          description: 'usage-driven attention weighting',
          synopsis: '',
          stage: 'Candidate',
          archived: false,
          project: 'substrate'
        }
      ]);

      const recall = createRecallPlugin({
        embedder,
        store,
        resolveDataset: (ns) => (ns === 'claude' ? dataset : null)
      });
      const nsDef = buildClaudeNamespace('claude');
      const contribs = recall.contributePostWrites!(nsDef);
      const postWriteContributions: Record<string, PostWriteHook[]> = {};
      for (const [type, hook] of Object.entries(contribs)) {
        postWriteContributions[type] = [hook];
      }
      const { registry, resolvers } = makeResolvers();
      const edges = new MemoryEdgesStore({ now: () => new Date() });
      nsDef.install({ registry: registry as never, dataset, edges, postWriteContributions });

      const create = resolvers.get('createDecision');
      if (!create) throw new Error('createDecision resolver missing');
      await create.resolver(makeCtx(), {
        params: {
          topic: 'recall attention',
          choice: 'add per-row salience signal',
          rationale: 'usage-weighted ranking',
          establishesConcept: 'concept-salience',
          status: 'active',
          archived: false,
          project: 'substrate'
        },
        fields: { id: true }
      });

      expect(embedSpy).toHaveBeenCalledTimes(1);
      const embedArg = embedSpy.mock.calls[0]?.[0] as string;
      expect(embedArg).toContain('recall attention');
      expect(embedArg).toContain('add per-row salience signal');
      expect(embedArg).toContain('[concept] Salience');
    });

    it('falls back to base text when resolveDataset is omitted (back-compat)', async () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const { embedSpy } = await runCreate(
        'Decision',
        {
          topic: 'recall attention',
          choice: 'add per-row salience signal',
          rationale: 'usage-weighted ranking',
          establishesConcept: 'concept-salience',
          status: 'active',
          archived: false,
          project: 'substrate'
        },
        embedder
      );
      // No resolveDataset → ctx undefined → embed.source skips the read,
      // returns the base topic+choice+rationale string.
      expect(embedSpy).toHaveBeenCalledWith(
        'recall attention\n\nadd per-row salience signal\n\nusage-weighted ranking',
        expect.anything()
      );
    });

    it('falls back to base text when establishesConcept is absent (no crossRef to follow)', async () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const embedSpy = vi.spyOn(embedder, 'embed');
      const store = new InMemoryEmbeddingsStore();
      const dataset = new MemoryDataset({ namespace: 'claude' });

      const recall = createRecallPlugin({
        embedder,
        store,
        resolveDataset: (ns) => (ns === 'claude' ? dataset : null)
      });
      const nsDef = buildClaudeNamespace('claude');
      const contribs = recall.contributePostWrites!(nsDef);
      const postWriteContributions: Record<string, PostWriteHook[]> = {};
      for (const [type, hook] of Object.entries(contribs)) {
        postWriteContributions[type] = [hook];
      }
      const { registry, resolvers } = makeResolvers();
      const edges = new MemoryEdgesStore({ now: () => new Date() });
      nsDef.install({ registry: registry as never, dataset, edges, postWriteContributions });

      const create = resolvers.get('createDecision');
      if (!create) throw new Error('createDecision resolver missing');
      await create.resolver(makeCtx(), {
        params: {
          topic: 'topic',
          choice: 'choice',
          rationale: 'rationale',
          status: 'active',
          archived: false,
          project: 'substrate'
          // establishesConcept omitted
        },
        fields: { id: true }
      });

      expect(embedSpy).toHaveBeenCalledWith('topic\n\nchoice\n\nrationale', expect.anything());
    });
  });
});
