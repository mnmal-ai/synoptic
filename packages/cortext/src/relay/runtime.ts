/** State the relay's entries share: the engine (known once the server starts), the clock and the HTTP client. */

import type { EdgesStore, EngineHandle } from '@mnmal-ai/substrate/sdk';
import type { CortextPluginConfig } from '../config.js';

export interface RelayRuntime {
  /** Set by the plugin's `onStart`; undefined until the server has started. */
  engine: EngineHandle | undefined;
  /** The edges store, set when the relay namespace installs; the engine shares one across namespaces. */
  edges: EdgesStore | undefined;
  /** The coordinator namespace that holds the mailbox. */
  mailNamespace: string;
  /** This server's mail domain, the part after `@` in the kids it serves. */
  mailDomain: string;
  fetchImpl: typeof fetch;
  now: () => Date;
}

export function createRelayRuntime(
  cfg: Pick<CortextPluginConfig, 'namespace' | 'mailDomain'>,
  overrides: Partial<RelayRuntime> = {}
): RelayRuntime {
  return {
    engine: undefined,
    edges: undefined,
    mailNamespace: cfg.namespace,
    mailDomain: cfg.mailDomain ?? '',
    fetchImpl: fetch,
    now: () => new Date(),
    ...overrides
  };
}
