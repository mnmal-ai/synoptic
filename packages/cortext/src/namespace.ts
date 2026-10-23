/**
 * cortext namespace definition. Spec: §5.11, §6.1.
 *
 * The context-store types (SessionLog, Decision, Todo, AgentRule,
 * CouncilSession, CouncilAdvisor, Memory, AnchorIntent, Concept, ConceptLink,
 * Skill) on the `defineNamespace` helper, plus the agent-to-agent messaging
 * surface (AgentIdentity directory + AgentMessage mailbox). Notes:
 *   - There is no `{ upsert: true }` namespace option — `write` is upsert by
 *     default.
 *   - There is no per-type `deletable: true` — autoCRUD always installs
 *     `delete<T>`.
 *   - FK-shaped fields are first-class `field.crossRef` edges with explicit
 *     onDelete policies.
 *
 * Embeddable types declare `embed.source` metadata; substrate's recall plugin
 * walks this at compose time and chains an embedding postWrite per match.
 */

import type {
  EmbedSourceContext,
  FieldDef,
  NamespaceDefinition,
  RegistryEntryResolver
} from '@mnmal-ai/substrate/sdk';
import { defineNamespace, field, type TypeInput } from '@mnmal-ai/substrate/sdk';
import { CORTEXT_PROMOTED_COLUMNS } from './kernel/cortext-namespace.js';
import {
  AGENT_MESSAGE_STATUS_VOCAB,
  TODO_LIFECYCLE_VOCAB,
  TODO_PRIORITY_VOCAB,
  TODO_RESOLUTION_VOCAB
} from './kernel/index.js';
import { installMailboxMutations } from './mailbox.js';
import { CORTEXT_NL_RULINGS } from './nl-rulings.js';
import {
  identityCreateGuard,
  identitySelfOnly,
  operatorOnly,
  todoResolutionGuard
} from './participants.js';

/**
 * Decision lifecycle states this vocabulary DOCUMENTS. ADVISORY, not enforced,
 * like `AgentRule.category`. This is a list, not a census: nothing reconciles
 * it against the store, so it never claims what is "in use".
 *
 * A free string is the honest encoding of a taxonomy nobody designed. An enum
 * freezes it, and agents then either invent undeclared synonyms or pick the
 * nearest legal word. `open` names a decision recorded before it was made.
 *
 * Nothing branches on `status` today (cold-start projects and renders it), but
 * that is not the argument: `status` is a conventionally mechanical name, so a
 * future consumer is likely to branch on it.
 *
 * THE DIRECTION MATTERS. Widening cannot invalidate stored data; it only
 * surprises readers. Narrowing STRANDS rows — readable, not round-trippable,
 * and selectively so, since a partial update avoiding the field still succeeds
 * while a read-modify-write client gets `invalid_enum_value` on a row it never
 * touched. So re-adding `field.enum` here later is not a symmetric undo. Do
 * not do it.
 *
 * Add to this list when a genuinely NEW state earns its place; it feeds the
 * onboarding contract, so what is here is what an agent is taught. `accepted`
 * is deliberately an alias of `active` rather than a state of its own.
 */
export const DECISION_STATUS_VOCAB = ['open', 'active', 'superseded', 'deferred'] as const;

/**
 * Synonyms the server normalises on every write and filter. `field.vocab` with
 * `strict: false` is NOT the enum warned against above: unknown values are
 * still admitted, so nothing narrows and nothing strands. It only maps the
 * words agents reach for onto the state they mean. `proposed` is a decision
 * recorded before it was made, which is what `open` documents.
 */
export const DECISION_STATUS_ALIASES = {
  accepted: 'active',
  adopted: 'active',
  decided: 'active',
  proposed: 'open'
} as const;

/**
 * Words agents reach for when a Todo stops, mapped onto lifecycle + outcome.
 * Each closing word sets `status: closed` AND the resolution it
 * means, so `status: done` still works and now records WHY. A caller that
 * also sends a contradicting `resolution` is refused (`conflicting_implication`).
 */
export const TODO_STATUS_ALIASES = {
  done: 'closed',
  finished: 'closed',
  completed: 'closed',
  shipped: 'closed',
  cancelled: 'closed',
  dropped: 'closed',
  superseded: 'closed',
  not_started: 'open'
} as const;
export const TODO_STATUS_IMPLIES = {
  done: { resolution: 'completed' },
  finished: { resolution: 'completed' },
  completed: { resolution: 'completed' },
  shipped: { resolution: 'completed' },
  cancelled: { resolution: 'wont_do' },
  dropped: { resolution: 'wont_do' },
  superseded: { resolution: 'superseded' }
} as const;
export const TODO_RESOLUTION_ALIASES = {
  done: 'completed',
  shipped: 'completed',
  wontfix: 'wont_do',
  declined: 'wont_do',
  dup: 'duplicate',
  moot: 'obsolete'
} as const;

/**
 * AgentRule severity — CLOSED, unlike `category`. Cold-start branches on it:
 * `must` rules render in the binding brief. `high` and `medium` are aliases
 * rather than stranded values.
 */
export const AGENT_RULE_SEVERITY_VOCAB = ['must', 'should'] as const;
export const AGENT_RULE_SEVERITY_ALIASES = { high: 'must', medium: 'should' } as const;

/**
 * AgentRule categories. ADVISORY, not enforced.
 *
 * An enum here arrives narrower than the data and freezes the taxonomy. The
 * damage is not a write rejection anyone notices but SILENT SUBSTITUTION:
 * agents pick the nearest legal word and move on, and the taxonomy flattens
 * toward whatever is allowed. Nothing consumes `category` mechanically —
 * cold-start projects it and renders it, never groups or filters on it — and
 * `ArchitectureConcern.category` in this same file is a free string too.
 * Widening an enum would only move the wall to the next category.
 *
 * Add to this list when a genuinely new category earns its place; it feeds the
 * onboarding contract so agents see the real taxonomy. Do NOT re-add
 * `field.enum` over it.
 */
export const AGENT_RULE_CATEGORY_VOCAB = [
  'git',
  'testing',
  'style',
  'process',
  'tooling',
  'communication',
  'investigation',
  'migration-patterns',
  'permissions',
  'scope-discipline',
  'side-findings',
  'verification'
] as const;

/**
 * AgentMessage.status vocabulary single-sources from the kernel sibling
 * — the same constant drives both the field.enum guard here and
 * the kernel CHECK constraint, matching the TODO_*_VOCAB pattern. Re-exported
 * so this module's surface carries it.
 */
export { AGENT_MESSAGE_STATUS_VOCAB } from './kernel/index.js';

/**
 * HostInstall.fragmentState: the cold-start fragment drift check's own verdict,
 * plus `source` for the repo that ships the fragment.
 */
export const HOST_INSTALL_FRAGMENT_STATES = [
  'current',
  'stale',
  'missing',
  'undigested',
  'uncomparable',
  'source',
  'absent'
] as const;

/** HostInstall's per-check verdicts: the worst finding each check produced. */
export const HOST_INSTALL_CHECK_STATES = ['ok', 'warn', 'unknown'] as const;

const CONCEPT_NAME_TTL_MS = 60_000;

/** Long-form length past which `embed.source` appends the long form to the synopsis. */
const LONGFORM_EMBED_CHARS = 1200;

export function buildClaudeNamespace(ns: string): NamespaceDefinition {
  /**
   * Concept names are near-static (concepts evolve rarely) but `Decision.embed.source`
   * reads one on every Decision write — the most common write in this namespace —
   * purely to inline a string into the embedding text. Cache the
   * (conceptId → name) lookup with a short TTL: collapses repeated reads on the
   * write path; a renamed Concept re-embeds on the next Decision write past the TTL.
   *
   * The cache lives in this closure — not at module level — so each namespace
   * instance owns its cache lifecycle and `createCortextPlugin` stays the pure
   * factory index.ts claims: no state shared across engines or
   * surviving engine teardown in multi-engine processes.
   */
  const conceptNameCache = new Map<string, { name: string | null; expiresAt: number }>();

  async function resolveConceptName(
    ctx: EmbedSourceContext,
    conceptId: string
  ): Promise<string | null> {
    const now = Date.now();
    const hit = conceptNameCache.get(conceptId);
    if (hit !== undefined && hit.expiresAt > now) return hit.name;
    // Miss path — prune anything that has lapsed so the map stays bounded by
    // the live concept set rather than growing for the process lifetime.
    for (const [key, entry] of conceptNameCache) {
      if (entry.expiresAt <= now) conceptNameCache.delete(key);
    }
    const concept = await ctx.read(ns, 'Concept', { id: conceptId });
    const name = concept !== null && typeof concept.name === 'string' ? concept.name : null;
    conceptNameCache.set(conceptId, { name, expiresAt: now + CONCEPT_NAME_TTL_MS });
    return name;
  }

  /**
   * Embedding text for a synopsis-bearing row: the synopsis, followed by
   * `long` once `long` passes `LONGFORM_EMBED_CHARS`; `long` alone when there
   * is no synopsis. A long row's synopsis is a handle, not a summary (median
   * 10% of the long form), so embedding it alone leaves the body unreachable
   * by dense recall.
   */
  function embedText(synopsis: unknown, long: string): string {
    const syn = typeof synopsis === 'string' ? synopsis : '';
    if (syn === '') return long;
    return long.length > LONGFORM_EMBED_CHARS ? `${syn}\n\n${long}` : syn;
  }

  /**
   * Join the parts of a `lexical.source` into one indexable string.
   *
   * Empty parts are dropped rather than left as blank paragraphs, and an
   * all-empty result becomes `null` — the same un-indexable sentinel
   * `embed.source` uses, so a row with no long-form text is left out of the
   * index rather than entered at the empty string.
   */
  function lexicalText(...parts: Array<unknown>): string | null {
    const kept = parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
    return kept.length === 0 ? null : kept.join('\n\n');
  }

  const types: Record<string, TypeInput> = {
    SessionLog: {
      fields: {
        branch: field.string(),
        // ISO-8601 datetime — typed as date so the filter validator accepts
        // range ops (gt/gte/lt/lte/between) and the pg dataset's orderBy
        // casts to ::timestamptz for chronological sort instead of text-sort.
        startedAt: field.date(),
        summary: field.string({ indexed: false }),
        // Short retrieval handle authored at write-time; leads the embedding
        // text (see `embedText`).
        synopsis: field.string({ nullable: true }),
        decisionsCount: field.number(),
        packages: field.string(),
        // Optional long-form body (the short form lives in summary/synopsis).
        body: field.string({ nullable: true, indexed: false }),
        // Free-form categorization tags, e.g. ["pr-merged","code-review"].
        tags: field.list(field.string(), { nullable: true }),
        archived: field.boolean({ default: false }),
        // Project-scoping. Values are project names (e.g. 'substrate',
        // 'notes-app'); null = cross-project/platform-level. Rows without the
        // key filter as missing.
        project: field.string({ nullable: true })
      },
      embed: {
        source: (r) => embedText(r.synopsis, typeof r.summary === 'string' ? r.summary : '')
      },
      /**
       * The LEXICAL index takes the long form, where `embed` above takes the
       * handle. That asymmetry is the whole point of the arm: `embed.source`
       * is conventionally `synopsis || <long form>`, and a dense vector cannot
       * recover the proper nouns the synopsis drops — most synopses drop a
       * capitalised token that IS present in the long form.
       *
       * The synopsis is included ALONGSIDE the long form rather than replaced by
       * it. A rare token in a synopsis is worth finding too, and unlike vector
       * concatenation this is not dilution: a lexical index has no centroid to
       * pull off-target, so more text only adds reachable tokens and costs index
       * size.
       *
       * Note `lexical.source` takes `(row)` only — there is no `ctx`, so unlike
       * `embed.source` it cannot follow a crossRef to inline related text.
       */
      // `body` is included beside `summary`: it is long-form, unindexed prose
      // on the same row, and leaving it out would
      // keep exactly the tokens this arm exists to reach unreachable.
      lexical: {
        source: (r) => lexicalText(r.synopsis, r.summary, r.body)
      }
    },
    Decision: {
      fields: {
        topic: field.string(),
        choice: field.string(),
        rationale: field.string({ indexed: false }),
        sessionId: field.crossRef(ns, 'SessionLog', {
          nullable: true,
          onDelete: 'set_null'
        }),
        supersedes: field.crossRef(ns, 'Decision', {
          nullable: true,
          onDelete: 'set_null',
          // Same-type opt-in. Decision → Decision. The
          // scope filter in recall-route's expansion path passes same-type
          // neighbours through, so a query that lands one Decision in the
          // top-K can surface the other end of a supersedes link via
          // forward (newer → older) or backward (older ← newer) walk.
          spread: true
        }),
        // Non-strict vocabulary, NOT field.enum — see DECISION_STATUS_VOCAB for
        // why. Unknown states are still admitted; aliases are
        // canonicalised on write and in filters (DECISION_STATUS_ALIASES).
        //
        // The `default` closes a gap three separate guards share:
        // assertEnumValues skips fields ABSENT from `params`, the kernel's
        // CHECK constraints carry an explicit `OR <field> IS NULL` escape, and
        // `substrate check-enums` skips null on read. Without a default an
        // omitted key writes null into a non-nullable field. Existing nulls are
        // left alone: `null -> active` would invent a state never recorded.
        status: field.vocab(DECISION_STATUS_VOCAB, {
          aliases: DECISION_STATUS_ALIASES,
          strict: false,
          default: 'active'
        }),
        // Free-form categorization tags.
        tags: field.list(field.string(), { nullable: true }),
        revisitWhen: field.string({ nullable: true, indexed: false }),
        // Concept this decision establishes or modifies. Optional — most decisions
        // are pragmatic; key architectural ones bind to a Concept.
        establishesConcept: field.crossRef(ns, 'Concept', {
          nullable: true,
          onDelete: 'set_null',
          // Cross-type opt-in for backward walks. The
          // spec's named win case: a Concept-typed query walks inbound
          // `Decision.establishesConcept` edges and surfaces the
          // establishing Decisions. Forward Decision→Concept stays
          // scope-blocked, because spreading it regresses recall.
          spread: true,
          expandCrossType: true
        }),
        archived: field.boolean({ default: false }),
        project: field.string({ nullable: true })
      },
      embed: {
        // Inlines the linked Concept's name when establishesConcept is set
        // — semantic recall against a concept name (e.g. "salience") then
        // surfaces the Decisions that establish/modify it. Falls back to
        // topic+choice+rationale alone when no crossRef or no ctx.
        source: async (r, ctx) => {
          const topic = typeof r.topic === 'string' ? r.topic : '';
          const choice = typeof r.choice === 'string' ? r.choice : '';
          const rationale = typeof r.rationale === 'string' ? r.rationale : '';
          const base = `${topic}\n\n${choice}\n\n${rationale}`;
          if (ctx === undefined || typeof r.establishesConcept !== 'string') return base;
          const conceptName = await resolveConceptName(ctx, r.establishesConcept);
          return conceptName !== null ? `${base}\n\n[concept] ${conceptName}` : base;
        }
      },
      /**
       * Decision is the one type whose `embed.source` is ALREADY the long form,
       * so it gains least here — declared anyway, deliberately, so that "which
       * types are lexically indexed" has no per-type exception to remember.
       *
       * It is not a no-op: `embed.source` inlines the linked Concept's NAME via
       * `ctx.read`, and `lexical.source` gets no `ctx`, so the two texts differ
       * on any Decision carrying `establishesConcept`.
       */
      lexical: {
        source: (r) => lexicalText(r.topic, r.choice, r.rationale)
      }
    },
    Todo: {
      fields: {
        title: field.string(),
        area: field.string(),
        // Lifecycle only; the outcome lives in `resolution`.
        status: field.vocab(TODO_LIFECYCLE_VOCAB, {
          aliases: TODO_STATUS_ALIASES,
          implies: TODO_STATUS_IMPLIES
        }),
        // Why a closed Todo stopped. Set by the closing alias (`done` ->
        // completed) or explicitly; null while the Todo is live.
        resolution: field.vocab(TODO_RESOLUTION_VOCAB, {
          aliases: TODO_RESOLUTION_ALIASES,
          nullable: true
        }),
        priority: field.enum(TODO_PRIORITY_VOCAB),
        notes: field.string({ nullable: true, indexed: false }),
        blockedBy: field.string({ nullable: true, indexed: false }),
        // The condition in the world that would make this worth looking at
        // again — "embeddings crosses ~10k", "when a domain type wants
        // flat membership". Unindexed to match the two existing precedents
        // (Decision, ArchitectureConcern) and because it is prose for a reader
        // to evaluate, not a filter target.
        //
        // WHY IT EXISTS, measured rather than assumed. 26 open Todos carry a
        // `blockedBy`, and classifying what that prose actually SAYS gives:
        // ~22 conditions on WORLD STATE, 2 dependencies on another item, 1
        // human pause. So the dominant use of `blockedBy` was never "blocked
        // by X" at all — it was a gate, written in the only field available.
        // `revisitWhen` already existed on Decision and ArchitectureConcern
        // and not here, and two rows had recorded reaching for it
        // and finding a dead pointer. People were using the right concept on
        // the wrong type.
        //
        // Distinct from `blockedBy` deliberately: `blockedBy` should mean
        // another ITEM must land first, which a scheduler can resolve
        // structurally. `revisitWhen` cannot be resolved structurally by
        // anything — it needs a reader — and conflating the two is what makes
        // the existing corpus unschedulable.
        revisitWhen: field.string({ nullable: true, indexed: false }),
        // Optional long-form body (short notes live in `notes`).
        body: field.string({ nullable: true, indexed: false }),
        // Free-form categorization tags. Indexed — server-side
        // `where: { tags: { has: 'x' } }` is backed by the GIN in migration
        // 0022. The sibling types' tags stay unindexed (filter via
        // _allowTableScan or a future per-type GIN).
        tags: field.list(field.string(), { nullable: true, indexed: true }),
        archived: field.boolean({ default: false }),
        targetDate: field.date({ nullable: true }),
        // Decision this Todo implements / follows from. Optional — most Todos
        // are pragmatic; key ones trace to a Decision so the explorer Kanban
        // can surface the rationale alongside the work item.
        implementsDecision: field.crossRef(ns, 'Decision', {
          nullable: true,
          onDelete: 'set_null'
        }),
        // Which agent has taken this on. NULL MEANS UNCLAIMED, and that is the
        // useful state — "nobody is doing this" currently has no
        // representation at all, so a dropped item is indistinguishable from
        // one in progress and only the operator notices the difference.
        //
        // A crossRef rather than a string so it is filterable: the question a
        // dispatcher asks on every wake is "what is assigned to me", and that
        // has to be answerable server-side.
        //
        // REPO GRANULARITY IS CORRECT HERE, not a limitation to fix later.
        // AgentIdentity is one row per repo per host, so concurrent sessions
        // in one repo share an owner — which is right, because work belongs to
        // a repo and outlives any single session. Session-level attribution is
        // a different problem and deliberately not this field's job.
        //
        // Setting it is NOT an atomic claim: `updateTodo` is last-writer-wins,
        // so two agents setting `owner` on one unclaimed item both succeed and
        // the later write stands. Exclusive claims need a claim mutation built
        // on `ds.conditionalUpdate(…, { owner: null }, { owner: me })`, added
        // when something dispatches on this field.
        owner: field.crossRef(ns, 'AgentIdentity', {
          nullable: true,
          onDelete: 'set_null'
        }),
        project: field.string({ nullable: true })
      }
    },
    AgentRule: {
      fields: {
        rule: field.string({ indexed: false }),
        // Non-strict vocabulary, NOT field.enum — see AGENT_RULE_CATEGORY_VOCAB
        // for why. The schema advertises the taxonomy; it does not wall it.
        category: field.vocab(AGENT_RULE_CATEGORY_VOCAB, { strict: false }),
        severity: field.vocab(AGENT_RULE_SEVERITY_VOCAB, {
          aliases: AGENT_RULE_SEVERITY_ALIASES,
          nullable: true
        }),
        active: field.boolean(),
        // Always-on rules exempt from cold-start salience ranking — they render
        // in full every session regardless of relevance (safety boundaries +
        // every-turn surface rules). Nullable: pre-existing rows lack the key
        // and are treated as unpinned (false) by the cold-start renderer.
        pinned: field.boolean({ nullable: true }),
        // Short retrieval-optimized synopsis (~1 sentence). The primary
        // embedding source — a correctly-sized input keeps the 1024-dim bge-m3
        // vector well-resolved, where the full (often multi-paragraph XML) rule
        // body would smear it. Doubles as a sharper cold-start skim-line.
        // Nullable: pre-existing rows fall back to the rule body for embedding.
        synopsis: field.string({ nullable: true }),
        rationale: field.string({ indexed: false }),
        // Concept this rule expresses. Optional — most rules are pragmatic and
        // don't trace to a single concept; some do.
        expressesConcept: field.crossRef(ns, 'Concept', {
          nullable: true,
          onDelete: 'set_null'
        }),
        archived: field.boolean({ default: false }),
        project: field.string({ nullable: true })
      },
      embed: {
        // Category is folded in as a topical anchor.
        source: (r) => {
          const base = embedText(r.synopsis, typeof r.rule === 'string' ? r.rule : '');
          const cat =
            typeof r.category === 'string' && r.category.length > 0 ? ` [${r.category}]` : '';
          return `${base}${cat}`;
        }
      },
      /**
       * `rationale` is included beside `rule` on the same reasoning as
       * SessionLog.body: it is long-form unindexed
       * prose carrying proper nouns, and the no-dilution argument above means
       * including it costs only index size.
       *
       * `category` is deliberately NOT folded in the way `embed.source` folds
       * it. There it is a topical anchor that steers a vector; here it would
       * just be a token repeated across every rule in the category, which is
       * what a filter on the indexed `category` field already does better.
       */
      lexical: {
        source: (r) => lexicalText(r.synopsis, r.rule, r.rationale)
      }
    },
    CouncilSession: {
      fields: {
        question: field.string({ indexed: false }),
        slug: field.string(),
        context: field.string({ indexed: false }),
        options: field.string({ indexed: false }),
        agreement: field.string({ indexed: false }),
        disagreement: field.string({ indexed: false }),
        blindSpots: field.string({ indexed: false }),
        verdict: field.string({ indexed: false }),
        verdictAlignment: field.string(),
        sessionLogId: field.crossRef(ns, 'SessionLog', {
          nullable: true,
          onDelete: 'set_null'
        }),
        // Typed as date for the same reason as SessionLog.startedAt:
        // range ops validate and pg orderBy casts ::timestamptz instead of
        // text-sorting. Bare YYYY-MM-DD casts fine.
        date: field.date(),
        project: field.string({ nullable: true })
      }
    },
    CouncilAdvisor: {
      fields: {
        // Cascade — an advisor without its parent CouncilSession is meaningless.
        councilSessionId: field.crossRef(ns, 'CouncilSession', {
          nullable: true,
          onDelete: 'cascade'
        }),
        role: field.string(),
        response: field.string({ indexed: false }),
        recommendation: field.string({ indexed: false })
      }
    },
    Memory: {
      fields: {
        // Canonical human label for the memory. Not strictly unique at the
        // schema layer — migration and write paths dedupe by convention.
        name: field.string(),
        // One-line hook shown in the session-start index so the agent knows
        // WHAT the memory is without loading the body.
        description: field.string(),
        // Category from the auto-memory contract: user | feedback | project | reference.
        type: field.string(),
        // Free-form categorization tags.
        tags: field.list(field.string(), { nullable: true }),
        // Full memory body — same content as the markdown file body today.
        body: field.string({ indexed: false }),
        // Short retrieval handle authored at write-time; leads the embedding
        // text (see `embedText`).
        synopsis: field.string({ nullable: true }),
        archived: field.boolean({ default: false }),
        project: field.string({ nullable: true })
      },
      embed: {
        source: (r) => {
          const desc = typeof r.description === 'string' ? r.description : '';
          const body = typeof r.body === 'string' ? r.body : '';
          return embedText(r.synopsis, `${desc}\n\n${body}`);
        }
      },
      lexical: {
        source: (r) => lexicalText(r.synopsis, r.description, r.body)
      }
    },
    // Topical anchor — "current focus." NO `active` field on this type;
    // "current" = newest non-archived row in scope (project=current OR
    // project=null), ordered by created_at DESC. Canonical resolver lives in
    // the `cortext` plugin (cold-start anchor resolution). Downstream
    // consumers writing their own renderer must NOT filter by an imagined
    // `active: true` — kernel returns null for projected nonexistent
    // fields, so a strict-equality filter silently matches nothing.
    AnchorIntent: {
      fields: {
        // Short retrieval-optimized intent summary. 1-3 sentences,
        // ~200-600 chars. This is the primary embedding source — the
        // hook renderer + recall ranker both read it first. Follows the
        // SessionLog/Memory convention (synopsis = short, indexed/embedded; body = long,
        // optional). Empty synopsis is an authoring bug (graceful
        // degrade via cosine-of-zero-vector).
        synopsis: field.string(),
        // Optional long-form continuation. Holds the full intent when
        // a 1-3 sentence synopsis can't carry enough context. Not the
        // primary embedding source — the postWrite prefers `synopsis`
        // when present and only falls back to `body`. Renderers do the
        // same.
        body: field.string({ nullable: true, indexed: false }),
        // Provenance struct. Starts with `kind` ('user' | 'agent');
        // extends to modelId / subagentId / sessionLogId without
        // schema migration (struct interior grows additively). Not used
        // for resolution priority — most-recent wins.
        authoredBy: field.struct({
          kind: field.string()
        }),
        // Project scope. Resolution selects newest-first across
        // (project = current OR project IS NULL); project specificity
        // does not outrank recency.
        project: field.string({ nullable: true }),
        archived: field.boolean({ default: false })
      },
      embed: {
        source: (r) => embedText(r.synopsis, typeof r.body === 'string' ? r.body : '')
      },
      lexical: {
        source: (r) => lexicalText(r.synopsis, r.body)
      }
    },
    Concept: {
      fields: {
        // Canonical human label. Not strictly unique at the schema layer;
        // write-path convention dedupes by name (matches Memory).
        name: field.string(),
        // 1-line hook shown in the cold-start frame so the agent grasps the
        // concept without loading the body.
        description: field.string(),
        // Domain classifier — what kind of concept is this? Unconstrained at
        // the schema layer (field.string()); new kinds may be introduced
        // ad-hoc. Current vocabulary in use:
        //   'type'              operational semantics of a substrate type (AnchorIntent, ...)
        //   'protocol'          operational protocol (cold-start, when-to-write, ...)
        //   'pattern'           design pattern recurring in the codebase
        //   'role'              actor/role in the system (operator, agent, subagent)
        //   'convention'        established practice / catalog (e.g. pr-label-taxonomy)
        //   'reference'         primer / domain knowledge concept for future consultation
        //   'deferred-decision' a choice deliberately not made, awaiting trigger
        // The snapshot generator (scripts/concepts-snapshot.js) groups by this
        // field with a canonical KIND_ORDER. Unknown kinds get appended after.
        kind: field.string(),
        // Full body — operational semantics. Recalled on demand via query
        // or recall; NOT always-loaded at boot (only the projection is).
        body: field.string({ indexed: false }),
        // Free-form categorization tags.
        tags: field.list(field.string(), { nullable: true }),
        // Short retrieval handle authored at write-time; leads the embedding
        // text (see `embedText`).
        synopsis: field.string({ nullable: true }),
        archived: field.boolean({ default: false }),
        project: field.string({ nullable: true })
      },
      embed: {
        source: (r) => {
          const desc = typeof r.description === 'string' ? r.description : '';
          const body = typeof r.body === 'string' ? r.body : '';
          return embedText(r.synopsis, `${desc}\n\n${body}`);
        }
      },
      lexical: {
        source: (r) => lexicalText(r.synopsis, r.description, r.body)
      }
    },
    ConceptLink: {
      fields: {
        // Source endpoint. Cascade-delete the link when source is removed —
        // a link without an endpoint is meaningless.
        fromConcept: field.crossRef(ns, 'Concept', { onDelete: 'cascade' }),
        // Target endpoint. Same cascade reasoning.
        toConcept: field.crossRef(ns, 'Concept', { onDelete: 'cascade' }),
        // Edge kind — typed relationship between two concepts.
        //   'depends_on'   from depends on to (load-bearing precondition)
        //   'specializes'  from is a specialization of to
        //   'see_also'     informational pointer; weakest tie
        //   'extends'      from extends/refines to
        kind: field.string(),
        // Optional free-text annotation per link (e.g., "see the Decision
        // that derived this link").
        note: field.string({ nullable: true, indexed: false }),
        archived: field.boolean({ default: false }),
        project: field.string({ nullable: true })
      }
    },
    Skill: {
      fields: {
        name: field.string(),
        description: field.string(),
        body: field.string({ indexed: false }),
        version: field.string(),
        active: field.boolean()
      }
    },
    AgentIdentity: {
      fields: {
        // Wire identity, e.g. 'peer-claude@host-a'. Matches a registered
        // _system/Key kid by convention; the directory is the social /
        // discovery layer, the _system/Key is the auth layer (kept decoupled —
        // different namespaces, different lifecycles).
        kid: field.string(),
        // Repo basename (e.g. 'app'); null = cross-cutting/fleet identity
        // (claude-code@host-a).
        project: field.string({ nullable: true }),
        host: field.string(),
        displayName: field.string({ nullable: true }),
        description: field.string({ nullable: true, indexed: false }),
        // Retired/revoked identities flip false. Means "this row is not
        // retired" and NOTHING about whether anyone reads mail sent here —
        // see broadcastEligible.
        active: field.boolean({ default: true }),
        // Whether `to:'*'` should fan a copy out to this identity.
        //
        // Split from `active` because that flag was being asked to carry two
        // meanings — "not retired" and "mail sent here will be read" — and only
        // the second is what fan-out needs. The two acts that set it look
        // identical in the data and differ only in the operator's head:
        //
        //   DECOMMISSIONING — the host is gone, the identity can never read
        //     again. `active: false` is right.
        //   SILENCING — quiet but load-bearing, still the signing identity for
        //     repos that need the broadcast. `active: false` is WRONG, and
        //     invisibly so: it silently drops broadcasts for exactly the repos
        //     most likely to need them.
        //
        // The fleet default `claude-code@host-a` is the worked example: it is
        // what un-onboarded repos sign as, so it must stay `active: true`, but
        // nothing reads its inbox. It gets `broadcastEligible: false`.
        //
        // ABSENT MEANS ELIGIBLE, and that is load-bearing rather than lazy.
        // `default: true` applies on WRITE, so every AgentIdentity row that
        // predates this field has no such key — a `where` clause of
        // `broadcastEligible: { eq: true }` matches none of them, and `eq: null`
        // never matches anything under SQL three-valued logic, so filtering in
        // the query would turn every broadcast into `no_recipients`.
        // `resolveRecipients` filters in JS on `!== false` instead, which needs
        // no migration and cannot half-apply.
        broadcastEligible: field.boolean({ default: true }),
        // A ROAMING identity works whichever repo it is sent into on its own
        // host (a pinch hitter, an adversarial reviewer), so it carries no
        // `project`. The fleet audit accepts it as the writer of any repo's
        // HostInstall row on that host, and labels it as roaming. Distinct
        // from `project: null` alone, which means cross-cutting, not "works
        // any repo". Only an explicit `true` counts: rows that predate the
        // field have no value, and the same three-valued logic as above
        // applies to a `where` on it.
        roaming: field.boolean({ default: false })
      }
    },
    AgentMessage: {
      // The write surface is the mailbox mutation family, NOT autoCRUD: opting
      // out means createAgentMessage is never registered, so the published
      // schema cannot advertise a mutation the route only denies — a caller
      // reading the schema builds a shape that cannot work, and the refusal
      // looks like a grant problem. mailbox.ts hand-registers what remains
      // (type entry, get/update/delete) with mailboxWriteGuard composed over
      // it. See ./mailbox.ts.
      autoCrud: false,
      fields: {
        // Declared, not injected: autoCrud:false skips the engine's
        // RESERVED_AUTOCRUD_FIELDS augmentation, so the descriptor has to be
        // this type's own. Same def as the reserved constant.
        shortId: field.number({ indexed: true, readonly: true }),
        // Addressee. crossRef binds addressing to the directory (onDelete:set_null
        // keeps it consistent). Writers address by KID via sendAgentMessage,
        // which resolves to this row id; `recipient: null` is not written —
        // broadcasts fan out one row per active identity. The field stays
        // nullable for onDelete:set_null and older broadcast rows. The sender
        // is NOT a field — it is _metadata.createdBy, server-stamped from the
        // signed principal (non-repudiable; query "sent by X" via the
        // createdById filter).
        recipient: field.crossRef(ns, 'AgentIdentity', {
          nullable: true,
          onDelete: 'set_null'
        }),
        subject: field.string(),
        body: field.string({ indexed: false }),
        // Recipient-only lifecycle, transitioned via markAgentMessageRead /
        // ackAgentMessage exclusively (mailboxWriteGuard locks it out of
        // updateAgentMessage).
        status: field.enum(AGENT_MESSAGE_STATUS_VOCAB, { default: 'unread' }),
        // Ack attribution, stamped server-side by ackAgentMessage at
        // transition time. Dedicated fields because _metadata.updatedBy is
        // too coarse — any later row edit smudges it.
        ackedBy: field.string({ nullable: true }),
        ackedAt: field.date({ nullable: true, serverSet: 'both' }),
        // Light threading for the relay back-and-forth. spread:true so a
        // recalled message can surface its thread neighbour.
        inReplyTo: field.crossRef(ns, 'AgentMessage', {
          nullable: true,
          onDelete: 'set_null',
          spread: true
        }),
        tags: field.list(field.string(), { nullable: true }),
        // Which writer sent this, as the WRITER reports it: a session, daemon
        // or other process holding the kid. The kid is repo-scoped,
        // so two sessions in one repo, or a process holding the key, sign
        // identically and nothing else in the row tells them apart.
        // Client-supplied and unverifiable, like the `session:` tag it
        // replaces, but indexed, projectable and present by construction.
        // Set once at send; mailboxWriteGuard refuses it on update.
        instance: field.string({ nullable: true }),
        archived: field.boolean({ default: false })
      }
    },
    // What one host has installed for one repo. One row per (host, repo,
    // harness), upserted by that repo's cold-start on every session with an identity.
    // Readers compute staleness from refreshedAt, so a dead host does not read
    // as a quiet one.
    HostInstall: {
      fields: {
        // `${host}/${project}/${harness}`, the upsert key. Unique via kernel
        // migration 0008. Rows written by cortext 2.9.0 carry `${host}/${project}`.
        key: field.string(),
        // Normalised hostname: lowercase, domain dropped.
        host: field.string(),
        // The raw hostname, so casing drift stays visible without splitting rows.
        hostReported: field.string(),
        project: field.string(),
        kid: field.string({ nullable: true }),
        harness: field.string(),
        pluginVersion: field.string({ nullable: true }),
        fragmentVersion: field.string({ nullable: true }),
        fragmentDigest: field.string({ nullable: true }),
        fragmentState: field.enum(HOST_INSTALL_FRAGMENT_STATES),
        // Written ONLY by the cold-start. Not _metadata.updatedAt: an audit
        // enrichment writing to the same row would move that without the host
        // having started a session.
        refreshedAt: field.date(),
        // The cold-start's local checks, written with the rest of the row so
        // they are as fresh as refreshedAt. Each state is the worst finding of
        // its check; each note is that finding's text. Null on rows from
        // writers that predate them.
        pinState: field.enum(HOST_INSTALL_CHECK_STATES, { nullable: true }),
        pinNote: field.string({ nullable: true, indexed: false }),
        mcpJsonState: field.enum(HOST_INSTALL_CHECK_STATES, { nullable: true }),
        mcpJsonNote: field.string({ nullable: true, indexed: false }),
        authorityState: field.enum(HOST_INSTALL_CHECK_STATES, { nullable: true }),
        authorityNote: field.string({ nullable: true, indexed: false }),
        settingsState: field.enum(HOST_INSTALL_CHECK_STATES, { nullable: true }),
        settingsNote: field.string({ nullable: true, indexed: false }),
        // The effective values of an allowlist of non-secret switches, and
        // whether the identity keys are set; the fleet audit compares them
        // across hosts. Never a key path or any other env value.
        settingsEnv: field.json({ nullable: true })
      }
    }
    // ReviewSession + ReviewFinding live in the review plugin's review/* namespace.
  };

  const definition = defineNamespace(ns, types, {
    annotations: { nl: CORTEXT_NL_RULINGS },
    promotedColumns: CORTEXT_PROMOTED_COLUMNS
  });

  // Wrap the install so the mailbox owns AgentMessage's whole surface: the
  // type opts out of autoCRUD, so installMailboxMutations registers the type
  // entry, get/update/delete AND the custom family (sendAgentMessage,
  // markAgentMessageRead, ackAgentMessage) on one registry, with the plugin
  // policy composed the way defineNamespace composes it for autoCRUD types.
  // The AgentMessage field defs are threaded through so every resolver
  // validates against the one declared schema (mailbox.ts re-augments with
  // the reserved engine fields, which autoCrud:false skips injecting).
  const baseInstall = definition.install.bind(definition);
  return {
    ...definition,
    install(ctx): void {
      baseInstall(ctx);
      // `types` is optional on the interface but defineNamespace always
      // populates it — `!` per the internal-seam convention.
      installMailboxMutations(
        ctx,
        // biome-ignore lint/style/noNonNullAssertion: deliberate internal-seam assertion, see above
        definition.types!.AgentMessage!.fields as Record<string, FieldDef>
      );
      // AgentIdentity keeps its autoCRUD surface, but a create may not claim
      // another machine, an edit is the row's own kid's or an operator's, and
      // a delete is an operator's. Wrapped
      // in place, so params, returns and policy stay exactly what autoCRUD
      // registered.
      for (const [name, wrap] of [
        [
          'createAgentIdentity',
          (r: RegistryEntryResolver) => identityCreateGuard(ctx, 'createAgentIdentity', r)
        ],
        [
          'updateAgentIdentity',
          (r: RegistryEntryResolver) => identitySelfOnly(ctx, 'updateAgentIdentity', r)
        ],
        [
          'deleteAgentIdentity',
          (r: RegistryEntryResolver) => operatorOnly('deleteAgentIdentity', r)
        ],
        [
          'createTodo',
          (r: RegistryEntryResolver) =>
            todoResolutionGuard(ctx, 'createTodo', r, TODO_STATUS_ALIASES)
        ],
        [
          'updateTodo',
          (r: RegistryEntryResolver) =>
            todoResolutionGuard(ctx, 'updateTodo', r, TODO_STATUS_ALIASES)
        ]
      ] as const) {
        const entry = ctx.registry.get(name);
        if (entry === undefined) throw new Error(`cortext: autoCRUD did not register ${name}`);
        ctx.registry.replace(name, { ...entry, resolver: wrap(entry.resolver) });
      }
    }
  };
}

/** The canonical ordered list of type names registered by this namespace. */
export const CLAUDE_TYPE_NAMES = [
  'SessionLog',
  'Decision',
  'Todo',
  'AgentRule',
  'CouncilSession',
  'CouncilAdvisor',
  'Memory',
  'AnchorIntent',
  'Concept',
  'ConceptLink',
  'Skill',
  'AgentIdentity',
  'AgentMessage',
  'HostInstall'
] as const;

/**
 * Architecture namespace — Claude-lineage code-review findings. Kept separate
 * from the claude context namespace so lifecycle (compaction, retention,
 * audit) differs: architectural findings outlive session-scoped rationale.
 *
 * Single type today (ArchitectureConcern). Notes:
 *   - `archived` is `field.boolean()` to match every other type that carries
 *     archived state.
 *   - `supersedes` is a self-ref `field.crossRef` edge with `set_null` —
 *     a concern survives the one it superseded going away.
 */
export function buildArchitectureNamespace(ns: string): NamespaceDefinition {
  return defineNamespace(
    ns,
    {
      ArchitectureConcern: {
        fields: {
          title: field.string(),
          status: field.string(),
          archived: field.boolean({ default: false }),
          category: field.string(),
          evidence: field.string({ indexed: false }),
          proposal: field.string({ indexed: false }),
          severity: field.string(),
          supersedes: field.crossRef(ns, 'ArchitectureConcern', {
            nullable: true,
            onDelete: 'set_null'
          }),
          revisitWhen: field.string({ nullable: true, indexed: false }),
          affectsTypes: field.string(),
          discoveredIn: field.string(),
          affectsPackages: field.string(),
          project: field.string({ nullable: true })
        }
      }
    },
    { promotedColumns: CORTEXT_PROMOTED_COLUMNS }
  );
}

export const ARCHITECTURE_TYPE_NAMES = ['ArchitectureConcern'] as const;
