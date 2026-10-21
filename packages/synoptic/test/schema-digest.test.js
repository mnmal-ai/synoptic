import { describe, expect, it } from 'vitest';
import {
  buildOperatorDigest,
  buildSchemaDigest,
  fetchNamespaceSchema,
  renderSchemaDigest
} from '../src/schema-digest.js';

// Trimmed from the cortext schema. SessionLog is the important
// one: creating one is rejected for `branch`, then `startedAt`, ONE AT A TIME,
// and the full set the server demands is the five below. The derivation must
// reproduce exactly that set — which is the whole reason the digest is worth
// injecting, since `missing_required_field` never shows you the whole set.
const SCHEMA = {
  types: {
    SessionLog: {
      fields: {
        branch: { kind: 'scalar', type: 'string' },
        startedAt: { kind: 'scalar', type: 'date' },
        summary: { kind: 'scalar', type: 'string' },
        synopsis: { kind: 'scalar', type: 'string', nullable: true },
        decisionsCount: { kind: 'scalar', type: 'number' },
        packages: { kind: 'scalar', type: 'string' },
        archived: { kind: 'scalar', type: 'boolean', default: false },
        shortId: { kind: 'scalar', type: 'number', readonly: true }
      }
    },
    Todo: {
      fields: {
        title: { kind: 'scalar', type: 'string' },
        priority: { kind: 'scalar', type: 'string', enum: ['low', 'medium', 'high'] },
        project: { kind: 'scalar', type: 'string', nullable: true },
        implementsDecision: { kind: 'crossRef', nullable: true },
        shortId: { kind: 'scalar', type: 'number', readonly: true }
      }
    },
    AgentMessage: {
      fields: {
        subject: { kind: 'scalar', type: 'string' },
        ackedAt: { kind: 'scalar', type: 'date', nullable: true, serverSet: 'both' }
      }
    }
  }
};

describe('buildSchemaDigest', () => {
  it('reproduces the exact required set the server demands one field at a time', () => {
    const sl = buildSchemaDigest(SCHEMA).find((e) => e.type === 'SessionLog');
    expect(sl.required).toEqual(['branch', 'startedAt', 'summary', 'decisionsCount', 'packages']);
  });

  it('treats nullable, defaulted, readonly and server-set as optional', () => {
    const d = buildSchemaDigest(SCHEMA);
    const sl = d.find((e) => e.type === 'SessionLog');
    // synopsis nullable, archived defaulted, shortId readonly
    for (const f of ['synopsis', 'archived', 'shortId']) expect(sl.required).not.toContain(f);
    // serverSet is the one that is easy to miss — ackedAt is nullable AND
    // server-set, and either alone would be enough to exclude it.
    expect(d.find((e) => e.type === 'AgentMessage').required).toEqual(['subject']);
  });

  it('captures the three shapes that actually got guessed wrong', () => {
    const todo = buildSchemaDigest(SCHEMA).find((e) => e.type === 'Todo');
    expect(todo.enums).toEqual([{ field: 'priority', values: ['low', 'medium', 'high'] }]);
    expect(todo.numbers).toEqual(['shortId']); // "#869" is display-only
    expect(todo.crossRefs).toEqual(['implementsDecision']);
  });

  it('orders the write-often types first, then the rest alphabetically', () => {
    // An agent scanning this wants Todo/Decision/SessionLog up top, not
    // AgentIdentity because it sorts first.
    const order = buildSchemaDigest(SCHEMA).map((e) => e.type);
    expect(order.indexOf('Todo')).toBeLessThan(order.indexOf('SessionLog'));
    expect(order.indexOf('SessionLog')).toBeLessThan(order.indexOf('AgentMessage'));
  });

  it('survives junk rather than throwing into the cold-start', () => {
    expect(buildSchemaDigest(null)).toEqual([]);
    expect(buildSchemaDigest({})).toEqual([]);
    expect(buildSchemaDigest({ types: 'nope' })).toEqual([]);
  });
});

describe('renderSchemaDigest', () => {
  it('renders the enum values inline — the whole point of the exercise', () => {
    const out = renderSchemaDigest(buildSchemaDigest(SCHEMA), { ns: 'cortext' });
    expect(out).toContain('priority: low|medium|high');
    expect(out).toContain('req: branch, startedAt, summary, decisionsCount, packages');
    expect(out).toContain('num: shortId');
  });

  it('carries the query shapes that are not per-type facts', () => {
    const out = renderSchemaDigest(buildSchemaDigest(SCHEMA), { ns: 'cortext' });
    expect(out).toContain('`orderBy` is an ARRAY');
    expect(out).toMatch(/`shortId` is a NUMBER/);
    expect(out).toMatch(/Never send `createdAt`/);
  });

  it('stays small — it must cost less context than the round-trips it saves', () => {
    // 13 live types render to ~1.9 kB against a ~54 kB cold-start. Injecting the
    // raw schema instead would be 65 kB.
    expect(renderSchemaDigest(buildSchemaDigest(SCHEMA), { ns: 'cortext' }).length).toBeLessThan(
      3000
    );
  });

  it('renders nothing when there is nothing to say', () => {
    expect(renderSchemaDigest([], { ns: 'cortext' })).toBe('');
    expect(
      renderSchemaDigest([{ type: 'X', required: [], enums: [], numbers: [], crossRefs: [] }])
    ).toBe('');
  });
});

// substrate >= 6.1.0 serves the operator contract on the schema route, keyed
// by field kind. Trimmed from GET /substrate/v1/schema/cortext.
const OPERATORS = {
  operators: {
    'scalar.string': ['eq', 'in', 'contains', 'startsWith'],
    'scalar.number': ['eq', 'gt', 'lt', 'in'],
    crossRef: ['eq', 'in', 'neq', 'nin'],
    list: ['has']
  },
  extensionOperators: ['embeddingSimilar']
};

describe('buildOperatorDigest', () => {
  it('reads the per-kind sets and the extension operators', () => {
    const op = buildOperatorDigest({ ...SCHEMA, ...OPERATORS });
    expect(op.byKind).toEqual([
      ['crossRef', ['eq', 'in', 'neq', 'nin']],
      ['list', ['has']],
      ['scalar.number', ['eq', 'gt', 'lt', 'in']],
      ['scalar.string', ['eq', 'in', 'contains', 'startsWith']]
    ]);
    expect(op.extension).toEqual(['embeddingSimilar']);
  });

  it('absent means UNKNOWN, not "no operators": returns null', () => {
    expect(buildOperatorDigest(SCHEMA)).toBeNull();
    expect(buildOperatorDigest({ ...SCHEMA, operators: null })).toBeNull();
    expect(buildOperatorDigest(null)).toBeNull();
  });

  it('an absent extension list is treated as none, since the per-kind sets arrived', () => {
    expect(buildOperatorDigest({ ...SCHEMA, operators: OPERATORS.operators }).extension).toEqual(
      []
    );
  });
});

describe('renderSchemaDigest operators', () => {
  const entries = buildSchemaDigest(SCHEMA);

  it('renders the operator set once, per kind, inside the block', () => {
    const out = renderSchemaDigest(entries, {
      ns: 'cortext',
      operators: buildOperatorDigest({ ...SCHEMA, ...OPERATORS })
    });
    expect(out).toContain('crossRef: eq|in|neq|nin');
    expect(out).toContain('scalar.string: eq|in|contains|startsWith');
    expect(out.match(/crossRef: eq\|in/g)).toHaveLength(1);
  });

  it('renders extension operators as valid on EVERY kind, never under one kind', () => {
    const out = renderSchemaDigest(entries, {
      ns: 'cortext',
      operators: buildOperatorDigest({ ...SCHEMA, ...OPERATORS })
    });
    expect(out).toMatch(/any kind: embeddingSimilar/);
    expect(out).not.toMatch(/crossRef: [^\n]*embeddingSimilar/);
  });

  it('omits the section entirely when the server did not send the contract', () => {
    const out = renderSchemaDigest(entries, { ns: 'cortext', operators: null });
    expect(out).not.toMatch(/Filter operators/);
    expect(out).toBe(renderSchemaDigest(entries, { ns: 'cortext' }));
  });

  it('still stays small with the operator set included', () => {
    const out = renderSchemaDigest(entries, {
      ns: 'cortext',
      operators: buildOperatorDigest({ ...SCHEMA, ...OPERATORS })
    });
    expect(out.length).toBeLessThan(3000);
  });
});

describe('fetchNamespaceSchema', () => {
  it('uses the PATH-scoped route, not the ?namespace= compatibility surface', async () => {
    // `?namespace=` serves the pre-federation `default` namespace only and 404s
    // on a federated deployment.
    let seen = '';
    await fetchNamespaceSchema('http://h', 'cortext', {
      fetchImpl: async (u) => {
        seen = String(u);
        return new Response(JSON.stringify({ types: {} }), { status: 200 });
      }
    });
    expect(seen).toBe('http://h/substrate/v1/schema/cortext');
  });

  it('returns null on non-2xx, junk, or a throw — never breaks the cold-start', async () => {
    const bad = async () => new Response('{}', { status: 404 });
    expect(await fetchNamespaceSchema('http://h', 'cortext', { fetchImpl: bad })).toBeNull();
    const noTypes = async () => new Response(JSON.stringify({ error: 'x' }), { status: 200 });
    expect(await fetchNamespaceSchema('http://h', 'cortext', { fetchImpl: noTypes })).toBeNull();
    const boom = async () => {
      throw new Error('network');
    };
    expect(await fetchNamespaceSchema('http://h', 'cortext', { fetchImpl: boom })).toBeNull();
  });
});
