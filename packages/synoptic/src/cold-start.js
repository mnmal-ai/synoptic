// Cold-start orchestrator. Reads project context over HTTP and emits the four
// synoptic markdown sections (Concepts, Agent Memory, Open Work, Agent Rules).
// All I/O goes through an injectable fetchImpl. Never throws — on any failure
// returns a terse offline comment so the session is never blocked.
//
// Agent Memory tiers automatically: with an anchor + server-side recall it
// renders the hybrid RRF view; when recall is unavailable (503) it falls back
// to structural (importance × recency) ordering. The fallback needs no separate
// branch in the ranker — rankWithRRF degrades to structural when every
// semanticRank is null — but we render the dedicated structural view for
// clarity and to avoid a misleading "hybrid" header.

import { hostname as osHostname } from 'node:os';
import { basename } from 'node:path';
import { truncateToBudget as truncateGeneric } from '@mnmal-ai/context-render';
import { resolveAnchorHttp } from './anchor.js';
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
import { createProjectionAudit } from './projection-audit.js';
import { describeRecallArms } from './recall-arms.js';
import { buildScoredByType, RECALL_TYPES } from './recall-scoring.js';
import {
  buildRuleSessionContext,
  renderAgentRules,
  renderMemoryPointer,
  renderMustDigest,
  renderStructural,
  renderTodos,
  renderUnified
} from './render.js';
import { boostSalience, fetchRowVectors, toRefs, toShortIdVectors } from './rule-vectors.js';
import {
  buildOperatorDigest,
  buildSchemaDigest,
  fetchNamespaceSchema,
  renderSchemaDigest
} from './schema-digest.js';
import { projectWhere } from './scope.js';
import { loadConcepts, renderConcepts } from './scoring/concepts.js';
import {
  DEFAULT_RECENCY_FLOOR,
  DEFAULT_TOP_K,
  parseImportanceWeights
} from './scoring/memory-scorer.js';
import { rankWithRRF } from './scoring/ranker.js';
import { renderSessionBlock } from './session.js';
import { probeEmbedStats, substrateQuery } from './substrate-http.js';

function numEnv(name, fallback) {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// Safe JSON env parse — malformed JSON falls back rather than throwing
// (a throw in a destructuring default would escape runColdStart's try/catch).
function parseJsonEnv(raw, fallback) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

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
 * The cortext type an anchor row lives in.
 *
 * `resolveAnchorHttp` reports its provenance as `source`, and the embeddings
 * route addresses rows by (namespace, type, id) — so the vector fetch needs the
 * type name, not the provenance label. Defaults to SessionLog, matching the
 * same fallback `renderUnified` already uses for a forward/back-compat anchor.
 */
function anchorTypeOf(anchor) {
  return (anchor?.source ?? 'sessionlog') === 'intent' ? 'AnchorIntent' : 'SessionLog';
}

function toFlatRows(rows) {
  return rows.map((r) => {
    const { _metadata, ...f } = r;
    return { ...f, updatedAt: _metadata?.updatedAt ?? f.updatedAt ?? null };
  });
}

// Above this size a cold-start payload stops being something a reader takes in
// whole. The harness persists a large hook payload to a file and surfaces a
// preview of roughly 2 KB — a payload near 100 KB is common — so everything past the cut is present, addressable, and unread.
//
// 8 KB is chosen to sit well above a healthy payload (Inbox + Concepts + Open
// Work + Write contract together measured 8,102 B, and that is the whole
// document once Memory is folded) and well below the size at which truncation
// actually bites. A manifest that renders on every cold start would be one more
// thing to skip.
const MANIFEST_THRESHOLD_BYTES = 8000;

/**
 * A compact index of what the payload contains, prepended when the payload is
 * large enough to be truncated or persisted.
 *
 * ## Why an index rather than a smaller payload
 *
 * Ordering by consequence-of-missing puts the binding content first, which is
 * necessary and not sufficient: a `must` block can run past 30 KB, because
 * rules carry structured `<trigger>/<must>/<must-not>` bodies. It does not fit
 * in a 2 KB preview and cannot be made to without gutting the rules, so
 * reordering alone would move the cliff rather than remove it.
 *
 * What DOES fit in a preview is a few hundred bytes saying what exists and that
 * the reader has not seen it. Applied to this document: absence must not be mistakable for "nothing there".
 *
 * @param {ReadonlyArray<string>} sections Rendered sections, in placement order.
 * @param {string} body The joined document.
 * @returns {string} '' when the payload is small enough to read whole.
 */
export function renderManifest(sections, body) {
  if (body.length < MANIFEST_THRESHOLD_BYTES) return '';
  const rows = sections.map((sec) => {
    const heading = (sec.split('\n', 1)[0] ?? '').replace(/^#+\s*/, '').trim();
    const kb = (sec.length / 1024).toFixed(1);
    return `  ${kb.padStart(6)} KB  ${heading || '(untitled section)'}`;
  });
  return (
    `> **This cold-start is ${(body.length / 1024).toFixed(1)} KB — larger than your ` +
    'harness is likely to show inline.** If you are looking at a truncated ' +
    'preview, the sections below the cut are PRESENT AND UNREAD, not empty. ' +
    'Read the full hook output before acting — binding rules lead the document ' +
    'precisely so a partial read still reaches them.\n>\n' +
    `> \`\`\`\n${rows.map((r) => `> ${r}`).join('\n')}\n> \`\`\`\n\n`
  );
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
  'are PRESENT, not empty -- pull them with query (cortext/AgentRule ' +
  'for rules, cortext/Memory for memory, cortext/Todo for open work) -->\n';

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
    topK = numEnv('MEMORY_TOTAL_TOPK', DEFAULT_TOP_K),
    rrfK = numEnv('MEMORY_RRF_K', 60),
    minFloors = parseJsonEnv(process.env.MEMORY_MIN_FLOORS, {
      Memory: 2,
      SessionLog: 1,
      Decision: 2
    }),
    importanceWeights = parseImportanceWeights(process.env.MEMORY_IMPORTANCE_WEIGHTS ?? null),
    recencyFloor = numEnv('MEMORY_RECENCY_FLOOR', DEFAULT_RECENCY_FLOOR),
    // ON BY DEFAULT. `RULE_SALIENCE=off`
    // is the escape hatch; the flag inverted rather than being deleted because
    // a ranking that degrades rule visibility needs a switch someone can reach
    // without a release.
    //
    // The gate is "the promoted set is CONSISTENTLY better than the dropped
    // set", judged by sweeping anchors against a fixed rule set. It is a
    // judgement call, not a proof: topic adjacency can still promote a rule
    // for a session it does not fit.
    //
    // Beyond the ranking, it makes `boostSalience` fire, so AgentRule
    // salience accumulates.
    ruleSalience = process.env.RULE_SALIENCE !== 'off',
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
    authWarning = null,
    // `pointer` renders how to recall memory; `full` preloads it.
    memoryMode = env.SYNOPTIC_COLD_START_MEMORY === 'full' ? 'full' : 'pointer',
    // `headline` renders salient should-rules as one line each; `full` renders their bodies.
    salientMode = env.SYNOPTIC_COLD_START_SALIENT === 'full' ? 'full' : 'headline'
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
    // Named slots rather than push-as-you-go. The sections are BUILT in
    // fetch order — the rules arrive in the same round-trip as Open Work, near
    // the end — but they are PLACED by consequence-of-missing. Keeping the two
    // orders separate is the whole fix; a single `sections.push()` array
    // silently welds them together, which is how the binding content ended up
    // 57,053 bytes into a 98,646-byte payload.
    let inboxMd = '';
    let sessionMd = '';
    let mustRulesMd = '';
    let mustDigestMd = '';
    let conceptsMd = '';
    let memoryMd = '';
    let shouldRulesMd = '';
    let todosMd = '';
    let schemaMd = '';

    // ---- FETCH PHASE ----
    //
    // FIVE INDEPENDENT ROOTS, launched together. Run as a staircase — each
    // `await` starting only when the last finished — they would add ~145ms of
    // latency to a hook whose entire JS is ~20ms, and start the ~340ms recall
    // fan-out, the longest pole, last.
    //
    //     inbox   ─────────────────────────────────► inboxMd
    //     concepts ────────────────────────────────► conceptsMd
    //     anchor  ──┬─► buildScoredByType ─────────► memoryMd   (the long pole)
    //               └─► fetchRowVectors(anchor) ─┐
    //     openWork ─┬─► fetchRowVectors(rules) ──┴─► ruleVectors
    //               └─────────────────────────────► todos, rules
    //     schema  ─────────────────────────────────► schemaMd
    //
    // Nothing here reorders the RENDER. Fetch order is separate from placement
    // order — sections are named slots filled in any order and placed
    // by consequence-of-missing — and that separation is exactly what makes
    // this safe. `cold-start-order.test.js` pins placement and is untouched.
    //
    // ERROR ISOLATION IS PRESERVED PER ROOT, and it is not uniform:
    //   inbox / concepts / schema  swallow and degrade — they never reject, so
    //                              they cannot take down a sibling
    //   anchor / openWork          propagate to the outer catch, which renders
    //                              the offline comment. That is deliberate: a
    //                              server that cannot answer these has nothing
    //                              useful to say, and the old code let them
    //                              throw for the same reason.
    // Every promise created here is awaited in the settle below, so a rejecting
    // root can never surface as an unhandled rejection.
    const inboxP = (async () => {
      // Failure degrades to a terse comment rather than blacking out the
      // session (mirrors the concepts hiccup-isolation); no kid / no directory
      // row / empty inbox render nothing.
      //
      // Internally still two SERIAL calls, and correctly so: `recipient` is a
      // crossRef taking the AgentIdentity row's UUID, so the mail query cannot
      // be built until the identity resolves. That is the one genuine
      // dependency in the old staircase; the rest were accidents of `await`.
      try {
        const messages = await loadInbox({ substrateUrl, namespace, agentKid, fetchImpl });
        return renderInbox(messages ?? [], { ns: namespace, kid: agentKid });
      } catch (err) {
        return `<!-- inbox unavailable: ${String(err?.message ?? err)} -->`;
      }
    })();

    // loadConcepts returns [] on non-2xx but throws on network/timeout — so a
    // concepts-only hiccup must not black out the rest of the cold-start. A
    // genuinely-down server is still caught by the outer handler, because the
    // anchor and open-work roots below do propagate.
    const conceptsP = (async () => {
      try {
        return await loadConcepts({ substrateUrl, projectSlug, namespace, fetchImpl });
      } catch {
        return [];
      }
    })();

    const anchorP = resolveAnchorHttp({
      substrateUrl,
      namespace,
      projectSlug,
      fetchImpl,
      onUnexpectedProjection: (entries) => projectionAudit.record(entries),
      onFrameFailure: (k, d) => projectionAudit.recordFailure(k, d)
    });

    // Open Work + Agent Rules — one round-trip, two frame keys. Already batched;
    // what changed is that it no longer waits for the memory section.
    const openWorkP = substrateQuery(
      substrateUrl,
      {
        [`${namespace}/Todo`]: {
          params: {
            where: { ...projectWhere(projectSlug), status: { nin: ['done', 'closed'] } },
            limit: 50
          },
          fields: {
            shortId: true,
            title: true,
            status: true,
            priority: true,
            area: true,
            // The fields that turn an inventory into an assignment.
            // Projected here rather than fetched later because they arrive
            // free in a frame already being read.
            owner: true,
            revisitWhen: true,
            blockedBy: true
          }
        },
        // Resolve THIS session's AgentIdentity row in the same batch. `owner`
        // is a crossRef holding a UUID, so "is this mine" is unanswerable from
        // the Todo alone — and the inbox's copy of this lookup cannot be
        // reused without serialising open-work behind it, which is the
        // `await` staircase a previous fix removed. A third frame key in an
        // already-batched query costs no extra round-trip.
        ...(agentKid
          ? {
              [`${namespace}/AgentIdentity`]: {
                params: { where: { kid: { eq: agentKid } }, limit: 1 },
                fields: { id: true }
              }
            }
          : {}),
        [`${namespace}/AgentRule`]: {
          params: { where: { ...projectWhere(projectSlug), active: { eq: true } }, limit: 200 },
          fields: {
            // `id`: recall/fetchEmbeddings and recall/boost both
            // address rows by UUID. shortId is the ranker's key and is
            // display-only on the wire, so both are needed.
            id: true,
            shortId: true,
            rule: true,
            category: true,
            severity: true,
            rationale: true,
            pinned: true,
            synopsis: true
          }
        }
      },
      {
        fetchImpl,
        onUnexpectedProjection: (entries) => projectionAudit.record(entries),
        onFrameFailure: (k, d) => projectionAudit.recordFailure(k, d)
      }
    );

    // 5. Write contract. Isolated like concepts — a schema fetch that
    // fails costs the digest and nothing else, because the whole point is to
    // save round-trips, never to add a failure mode to a view that has to
    // survive a degraded server. It is placed LAST in the render (ambient
    // reference, not news); fetching it first costs nothing.
    const schemaP = (async () => {
      try {
        return await fetchNamespaceSchema(substrateUrl, namespace, {
          fetchImpl,
          // An AUTH refusal is loud: substrate gates /substrate/v1/schema* behind
          // a read key, so a missing or rejected credential would otherwise
          // drop this section without a word. A 404 stays silent — that is
          // an older server without the route, and costs nothing by design.
          onRefused: (status) => {
            if (status !== 401 && status !== 403) return;
            projectionAudit.recordFailure(
              `GET /substrate/v1/schema/${namespace}`,
              `HTTP ${status}, so the Write contract is missing — the schema route needs a read key, so check SUBSTRATE_AGENT_KEY_ID / SUBSTRATE_AGENT_KEY_PATH and \`whoami\``
            );
          }
        });
      } catch {
        return null; /* digest is best-effort */
      }
    })();

    // ---- DEPENDENTS: each starts the moment its own root lands ----

    // Agent Memory. The pointer makes no memory reads; `full` runs the recall
    // fan-out below.
    const memoryP =
      memoryMode === 'full'
        ? fullMemory()
        : anchorP.then((anchor) => renderMemoryPointer({ anchor, projectSlug, ns: namespace }));

    // The preloaded section, kept behind SYNOPTIC_COLD_START_MEMORY=full as the
    // rollback. Anchor → recall (hybrid) or structural fallback, chained off
    // `anchorP` so the recall fan-out starts as soon as the anchor resolves.
    function fullMemory() {
      // Which retrieval arms are wired. Best-effort and fire-and-forget:
      // it starts here so it overlaps the recall fan-out, and `probeEmbedStats`
      // already reports an unreadable probe as `reachable: false` rather than as
      // an arm that is off, so a dead route costs the header's precision and
      // nothing else. It must never gate the render — a cold-start that fails
      // because an instrument failed is worse than the overclaim it replaced.
      const armsP = probeEmbedStats(substrateUrl, { fetchImpl })
        .then((stats) => describeRecallArms({ stats, namespace, types: RECALL_TYPES }))
        .catch(() => describeRecallArms({ stats: null, namespace, types: RECALL_TYPES }));

      return anchorP
        .then(async (anchor) => {
          if (anchor) {
            const { byType, recallAvailable, scopeDrops } = await buildScoredByType({
              substrateUrl,
              namespace,
              projectSlug,
              anchorText: anchor.text,
              nowMs,
              importanceWeights,
              recencyFloor,
              k: rrfK,
              fetchImpl,
              projectionAudit
            });
            if (recallAvailable) {
              const ranked = rankWithRRF(byType, { k: rrfK, totalK: topK, minFloors });
              return renderUnified({
                result: { mode: 'hybrid', anchor, byType },
                ranked,
                ns: namespace,
                projectSlug,
                k: rrfK,
                arms: await armsP,
                scopeDrops
              });
            }
            // Recall was ASKED and could not answer. `armsP` resolved independently
            // of which branch wins, so this path gets the same disclosure the
            // fused one does: this is the branch that exists because recall
            // failed.
            return renderStructural({
              rows: byType.Memory.map((e) => e.row.body),
              projectSlug,
              topK,
              baseline: recencyFloor,
              importanceWeights,
              ns: namespace,
              recallState: 'unavailable',
              arms: await armsP
            });
          }
          const data = await substrateQuery(
            substrateUrl,
            {
              [`${namespace}/Memory`]: {
                params: {
                  where: projectWhere(projectSlug),
                  limit: 200,
                  orderBy: [{ updatedAt: 'desc' }]
                },
                fields: {
                  id: true,
                  name: true,
                  type: true,
                  description: true,
                  body: true,
                  _metadata: true
                }
              }
            },
            {
              fetchImpl,
              onUnexpectedProjection: (entries) => projectionAudit.record(entries),
              onFrameFailure: (k, d) => projectionAudit.recordFailure(k, d)
            }
          );
          // Nothing was asked: there is no anchor to search from. A different fact
          // from `unavailable`, and the reader needs to know which.
          return renderStructural({
            rows: toFlatRows(data[`${namespace}/Memory`] ?? []),
            projectSlug,
            topK,
            baseline: recencyFloor,
            importanceWeights,
            ns: namespace,
            recallState: 'not-attempted',
            arms: await armsP
          });
        })
        .catch(async (err) => {
          // Memory is recoverable context. Its candidate reads are the
          // heaviest in the document, so they are the likeliest to time out, and
          // letting one reject the barrier below threw away the inbox, the must
          // rules and Open Work with it. An ANCHOR failure still fails the
          // document: it rejects the barrier through anchorP itself.
          await anchorP;
          return `<!-- agent memory unavailable: ${String(err?.message ?? err)} -->`;
        });
    }

    // Semantic rule ranking. Needs BOTH roots — the anchor's
    // vector and the rules' — so it joins them rather than waiting on the
    // memory render, which it never depended on.
    //
    // Fetched only when the salient tier is actually rendering. Two extra HTTP
    // calls on a path that must stay fast are not worth paying for a ranking
    // nobody is looking at, and the classic render ignores vectors entirely.
    //
    // Both calls go over FRAME dispatch. The kernel routes 401 this
    // hook's signed token, so until that fix ships every session silently took
    // the structural short-circuit this block exists to prevent — the branch
    // was wired and unreachable. Frame failures reach the projection audit
    // rather than vanishing into the swallow-and-degrade path.
    const vectorsP = Promise.all([anchorP, openWorkP]).then(async ([anchor, owData]) => {
      if (!ruleSalience || anchor === null || anchor === undefined) {
        return { anchorVector: null, ruleVectors: null };
      }
      const rules = owData[`${namespace}/AgentRule`] ?? [];
      const [anchorVecs, ruleVecs] = await Promise.all([
        fetchRowVectors(substrateUrl, toRefs([anchor], namespace, anchorTypeOf(anchor)), {
          fetchImpl,
          onFrameFailure: (k, d) => projectionAudit.recordFailure(k, d)
        }),
        fetchRowVectors(substrateUrl, toRefs(rules, namespace, 'AgentRule'), {
          fetchImpl,
          onFrameFailure: (k, d) => projectionAudit.recordFailure(k, d)
        })
      ]);
      return {
        anchorVector: anchorVecs.get(anchor.id) ?? null,
        ruleVectors: toShortIdVectors(rules, ruleVecs)
      };
    });

    // One barrier. Rejection semantics match the old serial code: the isolated
    // roots resolve regardless, and anchor/openWork reject into the outer catch.
    const [concepts, anchor, owData, schema, resolvedMemoryMd, { anchorVector, ruleVectors }] =
      await Promise.all([conceptsP, anchorP, openWorkP, schemaP, memoryP, vectorsP]);

    inboxMd = await inboxP;
    conceptsMd = renderConcepts(concepts);
    memoryMd = resolvedMemoryMd;
    schemaMd =
      schema === null
        ? ''
        : renderSchemaDigest(buildSchemaDigest(schema), {
            ns: namespace,
            operators: buildOperatorDigest(schema)
          });

    // 0b. Who this session is. A local fact, needing no server, and it
    // governs WRITES — so it must be read before the session starts writing.
    sessionMd = renderSessionBlock({ sessionId, kid: agentKid ?? null });

    // ---- RENDER PHASE ----
    const todos = owData[`${namespace}/Todo`] ?? [];
    const rules = owData[`${namespace}/AgentRule`] ?? [];

    // Rules render in TWO pieces that land in different places.
    //
    // `must` is binding: missing one produces a violation the agent does not
    // notice committing, so it is placed directly after the Inbox, ahead of
    // everything that degrades gracefully. `should` is advisory and keeps its
    // original position after Agent Memory.
    //
    // Salience ranking is passed only to the `should` half. Ranking a binding
    // rule out of view is precisely the failure being fixed, so `must` is never
    // eligible for it — see renderAgentRules.
    const sessionContext = buildRuleSessionContext(todos);
    mustRulesMd = renderAgentRules(rules, { only: 'must', ns: namespace });
    mustDigestMd = renderMustDigest(
      rules.filter((r) => r?.severity === 'must'),
      namespace
    );

    /** @type {Array<{id?: string}>} */
    let promoted = [];
    shouldRulesMd = renderAgentRules(rules, {
      only: 'should',
      salience: ruleSalience,
      sessionContext,
      ns: namespace,
      anchorVector,
      ruleVectors,
      salientMode,
      onPromoted: (rows) => {
        promoted = rows;
      }
    });
    todosMd = renderTodos(todos, {
      myIdentityId: (owData[`${namespace}/AgentIdentity`] ?? [])[0]?.id ?? null
    });

    // Salience write-back. Fires only when the salient tier ran,
    // and only for rules that were PROMOTED rather than merely considered.
    //
    // TWO HONEST LIMITS, both worth knowing before trusting this:
    //   - the confirmation is intent, not observation. The server reports
    //     `applied` and `missing[]`, so a boost is no longer unconfirmable —
    //     but the store write is fire-and-forget, so `applied: N` returns
    //     before the write lands. Better than `requested`, short of observed.
    //   - it changes NO RANKING yet. substrate's recall blend defaults its salience
    //     weight to 0 and `rankRules` has no salience term, so this accumulates
    //     a signal for a reader that does not exist yet. That is deliberate (write
    //     before read), but wiring the write without the read is
    //     a no-op that looks like progress, so it must not be reported as one.
    //
    // Never awaited into the render path in a way that can fail it: boostSalience
    // swallows its own errors and returns null.
    //
    // The HostInstall report, started before the reads, is awaited here so the
    // hook process does not exit mid-write.
    await Promise.all([
      ruleSalience && promoted.length > 0
        ? boostSalience(substrateUrl, toRefs(promoted, namespace, 'AgentRule'), {
            fetchImpl,
            onFrameFailure: (k, d) => projectionAudit.recordFailure(k, d)
          })
        : null,
      hostReportP
    ]);

    // PLACEMENT ORDER — by consequence-of-missing, not by document convention.
    //
    //   Inbox        a directed message is the most actionable wake-up signal
    //   must rules   binding; does not degrade when unread
    //   Concepts     recoverable context
    //   Memory       recoverable context
    //   should rules advisory
    //   Open Work    recoverable
    //   Write contract  ambient reference, never news
    const sections = [
      // The digest leads EVERYTHING, ahead of even the manifest. What
      // must survive a truncated render has to fit inside it; a manifest saying
      // the rules exist is a notice, and a notice is not a rule.
      mustDigestMd,
      inboxMd,
      sessionMd,
      mustRulesMd,
      conceptsMd,
      memoryMd,
      shouldRulesMd,
      todosMd,
      schemaMd
    ].filter((s) => s !== '' && s !== null && s !== undefined);

    const body = sections.join('\n\n');
    return `${warn}${projectionAudit.render()}${hostReportNote}${renderManifest(sections, body)}${body}\n`;
  } catch (err) {
    // The audit still renders on the failure path: a projection that stopped
    // matching the schema is a plausible CAUSE of the error, so suppressing it
    // here would hide the diagnostic exactly when it is most wanted.
    return `${warn}${projectionAudit.render()}<!-- substrate offline: ${String(err?.message ?? err)} -->\n`;
  }
}
