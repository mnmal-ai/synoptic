/**
 * "Only the parties involved, or an operator" — the row-level authority the
 * mailbox and the identity directory share.
 *
 * A Policy is synchronous and sees the caller, never the row, so it can say
 * WHICH fields a write may touch but not WHOSE row it is. These wrappers sit
 * on the resolver instead: they read the row, decide, and only then hand the
 * call to the resolver they wrap. An id that matches no row falls through to
 * the wrapped resolver, which owns the not-found contract.
 *
 * An operator is an identity granted `admin` (or `*`) in this namespace.
 */

import type {
  Dataset,
  NamespaceInstallContext,
  RegistryEntryResolver,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate/sdk';
import { grantedIn, grantOf, ResolverFrameError, resolveEntityRow } from '@mnmal-ai/substrate/sdk';

/** Whether the caller holds `admin` (or `*`) in the namespace it is calling. */
export function isOperator(ctx: RequestContext): boolean {
  const caps = grantedIn(grantOf(ctx.identity), ctx.namespace);
  return caps.includes('admin') || caps.includes('*');
}

function rowId(args: ResolverArgs): string | number | undefined {
  const raw = args.params?.id;
  return typeof raw === 'string' || typeof raw === 'number' ? raw : undefined;
}

function callerKid(ctx: RequestContext): string | null {
  const id = ctx.identity?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * AgentMessage update/delete: the sender, the recipient, or an operator.
 * The sender is the key that signed the send (`_metadata.createdBy`); the
 * recipient is the kid on the addressed directory row. Archiving someone
 * else's mail hides it from their inbox, and deleting it destroys it, so
 * neither is a bystander's call.
 */
export function messageParticipantsOnly(
  installCtx: NamespaceInstallContext,
  name: string,
  inner: RegistryEntryResolver
): RegistryEntryResolver {
  return async (ctx: RequestContext, args: ResolverArgs) => {
    const id = rowId(args);
    if (id === undefined || isOperator(ctx)) return inner(ctx, args);
    const ds: Dataset = args.dataset ?? installCtx.dataset;
    const message = await resolveEntityRow(ds, 'AgentMessage', id);
    if (message === null) return inner(ctx, args);

    const caller = callerKid(ctx);
    const sender = (message as Row & { _metadata?: { createdBy?: { id?: unknown } | null } })
      ._metadata?.createdBy?.id;
    let recipient: unknown = null;
    if (typeof message.recipient === 'string' && message.recipient !== '') {
      const { rows } = await ds.read('AgentIdentity', { id: message.recipient });
      recipient = rows[0]?.kid ?? null;
    }
    if (caller !== null && (caller === sender || caller === recipient)) return inner(ctx, args);
    throw new ResolverFrameError(
      'not_participant',
      `${name}: only this message's sender ('${String(sender ?? 'unknown')}') or recipient ` +
        `('${String(recipient ?? 'unknown')}'), or an operator, may change or delete it`,
      { id: message.id }
    );
  };
}

/**
 * Whether `host` names the machine in `kid`'s `@host` part, ignoring case. A
 * kid with no `@` constrains nothing.
 */
function hostMatchesKid(host: unknown, kid: unknown): boolean {
  if (typeof kid !== 'string' || !kid.includes('@')) return true;
  if (host === undefined || host === null) return true;
  return String(host).toLowerCase() === kid.slice(kid.lastIndexOf('@') + 1).toLowerCase();
}

function refuseForeignHost(name: string, host: unknown, kid: unknown): void {
  if (hostMatchesKid(host, kid)) return;
  throw new ResolverFrameError(
    'operator_only',
    `${name}: 'host' must be the machine in the kid ('${String(kid)}'); only an operator may set another`,
    { field: 'host' }
  );
}

/**
 * AgentIdentity create: a non-operator may not file a row whose `host` is a
 * machine other than the one its kid names. The fleet audit trusts `host`
 * (and `roaming` on that host) when it decides who may write a host's
 * HostInstall rows.
 */
export function identityCreateGuard(
  name: string,
  inner: RegistryEntryResolver
): RegistryEntryResolver {
  return async (ctx: RequestContext, args: ResolverArgs) => {
    if (!isOperator(ctx)) {
      const params = args.params ?? {};
      refuseForeignHost(name, params.host, params.kid);
    }
    return inner(ctx, args);
  };
}

/**
 * AgentIdentity update: the identity itself (the caller's kid is the row's
 * kid) or an operator. `kid` is the row's identity, so changing it is an
 * operator act even on your own row: otherwise a row could be renamed onto a
 * kid whose mail it would then receive. `host` must stay the kid's machine,
 * and reactivating a retired row is an operator act.
 */
export function identitySelfOnly(
  installCtx: NamespaceInstallContext,
  name: string,
  inner: RegistryEntryResolver
): RegistryEntryResolver {
  return async (ctx: RequestContext, args: ResolverArgs) => {
    const id = rowId(args);
    if (id === undefined || isOperator(ctx)) return inner(ctx, args);
    const ds: Dataset = args.dataset ?? installCtx.dataset;
    const row = await resolveEntityRow(ds, 'AgentIdentity', id);
    if (row === null) return inner(ctx, args);

    const params = args.params ?? {};
    if ('kid' in params && params.kid !== row.kid) {
      throw new ResolverFrameError(
        'operator_only',
        `${name}: 'kid' is the row's identity and only an operator may change it`,
        { field: 'kid' }
      );
    }
    if (callerKid(ctx) === row.kid) {
      if ('host' in params) refuseForeignHost(name, params.host, row.kid);
      if (params.active === true && row.active === false) {
        throw new ResolverFrameError(
          'operator_only',
          `${name}: a retired identity may only be reactivated by an operator`,
          { field: 'active' }
        );
      }
      return inner(ctx, args);
    }
    throw new ResolverFrameError(
      'not_self',
      `${name}: only '${String(row.kid)}' itself, or an operator, may edit this identity row`,
      { id: row.id }
    );
  };
}

/** AgentIdentity delete: operators only. Mail hangs off these rows. */
export function operatorOnly(name: string, inner: RegistryEntryResolver): RegistryEntryResolver {
  return async (ctx: RequestContext, args: ResolverArgs) => {
    if (isOperator(ctx)) return inner(ctx, args);
    throw new ResolverFrameError(
      'operator_only',
      `${name}: only an operator may delete an identity row; retire it with active: false instead`,
      {}
    );
  };
}
