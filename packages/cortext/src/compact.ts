/**
 * Compact route — archives old sessions and cascades the archive flag onto
 * their decisions:
 *   1. Read live SessionLog rows newest first; keep the newest `retention`
 *      PER PROJECT (a global window lets a busy project empty a quiet one).
 *   2. Cascade-archive every live Decision whose `sessionId` points at a
 *      session being archived, or that another Decision's `supersedes`
 *      names (not the Decision CARRYING `supersedes`, which is the current one).
 *   3. Archive the decisions, then the sessions, so a failure between the
 *      two writes is recomputed by the next run instead of lost.
 *
 * `EngineHandle` is namespace-agnostic — the caller
 * supplies qualified keys (§4.7) — so we wrap the engine locally with two
 * tiny adapters: `queryAll` (envelope → typed rows) and `mutateOne` (run one
 * mutation by name). Both thread through a `RequestContext` that mirrors what
 * the HTTP route layer constructs.
 */

import type {
  EngineHandle,
  PluginRouteContext,
  PluginRouter,
  SubstrateRequest
} from '@mnmal-ai/substrate/sdk';
import {
  formatQualifiedKey,
  grantedIn,
  grantOf,
  jsonResponse,
  makeCtx,
  queryAll,
  selectAll
} from '@mnmal-ai/substrate/sdk';
import { DEFAULT_AUTH } from './auth-policy.js';
import type { CortextAuthConfig } from './config.js';

export interface CompactResult {
  dryRun: boolean;
  sessionsArchived: number;
  decisionsArchived: number;
  sessionsRetained: number;
  messagesArchived: number;
}

/**
 * Tunables for the per-call compact behaviour beyond the session-retention
 * count. `mailMaxAgeMs` exists primarily for tests — `_metadata` timestamps
 * are server-stamped, so a test can't author old mail; it shrinks the window
 * instead.
 */
export interface CompactOptions {
  mailMaxAgeMs?: number;
}

/**
 * Acked agent mail older than this is archived by the compact sweep (fan-out
 * writes one row per recipient, and without a policy the
 * acked majority accumulates in the mailbox scan forever). 30 days keeps a
 * generous correspondence-history window; `acked` means the recipient
 * explicitly actioned it, and `archived` only drops it from inbox-shaped
 * queries — the row remains queryable.
 */
const MAIL_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

interface SessionRow {
  id: string;
  project?: string | null;
}

interface DecisionRow {
  id: string;
  sessionId?: string | null;
  // A crossRef id, but some rows store it as a one-element LIST, so both
  // shapes are read.
  supersedes?: string | string[] | null;
}

/** The ids a Decision's `supersedes` names, whichever shape it was stored in. */
function supersededIds(d: DecisionRow): string[] {
  const v = d.supersedes;
  if (typeof v === 'string' && v !== '') return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '');
  return [];
}

async function mutateBatch(
  engine: EngineHandle,
  ns: string,
  mutationName: string,
  paramsList: readonly Record<string, unknown>[],
  fields: readonly string[]
): Promise<void> {
  if (paramsList.length === 0) return;
  const key = formatQualifiedKey(ns, mutationName);
  const selected = selectAll(fields);
  const envelope = await engine.mutate({
    frame: { [key]: paramsList.map((params) => ({ params, fields: selected })) },
    // System envelope (resolve-identity.ts contract): internal maintenance
    // writes carry an explicit { kind: 'system', id } identity so the
    // identity-gated write posture passes and createdBy/updatedBy attribute
    // honestly as system:cortext:compact rather than anonymous.
    //
    // `grants` is required on Identity. An empty `{}` would be the worst
    // option: `grantOf` returns `{}` and every call is refused. Scoped to `ns`
    // because every archive this actor makes goes through here with that
    // namespace, so `'*'` would claim authority it never uses. `admin` because
    // archiving other agents' acked mail is an operator act: this is the
    // maintenance actor, not a participant.
    ctx: {
      ...makeCtx(ns, 'mutate'),
      identity: {
        kind: 'system',
        id: 'cortext:compact',
        grants: { [ns]: ['read', 'mutate', 'admin'] }
      }
    }
  });
  // Surface envelope errors loudly — swallowing them here would let a
  // policy-denied (or otherwise failed) archive report success upstream.
  const failed = envelope.errors?.[0];
  if (failed !== undefined) {
    throw new Error(`cortext compact: batched ${mutationName} failed: ${failed.message}`);
  }
}

/**
 * Hard ceiling on per-call compaction reads. Without this, queryAll
 * pulls every SessionLog + Decision row into Node.js memory regardless of
 * corpus size — fine at 100s of rows, an OOM risk at 10k+ once
 * multi-project use accumulates. 10k is well above any realistic active
 * corpus and still bounds memory at single-MB. Beyond it, compaction
 * processes the most-recent 10k window per call; subsequent invocations
 * pick up the rest. Project-scoped compaction (passing a `where: { project }`
 * filter) is the proper long-term fix.
 */
const MAX_COMPACT_SCAN = 10_000;

export async function runCompact(
  engine: EngineHandle,
  ns: string,
  retention: number,
  dryRun: boolean,
  opts: CompactOptions = {}
): Promise<CompactResult> {
  // Newest first by server-stamped createdAt, ordered SERVER-SIDE so the
  // MAX_COMPACT_SCAN window is genuinely the most-recent slice of the corpus
  // and the retention cut keeps the newest sessions rather
  // than whatever UUIDv4 ids happened to sort last lexically.
  // Archived rows are filtered server-side: retention means
  // "newest N LIVE sessions" — an already-archived row neither consumes a
  // slot nor gets fetched just to be discarded.
  const sessions = await queryAll<SessionRow>(
    engine,
    ns,
    'SessionLog',
    {
      where: { archived: { eq: false } },
      limit: MAX_COMPACT_SCAN,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    },
    ['id', 'project']
  );

  // No early return on an empty session store — the mailbox sweep below must
  // still run (mail volume is independent of session count), and every
  // downstream step no-ops safely on empty arrays (mutateBatch returns
  // immediately for an empty params list).
  // Retention is PER PROJECT: the newest `retention` live sessions of
  // each project survive. A single global window let a busy project archive
  // every session of a quiet one. Rows arrive newest first, so the first
  // `retention` seen per project are the ones kept. Cross-cutting sessions
  // (no project) form their own group.
  const keptPerProject = new Map<string, number>();
  const retained: SessionRow[] = [];
  const toArchive: SessionRow[] = [];
  for (const session of sessions) {
    const group = session.project ?? '';
    const kept = keptPerProject.get(group) ?? 0;
    if (kept < retention) {
      keptPerProject.set(group, kept + 1);
      retained.push(session);
    } else {
      toArchive.push(session);
    }
  }
  const archivedSessionIds = new Set<string>(toArchive.map((s) => s.id));

  // Archived decisions were always discarded client-side — push the filter
  // into the read (strictly semantics-preserving here).
  const decisions = await queryAll<DecisionRow>(
    engine,
    ns,
    'Decision',
    { where: { archived: { eq: false } }, limit: MAX_COMPACT_SCAN },
    ['id', 'sessionId', 'supersedes']
  );

  // `supersedes` sits on the NEWER decision and names the one it replaced.
  // The replaced one is what retires; archiving the row CARRYING
  // `supersedes` would hide every live decision that replaced another.
  const superseded = new Set<string>(decisions.flatMap(supersededIds));
  const decisionsToArchive = decisions.filter(
    (d) => (d.sessionId != null && archivedSessionIds.has(d.sessionId)) || superseded.has(d.id)
  );

  // Decisions FIRST, then their sessions. The other order lost the cascade
  // for good when the decision write failed: the next run reads only live
  // sessions, so it never saw those sessions again. In this order a failure
  // between the two leaves the sessions live, and the next run recomputes
  // the same set; the decision writes are idempotent.
  if (!dryRun) {
    await mutateBatch(
      engine,
      ns,
      'updateDecision',
      decisionsToArchive.map((d) => ({ id: d.id, archived: true })),
      ['id']
    );
    await mutateBatch(
      engine,
      ns,
      'updateSessionLog',
      toArchive.map((s) => ({ id: s.id, archived: true })),
      ['id']
    );
  }

  // Mailbox sweep: acked fan-out mail accumulates forever
  // without a policy. `acked` is the recipient's explicit done-signal and the
  // last status transition, so the server-stamped updatedAt approximates
  // ackedAt while routing to the indexed metadata column. `archived` is not a
  // transition field, so the mailboxWriteGuard admits the batch update.
  const mailCutoff = new Date(Date.now() - (opts.mailMaxAgeMs ?? MAIL_ARCHIVE_AFTER_MS));
  const ackedMail = await queryAll<{ id: string }>(
    engine,
    ns,
    'AgentMessage',
    {
      where: {
        status: { eq: 'acked' },
        archived: { eq: false },
        updatedAt: { lt: mailCutoff.toISOString() }
      },
      limit: MAX_COMPACT_SCAN
    },
    ['id']
  );

  if (!dryRun) {
    await mutateBatch(
      engine,
      ns,
      'updateAgentMessage',
      ackedMail.map((m) => ({ id: m.id, archived: true })),
      ['id']
    );
  }

  return {
    dryRun,
    sessionsArchived: toArchive.length,
    decisionsArchived: decisionsToArchive.length,
    sessionsRetained: retained.length,
    messagesArchived: ackedMail.length
  };
}

function parseBody(req: SubstrateRequest): { dryRun: boolean } | { error: string } {
  const raw = req.body;
  if (raw === null || raw.length === 0) {
    return { dryRun: false };
  }
  const text = raw.toString('utf8');
  if (text.trim().length === 0) return { dryRun: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { dryRun: false };
  }
  const dryRun = (parsed as { dryRun?: unknown }).dryRun === true;
  return { dryRun };
}

export function registerCompactRoute(
  router: PluginRouter,
  ctx: PluginRouteContext,
  retention: number,
  namespace: string,
  auth: CortextAuthConfig = DEFAULT_AUTH
): void {
  router.post('/compact', async (req) => {
    // The route runs as the system actor, which every gated-write policy
    // passes, so the route has to check its own caller. Compaction
    // archives across every project, so under gated writes it is an
    // operator's call; an open posture stays open, as it does for writes.
    if (auth.writes === 'identity') {
      const caps = grantedIn(grantOf(req.identity ?? null), namespace);
      if (!caps.includes('admin') && !caps.includes('*')) {
        return jsonResponse(403, {
          code: 'operator_only',
          message: `POST /compact archives across every project and needs an operator (admin in '${namespace}')`
        });
      }
    }
    const parsed = parseBody(req);
    if ('error' in parsed) {
      return jsonResponse(400, { code: 'bad_request', message: parsed.error });
    }
    const result = await runCompact(ctx.engine, namespace, retention, parsed.dryRun);
    return jsonResponse(200, result);
  });
}
