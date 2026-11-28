/**
 * The relay namespace: the only surface a peer server's key is granted for cross-server mail.
 *
 * Registered under the literal name `cortext-relay` (whatever the coordinator namespace is
 * called) and only when `mailDomain` is configured. It holds no rows. A key granted this
 * namespace alone cannot read or write the coordinator namespace, which is the boundary the
 * relay relies on.
 */

import type {
  NamespaceDefinition,
  NamespaceInstallContext,
  Policy,
  Row
} from '@mnmal-ai/substrate/sdk';
import { and, denyAll, field, or, requireIdentity } from '@mnmal-ai/substrate/sdk';
import type { RelayRuntime } from './runtime.js';

export const RELAY_NAMESPACE = 'cortext-relay';
export const RELAY_PROTOCOL_VERSION = 1;

/** Identity is required whatever `cfg.auth` says: a relay call without a signed peer has no meaning. */
function relayPolicy(ctx: NamespaceInstallContext): Policy {
  const requireCaller = or(
    requireIdentity(),
    denyAll('the relay namespace requires an authenticated identity')
  );
  return ctx.pluginPolicy !== undefined ? and(ctx.pluginPolicy, requireCaller) : requireCaller;
}

export function buildRelayNamespace(rt: RelayRuntime): NamespaceDefinition {
  return {
    namespace: RELAY_NAMESPACE,
    install(ctx) {
      const policy = relayPolicy(ctx);
      const infoFields = {
        id: field.string(),
        v: field.number(),
        domain: field.string(),
        mailNamespace: field.string()
      };
      ctx.registry.register('Info', {
        kind: 'type',
        fields: infoFields,
        policy,
        resolver: async (): Promise<Row[]> => [
          {
            id: 'info',
            v: RELAY_PROTOCOL_VERSION,
            domain: rt.mailDomain,
            mailNamespace: rt.mailNamespace
          } as Row
        ]
      });
    }
  };
}
