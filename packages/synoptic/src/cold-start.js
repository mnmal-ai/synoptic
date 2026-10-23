// Cold-start orchestrator. Reads the binding rules and the inbox over HTTP and
// emits the rule index: every `must` and pinned rule one line each, pointers to
// everything else, the session line and an inbox count. All I/O goes through an
// injectable fetchImpl. Never throws — on any failure returns a terse offline
// comment so the session is never blocked.

import { hostname as osHostname } from 'node:os';
import { basename } from 'node:path';
import { truncateToBudget as truncateGeneric } from '@mnmal-ai/context-render';
import {
  checkBackupFreshness,
  checkBackupOutcome,
  renderBackupOutcomeWarning,
  renderBackupWarning
} from './backup-freshness.js';
import { diskWarning } from './disk-headroom.js';
import { fragmentDriftCheck, renderFragmentDrift } from './fragment-drift.js';
import { runHostChecks } from './host-checks.js';
import { buildHostInstallRecord } from './host-install.js';
import { reportHostInstall, reportHostWithChecks } from './host-report.js';
import { importResolutionWarning } from './import-resolve.js';
import { loadInbox, renderInbox } from './inbox.js';
import { renderRuleIndex } from './index-render.js';
import { createProjectionAudit } from './projection-audit.js';
import { projectWhere } from './scope.js';
import { renderSessionBlock } from './session.js';
import { substrateQuery } from './substrate-http.js';

// Host-specific backup watchdog. Opt-in via SYNOPTIC_BACKUP_CHECK=on — default-off
// so generic plugin consumers never stat a backup directory. The operator (e.g.
// the substrate commodity host) flips it on to turn cold-start into the alert
// channel for a silently-stopped backup cron. Never throws.
//
// Two checks, deliberately both rendered. Freshness says something has been
// wrong for a while and cannot say why; the sidecar's own verdict says it broke
// just now and carries the error text. Neither subsumes the other: freshness
// can still PASS while every recent attempt has failed.
export function backupWarning(env = process.env, now = Date.now()) {
  if (env.SYNOPTIC_BACKUP_CHECK !== 'on') return '';
  const dir = env.SYNOPTIC_BACKUP_DIR;
  if (!dir)
    return '⚠ BACKUP CHECK FAILED: SYNOPTIC_BACKUP_CHECK=on but SYNOPTIC_BACKUP_DIR is unset.\n\n';
  try {
    const result = checkBackupFreshness({
      dir,
      pattern: new RegExp(env.SYNOPTIC_BACKUP_PATTERN ?? '\\.sql\\.gz$'),
      maxAgeHours: Number(env.SYNOPTIC_BACKUP_MAX_AGE_HOURS) || 30,
      now
    });
    return renderBackupOutcomeWarning(checkBackupOutcome({ dir })) + renderBackupWarning(result);
  } catch {
    return '';
  }
}

/**
 * Hard-cap a rendered cold-start for harnesses that enforce a hook-stdout
 * ceiling by killing the hook instead of truncating (Muse terminates the
 * process tree past 16384 bytes and parses nothing).
 * Cuts at a newline boundary so no rule is split mid-text, then appends a
 * pointer naming what lives below the cut so the agent pulls it on demand.
 * Pass-through when the text already fits or maxBytes is not a positive
 * finite number; the total never exceeds maxBytes.
 */
export function truncateToBudget(text, maxBytes) {
  // Mechanics in @mnmal-ai/context-render; the pointer names cortext's
  // own types, which the shared package must not.
  return truncateGeneric(text, { maxBytes, pointer: COLD_START_POINTER });
}

// Pure ASCII: the degenerate-budget fallback byte-slices the pointer itself.
const COLD_START_POINTER =
  '\n<!-- truncated for a hook-output ceiling: the sections below the cut ' +
  'are PRESENT, not empty -- pull the rules with query (cortext/AgentRule) -->\n';

/**
 * Build the full cold-start markdown. Never throws.
 * @returns {Promise<string>}
 */
export async function runColdStart(opts) {
  const {
    substrateUrl,
    namespace = 'cortext',
    projectSlug,
    nowMs = Date.now(),
    fetchImpl = fetch,
    agentKid = process.env.SUBSTRATE_AGENT_KEY_ID,
    cwd = null,
    pluginRoot = null,
    readFile = null,
    sessionId = null,
    listDir = null,
    cacheDir = null,
    // Recorded in this host's HostInstall row: the plugin version that served
    // the session and the harness running it.
    pluginVersion = null,
    harness = 'hook',
    hostReport = process.env.SYNOPTIC_HOST_REPORT !== 'off',
    hostname = osHostname(),
    // The overlaid env the entry resolved, for the settings snapshot, and the
    // signer's own warning, for the authority check.
    env = process.env,
    authWarning = null
  } = opts;

  // Backup watchdog runs independent of Substrate — compute it first so a
  // stale-backup alert surfaces even when the server is down or unconfigured
  // (that's exactly when it matters most). Empty string unless opted in.
  //
  // The conventions-fragment check rides alongside for the same reason: it is a
  // local-filesystem fact, and a stale fragment is MORE likely to matter when
  // the server is down, because the fragment is then the only guidance the
  // agent has. Both are prepended, and both survive the offline return below.
  // Computed once: rendered as the drift warning below, and recorded in this
  // host's HostInstall row.
  const drift =
    cwd && readFile
      ? fragmentDriftCheck({
          cwd,
          pluginRoot,
          readFile,
          listDir,
          cacheDir,
          // An agent identity means this repo opted in, so a missing
          // fragment is a gap to report rather than a non-consumer.
          onboarded: Boolean(agentKid)
        })
      : null;

  const warn =
    backupWarning(process.env, nowMs) +
    // Opt-in, same contract as the backup watchdog above: off unless the
    // host asked for it. A volume that is filling is
    // silent for every day of approach and loud exactly once, at the end.
    diskWarning(process.env) +
    (drift === null ? '' : renderFragmentDrift(drift)) +
    // A dangling `@` import emits NOTHING from Claude Code, so the instructions
    // are absent and the session reads as though they were never written.
    // Same placement and the same reason as the two above: a local
    // filesystem fact, computed before the reads so it survives the offline
    // return — and a missing conventions import matters MOST when the server
    // is down, because the file is then the only guidance there is.
    (cwd && readFile ? importResolutionWarning({ cwd, readFile }) : '');

  if (!substrateUrl) return `${warn}<!-- substrate offline: SUBSTRATE_URL not set -->\n`;

  // Projection drift. Unlike the two watchdogs above this one is a
  // SERVER fact, so it can only be rendered after the reads — hence a
  // collector threaded through the query sites rather than another prepended
  // string. Renders '' in the normal case; see projection-audit.js for why the
  // residue rather than the raw diagnostic is what gets to speak.
  const projectionAudit = createProjectionAudit();

  // What this host has installed for this repo. Started now, alongside the
  // reads, so it adds no round trips to the render; reportHostInstall never
  // throws and bounds itself to one shared budget. Skipped without an identity
  // (anonymous writes are refused at the transport), when switched off, or
  // when there is no repo to name. A refusal gets its own comment line rather
  // than the projection audit's, whose "sections are MISSING" would be false
  // for a write.
  let hostReportNote = '';
  const project = cwd ? basename(cwd) : null;
  const hostReportP =
    hostReport && agentKid && project
      ? reportHostWithChecks({
          base: buildHostInstallRecord({
            hostname,
            project,
            kid: agentKid,
            harness,
            pluginVersion,
            drift,
            nowMs
          }),
          checks: () =>
            runHostChecks({
              cwd,
              env,
              harness,
              pluginVersion,
              substrateUrl,
              namespace,
              fetchImpl,
              agentKid,
              authWarning
            }),
          report: (record, onFailure) =>
            reportHostInstall({ substrateUrl, namespace, fetchImpl, record, onFailure })
        }).then(({ failure, checksNote }) => {
          // One line each, and unable to close the comment it sits in.
          const safe = (text) => text.replace(/[\r\n]+/g, ' ').replace(/--+>?/g, '-');
          if (failure !== null) {
            hostReportNote = `<!-- HostInstall not recorded: ${safe(`${failure[0]} — ${failure[1]}`)} -->\n`;
          } else if (checksNote !== null) {
            hostReportNote = `<!-- HostInstall checks not recorded: ${safe(checksNote)} -->\n`;
          }
        })
      : null;

  try {
    // Two roots, launched together. The inbox swallows its own failure; the
    // rules query propagates to the catch below, which renders the offline
    // comment, because a server that cannot answer it has nothing to say.
    const inboxP = (async () => {
      try {
        const messages = await loadInbox({ substrateUrl, namespace, agentKid, fetchImpl });
        return renderInbox(messages ?? [], { ns: namespace });
      } catch (err) {
        return `<!-- inbox unavailable: ${String(err?.message ?? err)} -->`;
      }
    })();

    const rulesKey = `${namespace}/AgentRule`;
    // Pages to the end: a `must` past the first page would otherwise drop silently.
    const rulesP = (async () => {
      const rows = [];
      let cursor;
      for (let page = 0; page < 20; page++) {
        let pagination = {};
        const data = await substrateQuery(
          substrateUrl,
          {
            [rulesKey]: {
              params: {
                where: { ...projectWhere(projectSlug), active: { eq: true } },
                limit: 200,
                ...(cursor !== undefined ? { cursor } : {})
              },
              fields: {
                shortId: true,
                category: true,
                severity: true,
                pinned: true,
                synopsis: true
              }
            }
          },
          {
            fetchImpl,
            onUnexpectedProjection: (entries) => projectionAudit.record(entries),
            onFrameFailure: (k, d) => projectionAudit.recordFailure(k, d),
            onPagination: (p) => {
              pagination = p;
            }
          }
        );
        if (!(rulesKey in data)) return data;
        rows.push(...data[rulesKey]);
        const { hasMore, nextCursor } = pagination[rulesKey] ?? {};
        if (!hasMore) return { [rulesKey]: rows };
        if (nextCursor === undefined) throw new Error(`${rulesKey}: hasMore with no nextCursor`);
        cursor = nextCursor;
      }
      throw new Error(`${rulesKey}: more than 20 pages of rules`);
    })();

    const [data, inboxMd] = await Promise.all([rulesP, inboxP]);
    // The HostInstall report, started before the reads, is awaited so the
    // hook process does not exit mid-write.
    await hostReportP;

    // A rejected frame is absent from `data`: render no index rather than an
    // index claiming zero binding rules. The projection audit names the failure.
    const indexMd =
      rulesKey in data
        ? renderRuleIndex(data[rulesKey], { ns: namespace, project: projectSlug ?? project })
        : '';
    const sessionMd = renderSessionBlock({ sessionId, kid: agentKid ?? null });

    const body = [indexMd, sessionMd, inboxMd].filter((s) => s !== '').join('\n\n');
    return `${warn}${projectionAudit.render()}${hostReportNote}${body}\n`;
  } catch (err) {
    // The audit still renders on the failure path: a projection that stopped
    // matching the schema is a plausible CAUSE of the error, so suppressing it
    // here would hide the diagnostic exactly when it is most wanted.
    return `${warn}${projectionAudit.render()}<!-- substrate offline: ${String(err?.message ?? err)} -->\n`;
  }
}
