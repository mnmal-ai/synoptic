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
  RequestContext,
  Row
} from '@mnmal-ai/substrate/sdk';
import {
  and,
  denyAll,
  field,
  or,
  ResolverFrameError,
  requireIdentity
} from '@mnmal-ai/substrate/sdk';
import { listDirectory } from './directory.js';
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

/**
 * The active MailPeer whose `inboundKid` is the caller's kid, else `unknown_peer`. MailPeer's
 * registry entries are operator-only, so the row is read straight from the coordinator dataset.
 */
export async function requirePeer(rt: RelayRuntime, ctx: RequestContext): Promise<Row> {
  const kid = ctx.identity?.id;
  const ds = rt.engine?.datasetFor(rt.mailNamespace);
  if (kid !== undefined && ds !== undefined) {
    const { rows } = await ds.read('MailPeer', {
      where: { inboundKid: { eq: kid }, active: { eq: true } },
      limit: 1
    });
    if (rows[0] !== undefined) return rows[0];
  }
  throw new ResolverFrameError('unknown_peer', 'the caller is not an active mail peer');
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
      ctx.registry.register('Directory', {
        kind: 'type',
        fields: {
          id: field.string(),
          kid: field.string(),
          displayName: field.string({ nullable: true }),
          project: field.string({ nullable: true }),
          description: field.string({ nullable: true })
        },
        policy,
        resolver: async (rctx): Promise<Row[]> => {
          await requirePeer(rt, rctx);
          return (await listDirectory(rt)) as unknown as Row[];
        }
      });
    }
  };
}
