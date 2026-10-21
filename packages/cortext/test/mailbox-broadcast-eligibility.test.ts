/**
 * The eligibility predicate behind `to:'*'` fan-out.
 *
 * ## Why this is a separate file rather than more cases in the send suite
 *
 * The case that matters most cannot be reached through `createAgentIdentity`.
 * `broadcastEligible` is declared `default: true`, and autoCRUD applies that on
 * WRITE — so any row created through the schema always carries the key. The
 * production shape is the opposite: all ten AgentIdentity rows on the live
 * directory predate the field, carry no such key, and read back as `null`.
 *
 * That gap was not theoretical. The first version of this change tested the
 * "predates the field" case through `makeIdentity(...)` and it looked green —
 * but mutating the predicate to `=== true`, which is exactly what a `where`
 * clause would do, left it green too. The test could not fail, because every
 * row it built already had the field set. A test that cannot distinguish the
 * fix from the bug is not coverage.
 *
 * So the predicate is exercised directly against the three shapes a row can
 * actually have, which is the only place the distinction is observable.
 */

import { describe, expect, it } from 'vitest';
import { isBroadcastEligible } from '../src/mailbox.js';

describe('isBroadcastEligible', () => {
  it('includes a row that predates the field — no key at all', () => {
    // A `where: { broadcastEligible: { eq: true } }` filter matches none of
    // these, so filtering in the query would turn every broadcast into
    // `no_recipients`.
    expect(isBroadcastEligible({})).toBe(true);
  });

  it('includes a row whose value reads back null', () => {
    // What the projection actually returns for those rows.
    expect(isBroadcastEligible({ broadcastEligible: null })).toBe(true);
  });

  it('includes an explicit true', () => {
    expect(isBroadcastEligible({ broadcastEligible: true })).toBe(true);
  });

  it('excludes ONLY an explicit false', () => {
    // Opting out has to be deliberate. This is the single value that removes an
    // identity from fan-out, and the fleet default is the intended holder of it
    // — active for signing, silent for broadcasts.
    expect(isBroadcastEligible({ broadcastEligible: false })).toBe(false);
  });

  it('does not treat other falsy values as opt-out', () => {
    // Guards a plausible "simplification" to `Boolean(row.broadcastEligible)`,
    // which would silently drop every pre-field row — the exact bug, reinstated
    // by someone tidying up.
    expect(isBroadcastEligible({ broadcastEligible: 0 })).toBe(true);
    expect(isBroadcastEligible({ broadcastEligible: '' })).toBe(true);
    expect(isBroadcastEligible({ broadcastEligible: undefined })).toBe(true);
  });
});
