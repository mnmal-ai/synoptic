import { describe, expect, it } from 'vitest';
import { defineCapability } from '../src/capability.js';

const spec = {
  name: 'demo',
  namespaces: ['demo'],
  conventions: '## Conventions\nUse `demo/Thing`.',
  coldStart: ({ project }) => `query things for ${project}`
};

describe('defineCapability', () => {
  it('normalises a spec and defaults requiresIdentity to true', () => {
    const cap = defineCapability(spec);
    expect(cap.name).toBe('demo');
    expect(cap.namespaces).toEqual(['demo']);
    expect(cap.requiresIdentity).toBe(true);
    expect(cap.coldStart({ project: 'p' })).toBe('query things for p');
  });

  it('honours an explicit requiresIdentity: false', () => {
    expect(defineCapability({ ...spec, requiresIdentity: false }).requiresIdentity).toBe(false);
  });

  it('rejects a spec missing a required field', () => {
    for (const field of ['name', 'namespaces', 'conventions', 'coldStart']) {
      const { [field]: _omit, ...rest } = spec;
      expect(() => defineCapability(rest), `missing ${field}`).toThrow(new RegExp(field));
    }
  });

  it('rejects an empty namespaces array and a non-function coldStart', () => {
    expect(() => defineCapability({ ...spec, namespaces: [] })).toThrow(/namespaces/);
    expect(() => defineCapability({ ...spec, coldStart: 'nope' })).toThrow(/coldStart/);
  });
});

// Per-namespace needs, back-compatible: an array keeps meaning `read`
// on each namespace (what the audit checked before), and `namespaces` stays a
// list of names for every existing consumer.
describe('defineCapability per-namespace needs', () => {
  it('an array means read on each namespace', () => {
    const cap = defineCapability({ ...spec, namespaces: ['a', 'b'] });
    expect(cap.namespaces).toEqual(['a', 'b']);
    expect(cap.needs).toEqual({ a: ['read'], b: ['read'] });
  });

  it('an object declares capabilities per namespace, and namespaces stays the names', () => {
    const cap = defineCapability({
      ...spec,
      namespaces: { cortext: ['read', 'mutate'], recall: ['read'] }
    });
    expect(cap.namespaces).toEqual(['cortext', 'recall']);
    expect(cap.needs).toEqual({ cortext: ['read', 'mutate'], recall: ['read'] });
  });

  it('rejects an empty object and a namespace with no capabilities', () => {
    expect(() => defineCapability({ ...spec, namespaces: {} })).toThrow(/namespaces/);
    expect(() => defineCapability({ ...spec, namespaces: { a: [] } })).toThrow(/'a'/);
  });
});
