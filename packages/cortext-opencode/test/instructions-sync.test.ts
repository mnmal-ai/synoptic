// The conventions body is shared between the two skins; only the line-1
// marker differs (skin tag + install path). Gating on the marker alone
// would let content drift silently; gating on full bytes would forbid
// the marker. So: body-identity plus a marker that must carry the SAME
// version+digest as the source marker.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const OURS = readFileSync(join(HERE, '..', 'instructions', 'substrate-conventions.md'), 'utf8');
const SOURCE = readFileSync(
  join(HERE, '..', '..', 'cortext-plugin', 'fragments', 'substrate-conventions.md'),
  'utf8'
);

function split(text: string): { marker: string; body: string } {
  const nl = text.indexOf('\n');
  return { marker: text.slice(0, nl), body: text.slice(nl + 1) };
}

function markerParts(marker: string): { version: string; digest: string } {
  const m = /vsynoptic-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\+([0-9a-f]{8})/.exec(marker);
  if (m?.[1] === undefined || m[2] === undefined) throw new Error(`unparseable marker: ${marker}`);
  return { version: m[1], digest: m[2] };
}

describe('opencode instructions share the Claude fragment body', () => {
  it('body after line 1 is byte-identical', () => {
    expect(split(OURS).body).toBe(split(SOURCE).body);
  });

  it('marker names this skin and tracks the source version+digest', () => {
    const ours = split(OURS).marker;
    const source = split(SOURCE).marker;
    expect(ours).toContain('opencode skin');
    expect(markerParts(ours)).toEqual(markerParts(source));
  });
});
