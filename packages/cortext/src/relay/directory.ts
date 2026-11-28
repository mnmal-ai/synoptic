/** The Directory read: the local agents a peer server may address. */

import type { Row } from '@mnmal-ai/substrate/sdk';
import { isLocalIdentity } from '../participants.js';
import type { RelayRuntime } from './runtime.js';

export interface DirectoryEntry {
  id: string;
  kid: string;
  displayName: string | null;
  project: string | null;
  description: string | null;
}

/**
 * Active, local, listed identities. A row written before `listed` existed has no key and counts as
 * listed. The read selects local rows, so remote ones never use up its limit.
 */
export async function listDirectory(rt: RelayRuntime): Promise<DirectoryEntry[]> {
  const ds = rt.engine?.datasetFor(rt.mailNamespace);
  if (ds === undefined) return [];
  const { rows } = await ds.read('AgentIdentity', {
    where: { active: { eq: true }, domain: { eq: null } },
    limit: 1000
  });
  return rows
    .filter((r: Row) => isLocalIdentity(r) && r.listed !== false)
    .map((r: Row) => ({
      id: String(r.id),
      kid: String(r.kid),
      displayName: (r.displayName as string | null | undefined) ?? null,
      project: (r.project as string | null | undefined) ?? null,
      description: (r.description as string | null | undefined) ?? null
    }));
}
