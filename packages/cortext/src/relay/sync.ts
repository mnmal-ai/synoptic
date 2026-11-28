/**
 * Directory sync: every 15 minutes, and once at start, each active MailPeer's `Info` and
 * `Directory` are read. The agents a peer lists become remote AgentIdentity rows of its domain, so
 * local agents can address them, and that domain's rows it no longer lists are marked unlisted;
 * sync never changes whether an existing row is active, so an agent its operator hides can still
 * be answered. A peer whose server answers an unsigned read of its mailbox is blocked, unless its
 * row sets `allowOpenReads`. A peer's first clean sync is what makes it usable for sending.
 *
 * Sync holds no connection, transaction or lock while it waits on a peer: it reads the peer's
 * answers first, then writes each row in a short transaction of its own. Each write to the MailPeer
 * row is conditional on the `active` and `blockedReason` sync last read, so an operator's change
 * made meanwhile wins: sync writes nothing to the row and reports it.
 *
 * Nothing a peer writes reaches `blockedReason`, a metric or a warning: they carry this server's
 * fixed reasons, the peer's domain from its MailPeer row, and kids that passed the kid checks.
 * Directory text is stripped of control and format characters and capped before it lands in a row.
 */

import type { Dataset, Row } from '@mnmal-ai/substrate/sdk';
import { isResolverFrameError } from '@mnmal-ai/substrate/sdk';
import type { CortextAuthConfig } from '../config.js';
import { FIELD_MAX_CHARS, isKid, RELAY_ACTOR, upsertRemoteIdentity } from './deliver.js';
import { RELAY_NAMESPACE, RELAY_PROTOCOL_VERSION } from './namespace.js';
import { type PeerAnswer, PeerCallError, peerAuthorization, postToPeer } from './outbox.js';
import type { RelayRuntime } from './runtime.js';

export const SYNC_INTERVAL_MS = 15 * 60_000;
const DIRECTORY_MAX_ENTRIES = 1000;
const NAME_MAX_CHARS = 200;
const DESCRIPTION_MAX_CHARS = 1000;
const UNSAFE = /[\p{Cc}\p{Cf}]/gu;
const INFO = `${RELAY_NAMESPACE}/Info`;
const DIRECTORY = `${RELAY_NAMESPACE}/Directory`;

/** The only values sync writes to `blockedReason`, which a refused sender is shown. */
const BLOCKED = {
  openReads: 'peer answers mail reads without a key',
  version: 'peer speaks another version of the relay protocol',
  domain: 'peer reports another mail domain'
} as const;
const OWN_REASONS: ReadonlySet<unknown> = new Set(Object.values(BLOCKED));
/** Whether sync may change `peer.blockedReason`: it is empty or one sync wrote, not an operator's. */
const syncOwnsReason = (peer: Row): boolean =>
  peer.blockedReason == null || peer.blockedReason === '' || OWN_REASONS.has(peer.blockedReason);

export interface SyncResult {
  upserted: number;
  unlisted: number;
  collisions: string[];
  /** Entries left out for a malformed kid or one naming a host of this server. */
  skipped: number;
  blocked: string | null;
  /** The MailPeer row was switched off, blocked by an operator or removed while sync ran. */
  changed: boolean;
}

/**
 * One peer's sync. Throws, writing nothing, when the peer gives no usable answer; returns with
 * `blocked` set when it blocks the peer, and `changed` set when the peer's row changed under it.
 */
export async function syncPeer(rt: RelayRuntime, peer: Row): Promise<SyncResult> {
  const ds = coordinator(rt);
  const domain = String(peer.domain);
  const result: SyncResult = {
    upserted: 0,
    unlisted: 0,
    collisions: [],
    skipped: 0,
    blocked: null,
    changed: false
  };

  const infoFields = { v: true, domain: true, mailNamespace: true };
  const info = rowsOf(await ask(rt, peer, INFO, { fields: infoFields }), INFO)?.[0];
  if (!isRecord(info)) throw new Error("the peer's Info answer is missing or malformed");
  if (info.v !== RELAY_PROTOCOL_VERSION) return block(rt, ds, peer, BLOCKED.version, result);
  if (info.domain !== domain) return block(rt, ds, peer, BLOCKED.domain, result);
  if (typeof info.mailNamespace !== 'string' || info.mailNamespace === '') {
    throw new Error("the peer's Info answer is missing or malformed");
  }

  if (peer.allowOpenReads !== true) {
    const mailbox = `${info.mailNamespace}/AgentMessage`;
    const frame = { params: { limit: 1 }, fields: { id: true } };
    const probe = await ask(rt, peer, mailbox, frame, false);
    // A refused frame is absent from `data`; present, even empty, means the read was answered.
    if (probe.data !== undefined && Object.hasOwn(probe.data, mailbox)) {
      return block(rt, ds, peer, BLOCKED.openReads, result);
    }
  }

  const answer = await ask(rt, peer, DIRECTORY, {
    params: { limit: DIRECTORY_MAX_ENTRIES },
    fields: { kid: true, displayName: true, project: true, description: true }
  });
  const entries = rowsOf(answer, DIRECTORY);
  if (entries === undefined) {
    throw new Error("the peer's Directory answer is missing or malformed");
  }
  if (entries.length > DIRECTORY_MAX_ENTRIES || answer._pagination?.[DIRECTORY]?.hasMore === true) {
    throw new Error(`the peer's directory has more than ${DIRECTORY_MAX_ENTRIES} entries`);
  }

  // An operator may have switched the peer off or blocked it while sync waited on the network.
  const fresh = (await ds.read('MailPeer', { id: peer.id })).rows[0];
  if (
    fresh === undefined ||
    fresh.active !== true ||
    ((fresh.blockedReason ?? null) !== (peer.blockedReason ?? null) && !syncOwnsReason(fresh))
  ) {
    return changed(rt, peer, result);
  }
  const current: Row = { ...fresh };

  const listed = new Set<string>();
  for (const entry of entries) {
    const kid = isRecord(entry) ? entry.kid : undefined;
    if (!isRecord(entry) || !isKid(kid) || [...kid].length > FIELD_MAX_CHARS) {
      result.skipped += 1;
      continue;
    }
    try {
      await upsertRemoteIdentity(rt, domain, {
        kid,
        listed: true,
        displayName: clean(entry.displayName, NAME_MAX_CHARS),
        project: clean(entry.project, NAME_MAX_CHARS),
        description: clean(entry.description, DESCRIPTION_MAX_CHARS)
      });
      listed.add(kid);
      result.upserted += 1;
    } catch (err) {
      if (!isResolverFrameError(err)) throw err;
      if (err.code === 'local_host') {
        result.skipped += 1;
      } else if (err.code === 'kid_collision') {
        result.collisions.push(kid);
        report(
          rt,
          'cortext.mail_peer_kid_collision',
          { domain, ...err.details },
          `cortext relay: ${err.message}`
        );
      } else {
        throw err;
      }
    }
  }
  if (result.skipped > 0) {
    report(
      rt,
      'cortext.mail_peer_entries_skipped',
      { domain, skipped: result.skipped },
      `cortext relay: skipped ${result.skipped} of ${domain}'s directory entries for a malformed kid or one naming a host of this server`
    );
  }

  result.unlisted = await unlist(rt, ds, domain, listed);
  const synced = await writePeer(rt, ds, current, {
    lastSyncAt: rt.now().toISOString(),
    ...(syncOwnsReason(current) ? { blockedReason: null } : {})
  });
  return synced ? result : changed(rt, current, result);
}

/** Every active peer in turn; a peer whose sync fails is reported and the rest still sync. */
export async function syncPeers(rt: RelayRuntime): Promise<void> {
  const { rows } = await coordinator(rt).read('MailPeer', {
    where: { active: { eq: true } },
    limit: 1000
  });
  // Copies, since a memory store hands out its live rows.
  for (const peer of rows.map((r) => ({ ...r }))) {
    try {
      await syncPeer(rt, peer);
    } catch (err) {
      const domain = String(peer.domain);
      const reason = err instanceof PeerCallError ? `no answer (${err.code})` : errorText(err);
      report(
        rt,
        'cortext.mail_peer_sync_failed',
        { domain, reason },
        `cortext relay: directory sync with ${domain} failed: ${reason}`
      );
    }
  }
}

/**
 * At start: warn once when this server answers reads without a key and has a mail peer, since
 * mail received here is then readable without a key. Whether it warned.
 */
export async function warnOwnOpenReads(
  rt: RelayRuntime,
  auth: CortextAuthConfig,
  warn: (message: string) => void = console.warn
): Promise<boolean> {
  if (auth.reads !== 'open') return false;
  if ((await coordinator(rt).read('MailPeer', { limit: 1 })).rows.length === 0) return false;
  warn(
    'cortext relay: this server answers reads without a key (auth.reads is open) and has mail peers, so mail received here is readable without a key'
  );
  return true;
}

function coordinator(rt: RelayRuntime): Dataset {
  const ds = rt.engine?.datasetFor(rt.mailNamespace);
  if (ds === undefined) {
    throw new Error(`cortext relay: the '${rt.mailNamespace}' dataset is not available yet`);
  }
  return ds;
}

type Envelope = PeerAnswer['envelope'] & {
  _pagination?: Record<string, { hasMore?: boolean } | undefined>;
};

/** One query frame to the peer, signed with its outbound key unless `signed` is false. */
async function ask(
  rt: RelayRuntime,
  peer: Row,
  key: string,
  frame: Record<string, unknown>,
  signed = true
): Promise<Envelope> {
  const authorization = signed ? peerAuthorization(peer) : undefined;
  const answer = await postToPeer(
    rt,
    String(peer.origin),
    'query',
    { [key]: frame },
    authorization
  );
  return answer.envelope;
}

const rowsOf = (envelope: Envelope, key: string): unknown[] | undefined => {
  const rows = envelope.data?.[key];
  return Array.isArray(rows) ? rows : undefined;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Peer text for a row: a string stripped of control and format characters and capped, else null. */
const clean = (v: unknown, max: number): string | null =>
  typeof v === 'string' ? [...v.replace(UNSAFE, '')].slice(0, max).join('') : null;

/** `patch` on the MailPeer row if its `active` and `blockedReason` are still as `peer` has them. */
async function writePeer(
  rt: RelayRuntime,
  ds: Dataset,
  peer: Row,
  patch: Record<string, unknown>
): Promise<boolean> {
  const asRead = { active: peer.active ?? null, blockedReason: peer.blockedReason ?? null };
  const { matched } = await ds.conditionalUpdate(
    'MailPeer',
    peer.id,
    asRead,
    patch,
    RELAY_ACTOR,
    rt.now()
  );
  return matched;
}

function changed(rt: RelayRuntime, peer: Row, result: SyncResult): SyncResult {
  const domain = String(peer.domain);
  report(
    rt,
    'cortext.mail_peer_changed_during_sync',
    { domain },
    `cortext relay: mail peer ${domain} changed during its directory sync, so the sync wrote nothing to it`
  );
  return { ...result, changed: true };
}

async function block(
  rt: RelayRuntime,
  ds: Dataset,
  peer: Row,
  reason: string,
  result: SyncResult
): Promise<SyncResult> {
  const domain = String(peer.domain);
  if (syncOwnsReason(peer) && !(await writePeer(rt, ds, peer, { blockedReason: reason }))) {
    return changed(rt, peer, result);
  }
  report(
    rt,
    'cortext.mail_peer_blocked',
    { domain, reason },
    `cortext relay: mail peer ${domain} is blocked: ${reason}`
  );
  return { ...result, blocked: reason };
}

/**
 * Mark unlisted each row of `domain` whose kid the peer did not list, leaving whether it is active
 * alone; how many it marked. A row without `listed` reads as listed.
 */
async function unlist(
  rt: RelayRuntime,
  ds: Dataset,
  domain: string,
  listed: Set<string>
): Promise<number> {
  const stale: Row[] = [];
  let cursor: string | undefined;
  do {
    const page = await ds.read('AgentIdentity', {
      where: { domain: { eq: domain } },
      limit: 1000,
      ...(cursor !== undefined ? { cursor } : {})
    });
    stale.push(...page.rows.filter((r) => r.listed !== false && !listed.has(String(r.kid))));
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  let unlisted = 0;
  for (const row of stale) {
    const { matched } = await ds.conditionalUpdate(
      'AgentIdentity',
      row.id,
      { domain },
      { listed: false },
      RELAY_ACTOR,
      rt.now()
    );
    if (matched) unlisted += 1;
  }
  return unlisted;
}

function report(rt: RelayRuntime, name: string, payload: unknown, message: string): void {
  rt.metric(name, payload);
  console.warn(message);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
