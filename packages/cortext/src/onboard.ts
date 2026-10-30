/**
 * Onboard route — returns a static JSON body describing the claude namespace
 * surface. Mounted at `/substrate/v1/plugins/cortext/onboard` (the router is already
 * prefixed by the server's `createPluginRouter`).
 *
 * Endpoint paths in the body:
 *   - Core query/mutate live at the unqualified `/substrate/v1/query` + `/substrate/v1/mutate`
 *     (§4.7). The namespace now rides inside the frame key (`<ns>/<name>`),
 *     not the URL.
 *   - Compact moves under the plugin prefix (`/substrate/v1/plugins/cortext/compact`).
 *   - WS endpoint still takes `namespace` as a companion field for agents
 *     that pre-bake their frame-key prefix.
 */

import type { PluginRouteContext, PluginRouter, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import { JSON_HEADERS } from '@mnmal-ai/substrate/sdk';
import {
  TODO_LIFECYCLE_VOCAB,
  TODO_PRIORITY_VOCAB,
  TODO_RESOLUTION_VOCAB
} from './kernel/index.js';
import {
  AGENT_MESSAGE_STATUS_VOCAB,
  AGENT_RULE_CATEGORY_VOCAB,
  AGENT_RULE_SEVERITY_ALIASES,
  AGENT_RULE_SEVERITY_VOCAB,
  CLAUDE_TYPE_NAMES,
  DECISION_STATUS_ALIASES,
  DECISION_STATUS_VOCAB,
  HOST_INSTALL_CHECK_STATES,
  HOST_INSTALL_FRAGMENT_STATES,
  TASK_STATUS_VOCAB,
  TODO_STATUS_ALIASES
} from './namespace.js';

/**
 * Render a controlled vocabulary as the agent-facing union string the onboard
 * surface uses (e.g. `'open' | 'done'`). Sourced from the kernel's exported
 * vocab constants so this description can't drift from the `field.enum` + pg
 * CHECK that actually enforce it.
 */
function vocabUnion(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(' | ');
}

/** Render an alias table as `'a' → 'b', …` for the onboarding contract. */
function aliasList(aliases: Readonly<Record<string, string>>): string {
  return Object.entries(aliases)
    .map(([alias, canonical]) => `'${alias}' → '${canonical}'`)
    .join(', ');
}

interface OnboardBody {
  plugin: string;
  namespace: string;
  description: string;
  retention: number;
  types: Record<string, OnboardType>;
  mutations: Record<string, Array<string>>;
  endpoints: {
    query: { method: string; path: string };
    mutate: { method: string; path: string };
    compact: { method: string; path: string };
    ws: { path: string; namespace: string };
  };
  contextLoading: {
    onSessionStart: {
      description: string;
      query: Record<string, { params: Record<string, unknown>; fields: Record<string, true> }>;
      surfaceToUser: Array<string>;
    };
  };
  compaction: {
    description: string;
    default: { retention: number; route: string };
    dryRun: { body: { dryRun: true }; description: string };
  };
}

interface OnboardType {
  purpose: string;
  /**
   * Per-field agent-facing description. Field kind / nullability / indexed
   * status are NOT restated here — those are authoritative on the FieldDef
   * registry and surfaced via `/substrate/v1/schema`. This map carries only the
   * human-meaningful intent (vocabulary lists, crossRef semantics, "not
   * indexed" hints that affect query shape, etc.) that the FieldDef itself
   * can't express.
   */
  fields: Record<string, string>;
  writeWhen: Array<string>;
}

/**
 * The AgentMessage write surface is its custom mutation family, NOT autoCRUD:
 * the type declares `autoCrud: false`, so `createAgentMessage` is never
 * registered and the schema never advertises it (sendAgentMessage is the only
 * send path, with kid addressing + '*' fan-out), and status transitions go
 * through markAgentMessageRead / ackAgentMessage exclusively. updateAgentMessage survives for
 * non-transition fields (tags, archived); deleteAgentMessage is standard.
 */
const AGENT_MESSAGE_MUTATIONS = [
  'sendAgentMessage',
  'markAgentMessageRead',
  'ackAgentMessage',
  'updateAgentMessage',
  'deleteAgentMessage'
];

/**
 * Derived from CLAUDE_TYPE_NAMES so a newly registered type cannot be
 * silently missing from the advertised mutation surface — the same
 * drift-proofing move vocabUnion makes for vocabularies.
 */
function buildMutations(): Record<string, Array<string>> {
  const mutations: Record<string, Array<string>> = {};
  for (const typeName of CLAUDE_TYPE_NAMES) {
    mutations[typeName] =
      typeName === 'AgentMessage'
        ? AGENT_MESSAGE_MUTATIONS
        : [`create${typeName}`, `update${typeName}`, `delete${typeName}`];
  }
  return mutations;
}

function buildBody(namespace: string, retention: number): OnboardBody {
  return {
    plugin: 'cortext',
    namespace,
    description: 'Persistent context store for Claude Code sessions',
    retention,
    types: {
      SessionLog: {
        purpose: 'One entry per development session or stable milestone',
        fields: {
          id: 'auto-generated',
          branch: 'git branch name',
          startedAt: 'ISO 8601 UTC datetime',
          summary: 'one-paragraph session summary (not indexed)',
          decisionsCount: 'count of decisions made this session',
          packages: 'comma-separated list of packages touched',
          archived: 'true if compacted'
        },
        writeWhen: [
          'At each stable milestone (PR merged, feature complete, significant fix)',
          'Not just at session end — a dropped session should lose at most one milestone'
        ]
      },
      Decision: {
        purpose: 'Architectural and design choices worth preserving across sessions',
        fields: {
          id: 'auto-generated',
          topic: 'short topic label',
          choice: 'what was decided',
          rationale: 'why (not indexed)',
          sessionId: 'UUID crossRef to SessionLog, set_null on delete (nullable)',
          createdAt: 'ISO 8601 UTC datetime',
          supersedes: 'UUID crossRef to the Decision this replaces, set_null on delete (nullable)',
          // Not a union, for the same reason as AgentRule.category below:
          // status is a free string, and a union would tell an agent the set
          // is closed. Nor "in use": the constant is hand-maintained and says
          // nothing about the STORE, and counting distinct values would put a
          // scan on every onboard call. So the claim is what the constant supports.
          status: `open vocabulary, not enforced; states this vocabulary documents (not a reading of what is stored): ${DECISION_STATUS_VOCAB.join(', ')}; synonyms normalised by the server: ${aliasList(DECISION_STATUS_ALIASES)}`,
          revisitWhen: 'trigger condition for revisiting a deferred decision (not indexed)',
          archived: 'true if compacted'
        },
        writeWhen: ['Immediately when a decision is made — do not defer to session end']
      },
      Todo: {
        purpose: 'Tracked work items and deferred tasks',
        fields: {
          id: 'auto-generated',
          title: 'short description',
          // Free text by deliberate schema choice — describing it as a union
          // here would document an enforcement that doesn't exist.
          area: "free-text area/component label (e.g. 'substrate-core', 'infrastructure'); not schema-enforced",
          status: `${vocabUnion(TODO_LIFECYCLE_VOCAB)} (lifecycle only); closing words set the resolution too: ${aliasList(TODO_STATUS_ALIASES)}`,
          resolution: `${vocabUnion(TODO_RESOLUTION_VOCAB)} (nullable): why a closed Todo stopped`,
          priority: vocabUnion(TODO_PRIORITY_VOCAB),
          notes: 'additional detail (not indexed)',
          blockedBy: 'free-text description of the blocker (not indexed)',
          implementsDecision: 'UUID crossRef to Decision, set_null on delete (nullable)',
          createdAt: 'ISO 8601 UTC datetime',
          archived: 'true if compacted'
        },
        writeWhen: [
          'On creation — do not batch to session end',
          'Freely without asking — when a gap, improvement, or deferred item is identified'
        ]
      },
      AgentRule: {
        purpose: 'Operational rule for agent behaviour, loaded into context at session start',
        fields: {
          id: 'auto-generated',
          rule: 'full rule body (not indexed)',
          // Rendered as "in use: ..." rather than a union, because unlike the
          // other vocabularies here this one is ADVISORY — category is a free
          // string. Presenting it as `'a' | 'b'` would tell an agent the
          // set is closed.
          category: `open vocabulary; categories in use: ${AGENT_RULE_CATEGORY_VOCAB.join(', ')}`,
          severity: `${vocabUnion(AGENT_RULE_SEVERITY_VOCAB)} (nullable); synonyms normalised by the server: ${aliasList(AGENT_RULE_SEVERITY_ALIASES)}`,
          active: 'only active rules load at cold-start',
          pinned: 'always-on rules exempt from salience ranking; absent = unpinned (nullable)',
          synopsis: 'short retrieval-optimized summary; primary embedding source (nullable)',
          rationale: 'why the rule exists (not indexed)',
          expressesConcept: 'UUID crossRef to Concept, set_null on delete (nullable)',
          archived: 'true if retired'
        },
        writeWhen: [
          'When the user gives durable operational guidance — corrections and confirmed approaches alike'
        ]
      },
      CouncilSession: {
        purpose: 'One pressure-test deliberation: question, advisor synthesis, verdict',
        fields: {
          id: 'auto-generated',
          question: 'the decision under pressure-test (not indexed)',
          slug: 'short kebab-case handle',
          context: 'framing given to the advisors (not indexed)',
          options: 'candidate options considered (not indexed)',
          agreement: 'where the advisors agreed (not indexed)',
          disagreement: 'where the advisors split (not indexed)',
          blindSpots: 'risks no option addresses (not indexed)',
          verdict: 'final synthesis (not indexed)',
          verdictAlignment: 'how aligned the verdict is with advisor consensus',
          sessionLogId: 'UUID crossRef to SessionLog, set_null on delete (nullable)',
          date: 'ISO 8601 date of the deliberation'
        },
        writeWhen: [
          'At the end of a council/pressure-test run, with one CouncilAdvisor row per advisor'
        ]
      },
      CouncilAdvisor: {
        purpose: "One advisor's response within a CouncilSession",
        fields: {
          id: 'auto-generated',
          councilSessionId: 'UUID crossRef to CouncilSession, cascade on delete (nullable)',
          role: 'advisor persona / thinking style',
          response: 'full advisor response (not indexed)',
          recommendation: "the advisor's bottom-line recommendation (not indexed)"
        },
        writeWhen: [
          'Alongside its parent CouncilSession — an advisor row is meaningless without one'
        ]
      },
      Memory: {
        purpose: 'Persistent agent note that survives across conversations',
        fields: {
          id: 'auto-generated',
          name: 'canonical human label; deduped by convention, not schema',
          description: 'one-line hook shown in the session-start index',
          type: "category: 'user' | 'feedback' | 'project' | 'reference' (convention, not schema-enforced)",
          body: 'full memory body (not indexed)',
          synopsis: 'short retrieval-optimized compression; preferred embedding source (nullable)',
          archived: 'true if retired'
        },
        writeWhen: [
          'When a durable fact, preference, or lesson surfaces that the repo itself does not record'
        ]
      },
      AnchorIntent: {
        purpose: 'Topical anchor for hybrid recall — "what I am focused on right now"',
        fields: {
          id: 'auto-generated',
          synopsis: 'short intent summary (1-3 sentences); primary embedding source',
          body: 'optional long-form continuation (not indexed, nullable)',
          authoredBy: "provenance struct, starts with kind: 'user' | 'agent'",
          project: 'project scope; null = cross-project',
          archived: 'true if retired'
        },
        writeWhen: [
          'At session boot if the newest anchor is stale, and at any material focus shift',
          'The newest non-archived row in scope IS the current anchor — there is no active flag'
        ]
      },
      Concept: {
        purpose: 'Operational semantics of a domain entity — the conceptual layer above types',
        fields: {
          id: 'auto-generated',
          name: 'canonical human label; deduped by write-path convention',
          description: 'one-line hook for the cold-start frame',
          kind: "domain classifier (e.g. 'type', 'protocol', 'pattern', 'role', 'convention'); free text",
          body: 'full operational semantics (not indexed)',
          synopsis: 'short embedding-side compression (nullable)',
          archived: 'true if retired'
        },
        writeWhen: [
          'When operational semantics stabilise around an entity worth teaching future sessions'
        ]
      },
      ConceptLink: {
        purpose: 'Typed edge between two Concepts',
        fields: {
          id: 'auto-generated',
          fromConcept: 'UUID crossRef to the source Concept, cascade on delete',
          toConcept: 'UUID crossRef to the target Concept, cascade on delete',
          kind: "edge kind: 'depends_on' | 'specializes' | 'see_also' | 'extends' (convention, not schema-enforced)",
          note: 'optional free-text annotation (not indexed, nullable)'
        },
        writeWhen: ['When a relationship between concepts carries operational meaning']
      },
      Skill: {
        purpose: 'Reusable agent-behaviour definition (cross-project)',
        fields: {
          id: 'auto-generated',
          name: 'skill name referenced by disk-side pointer stubs',
          description: 'when to invoke',
          body: 'full skill body (not indexed)',
          version: 'skill version string',
          active: 'inactive skills are retired'
        },
        writeWhen: ['When authoring or revising a reusable agent behaviour']
      },
      AgentIdentity: {
        purpose:
          'Directory of registered agent identities — the social/discovery layer over _system/Key auth',
        fields: {
          id: 'auto-generated',
          kid: "wire identity (e.g. 'peer-claude@host-a'); matches a registered _system/Key kid by convention",
          project: 'repo basename; null = cross-cutting/fleet identity',
          host: 'machine hostname',
          displayName: 'optional human-friendly name (nullable)',
          description: 'optional blurb (not indexed, nullable)',
          active: 'retired/revoked identities flip false',
          broadcastEligible: "false = a to:'*' broadcast skips this identity",
          roaming:
            "true = works whichever repo it is sent into on its own host (no project); the fleet audit accepts it as any repo's HostInstall writer there"
        },
        writeWhen: [
          'On identity registration (normally via /substrate-setup or substrate-admin register)'
        ]
      },
      AgentMessage: {
        purpose: 'Durable agent-to-agent mail (1:1 + cohort fan-out)',
        fields: {
          id: 'auto-generated',
          recipient:
            'UUID crossRef to AgentIdentity, set_null on delete (nullable). Address by kid via sendAgentMessage; the sender is NOT a field — it is _metadata.createdBy, server-stamped from the signed principal',
          subject: 'message subject',
          body: 'message body (not indexed)',
          status: `${vocabUnion(AGENT_MESSAGE_STATUS_VOCAB)} — recipient-only lifecycle, transitioned via markAgentMessageRead / ackAgentMessage exclusively`,
          ackedBy: 'ack attribution kid, server-stamped by ackAgentMessage (nullable)',
          ackedAt: 'ack timestamp, server-stamped by ackAgentMessage (nullable)',
          inReplyTo:
            'UUID crossRef to the AgentMessage this replies to, set_null on delete (nullable)',
          archived:
            'true once compacted (acked mail past the retention window) or manually archived'
        },
        writeWhen: [
          "Send via sendAgentMessage with `to` as a kid list ('*' fans out to all active identities except the sender)",
          'Recipients mark lifecycle with markAgentMessageRead / ackAgentMessage'
        ]
      },
      HostInstall: {
        purpose:
          'What one host has installed for one repo under one harness, upserted by the cold-start each session; check refreshedAt before trusting it (fresh < 24h, quiet < 7d, stale beyond)',
        fields: {
          id: 'auto-generated',
          key: '`<host>/<project>/<harness>`, unique; the upsert key',
          host: 'normalised hostname (lowercase, domain dropped)',
          hostReported: 'raw hostname as the host reported it',
          project: 'repo basename',
          kid: 'the identity the repo signs as (nullable)',
          harness: 'claude-code | opencode | hook',
          pluginVersion: 'plugin version that served the session (nullable)',
          fragmentVersion: 'installed conventions fragment version (nullable)',
          fragmentDigest: 'installed conventions fragment digest (nullable)',
          fragmentState: `${vocabUnion(HOST_INSTALL_FRAGMENT_STATES)} — the cold-start's fragment drift verdict`,
          refreshedAt:
            'last cold-start report, written only by the cold-start; the liveness signal',
          pinState: `${vocabUnion(HOST_INSTALL_CHECK_STATES)} — marketplace pin vs the served plugin (nullable; claude-code only)`,
          pinNote: "the pin check's worst finding (nullable)",
          mcpJsonState: `${vocabUnion(HOST_INSTALL_CHECK_STATES)} — the repo's .mcp.json (nullable)`,
          mcpJsonNote: "the .mcp.json check's worst finding (nullable)",
          authorityState: `${vocabUnion(HOST_INSTALL_CHECK_STATES)} — whether the key works and its grant covers cortext (nullable)`,
          authorityNote: "the authority check's worst finding (nullable)",
          settingsState: `${vocabUnion(HOST_INSTALL_CHECK_STATES)} — settings.local.json parses and enables the MCP server (nullable)`,
          settingsNote: "the settings check's worst finding (nullable)",
          settingsEnv:
            'json — allowlisted non-secret switch values, plus whether the identity keys are set (nullable)'
        },
        writeWhen: [
          'Written by the cold-start of every session with an agent identity; agents read it, they do not write it'
        ]
      },
      Task: {
        purpose:
          'A unit of work in flight: the stable identity a fresh session resumes by after a reset, independent of session id. Not a backlog ticket; link one via `todo`',
        fields: {
          id: 'auto-generated',
          title: 'what the work is',
          status: `${vocabUnion(TASK_STATUS_VOCAB)} (default active)`,
          todo: 'UUID crossRef to the Todo this work implements, set_null on delete (nullable)',
          archived: 'true if retired',
          project: 'repo basename; null = cross-cutting'
        },
        writeWhen: [
          'When starting work that may outlive the context window',
          'Flip status to done when the work is finished, paused when set aside'
        ]
      },
      ExecutionCheckpoint: {
        purpose:
          "One acknowledged step of a Task: what was completed and the next action. The latest is the Task's highest revision",
        fields: {
          id: 'auto-generated',
          task: 'UUID crossRef to the Task, cascade on delete',
          revision:
            "one higher than the Task's latest; unique per Task, so a second write at the same revision is refused",
          completed: 'what this step finished (not indexed)',
          nextAction: 'the exact next operation (not indexed)',
          blockers: 'what stands in the way (not indexed, nullable)',
          refs: 'file paths, #shortIds, PR or commit references (nullable)',
          project: 'repo basename; null = cross-cutting'
        },
        writeWhen: [
          'After a completed subtask, a blocker, or before a reset; point at files and rows, never retell them',
          'Treat the step as done only once the write is acknowledged; on a refused revision, re-read the latest and retry'
        ]
      }
    },
    mutations: buildMutations(),
    endpoints: {
      query: { method: 'POST', path: '/substrate/v1/query' },
      mutate: { method: 'POST', path: '/substrate/v1/mutate' },
      compact: { method: 'POST', path: '/substrate/v1/plugins/cortext/compact' },
      ws: { path: '/substrate/v1/ws', namespace }
    },
    contextLoading: {
      onSessionStart: {
        description: 'Load recent context at the start of each session',
        query: {
          SessionLog: {
            params: {
              where: { archived: { eq: false } },
              orderBy: [{ createdAt: 'desc' }],
              limit: 3
            },
            fields: { id: true, branch: true, startedAt: true, summary: true, archived: true }
          },
          Decision: {
            params: {
              where: { archived: { eq: false } },
              orderBy: [{ createdAt: 'desc' }],
              limit: 80
            },
            fields: {
              id: true,
              topic: true,
              choice: true,
              rationale: true,
              sessionId: true,
              status: true,
              revisitWhen: true,
              archived: true
            }
          },
          Todo: {
            params: {
              where: {
                archived: { eq: false },
                status: { in: ['open', 'in_progress', 'blocked'] }
              },
              orderBy: [{ createdAt: 'desc' }],
              limit: 50
            },
            fields: {
              id: true,
              title: true,
              area: true,
              status: true,
              priority: true,
              notes: true,
              blockedBy: true,
              archived: true
            }
          }
        },
        surfaceToUser: [
          'The 3 most recent non-archived SessionLog entries',
          // Deliberately does NOT name a status set: cold-start selects
          // Decisions on `archived` alone, and a contract that states an
          // unimplemented filter teaches that the vocabulary is load-bearing.
          'Non-archived Decisions',
          "Todos with status 'open', 'in_progress' or 'blocked'",
          'Skip archived records silently'
        ]
      }
    },
    compaction: {
      description: 'Archives old sessions and their decisions, keeping the most recent N live',
      default: { retention, route: 'POST /substrate/v1/plugins/cortext/compact' },
      dryRun: { body: { dryRun: true }, description: 'Preview without committing' }
    }
  };
}

export function registerOnboardRoute(
  router: PluginRouter,
  _ctx: PluginRouteContext,
  retention: number,
  namespace: string
): void {
  const body = buildBody(namespace, retention);
  const serialised = Buffer.from(JSON.stringify(body), 'utf8');
  router.get('/onboard', (): SubstrateResponse => {
    return {
      status: 200,
      headers: JSON_HEADERS,
      body: serialised
    };
  });
}
