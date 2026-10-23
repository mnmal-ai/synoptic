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
 * Whether `host` names the machine in `kid`'s `@host` part, ignoring case.
 * A kid with no `@` names no machine, so it may carry no host.
 */
function hostMatchesKid(host: unknown, kid: unknown): boolean {
  if (host === undefined || host === null) return true;
  if (typeof kid !== 'string' || !kid.includes('@')) return false;
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
  installCtx: NamespaceInstallContext,
  name: string,
  inner: RegistryEntryResolver
): RegistryEntryResolver {
  return async (ctx: RequestContext, args: ResolverArgs) => {
    const params = args.params ?? {};
    if (!isOperator(ctx)) refuseForeignHost(name, params.host, params.kid);
    // pg holds kid uniqueness with an index; the memory dataset has none, and
    // a second row for one kid makes every send to it `ambiguous_recipient`.
    if (typeof params.kid === 'string') {
      const ds: Dataset = args.dataset ?? installCtx.dataset;
      const { rows } = await ds.read('AgentIdentity', {
        where: { kid: { eq: params.kid } },
        limit: 1
      });
      if (rows.length > 0) {
        throw new ResolverFrameError(
          'duplicate_kid',
          `${name}: an AgentIdentity row for '${params.kid}' already exists; update it instead`,
          { field: 'kid' }
        );
      }
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
      // Checked against the host the row will have, so a row filed with a
      // foreign host cannot be made to vouch by setting roaming or project.
      if ('host' in params || 'roaming' in params || 'project' in params) {
        refuseForeignHost(name, 'host' in params ? params.host : row.host, row.kid);
      }
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

/**
 * Todo create/update: `resolution` says why a CLOSED Todo stopped, so a live
 * Todo carries none. A resolution with a live resulting status is refused,
 * and moving a Todo back to a live status clears the one it had.
 */
export function todoResolutionGuard(
  installCtx: NamespaceInstallContext,
  name: string,
  inner: RegistryEntryResolver,
  statusAliases: Readonly<Record<string, string>>
): RegistryEntryResolver {
  const canon = (v: unknown): string => {
    const s = String(v).trim().toLowerCase();
    return statusAliases[s] ?? s;
  };
  return async (ctx: RequestContext, args: ResolverArgs) => {
    const params = { ...(args.params ?? {}) };
    const statusGiven = params.status !== undefined && params.status !== null;
    let resulting: string | null = statusGiven ? canon(params.status) : null;
    let current: Record<string, unknown> | null = null;
    const id = rowId(args);
    if (id !== undefined) {
      const ds: Dataset = args.dataset ?? installCtx.dataset;
      current = await resolveEntityRow(ds, 'Todo', id);
      if (resulting === null && current !== null) resulting = canon(current.status);
    }
    if (resulting === null) resulting = 'open';
    if (resulting === 'closed') return inner(ctx, args);
    if (params.resolution !== undefined && params.resolution !== null) {
      throw new ResolverFrameError(
        'resolution_on_live_todo',
        `${name}: 'resolution' is for closed Todos; this one would be '${resulting}'`,
        { field: 'resolution' }
      );
    }
    if (
      statusGiven &&
      current !== null &&
      current.resolution != null &&
      !('resolution' in params)
    ) {
      params.resolution = null;
    }
    return inner(ctx, { ...args, params });
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
