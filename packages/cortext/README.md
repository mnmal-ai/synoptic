# @mnmal-ai/cortext

Substrate plugins for the agent's persistent context store: a coordinator and its kernel-tier sibling, shipped as one package.

Owns the `cortext` namespace — `Todo`, `Decision`, `SessionLog`, `AgentRule`, `AnchorIntent`, `Concept`, `ConceptLink`, `Memory`, `CouncilSession`, `AgentIdentity`, `AgentMessage`, `Skill`. This is the data backbone that lets a session restart and pick up where it left off: cold-start hooks query this namespace to inject recent context; mutations during a session land here too. Compaction sweeps stale rows by per-type retention rules. Code-review findings that outlive a session live in a sibling `architecture` namespace this plugin also owns.

## Where it fits

Installed into a substrate deployment's `SUBSTRATE_PLUGIN_DIR` (manifest-driven loader). The manifest's `substrate.plugins` declares two entries, `kernel` and `coordinator`, and the loader brings up both. The only runtime peer is `@mnmal-ai/substrate`: the type DSL comes from `@mnmal-ai/substrate/sdk`, and semantic-recall hooks are contributed by substrate's recall plugin, which walks the `embed.source` metadata declared here.

## Kernel plugin

`src/kernel/` holds the kernel-tier plugin (runtime name `cortext-kernel`, exported as `createCortextKernelPlugin()` from `@mnmal-ai/cortext/kernel`). It owns the postgres-level invariants for the `cortext/*` and `architecture/*` namespaces that cannot live in the engine-side validator: vocabulary CHECK constraints, partial unique indexes and one-time body normalisations, as migrations `0001`-`0008` in `src/kernel/migrations/`. Migration order is load-bearing; see `src/kernel/plugin.ts`.

On every boot its `onKernelReady` handler audits those objects against the catalog and reports any that are missing, left NOT VALID, or scoped to a namespace no coordinator declares (`src/kernel/invariant-audit.ts`). Repair is opt-in via `SYNOPTIC_CORTEXT_REPAIR` (`src/kernel/repair.ts`). It takes no operator config (`kernel.default-config.json` is `{}`).

## Usage

```bash
npm install --prefix /opt/substrate/plugins @mnmal-ai/cortext
```

Defaults (`namespace=cortext`, `architectureNamespace=architecture`, `compactRetention=7`) ship in `default-config.json`. To override, drop a `<SUBSTRATE_PLUGIN_DIR>/cortext.config.json`:

```json
{
  "namespace": "cortext",
  "architectureNamespace": "architecture",
  "compactRetention": 14
}
```

## Auth posture

The context store is the agent's memory estate; what anonymous callers may do
with it is an operator knob, not a baked-in choice:

```json
{
  "auth": {
    "reads": "open",
    "writes": "identity",
    "deletes": "identity"
  }
}
```

Each surface is `"open"` (anonymous allowed) or `"identity"` (verified token
required). Defaults: `reads`/`writes` open, `deletes` identity-gated — a fresh
install works keyless end to end; only anonymous hard-deletes (incl. `purge`)
are refused, with `archived: true` as the open soft path. Strictness must be
monotonic along `reads → writes → deletes`; the config loader rejects
incoherent postures (e.g. gated reads over open writes) at boot.

The knob maps to plugin-level policy combinators at compose time
(`src/auth-policy.ts`) covering **both** namespaces. AutoCRUD type definitions
are untouched — tightening posture later is config-only, no schema or client
migration. Pair with attribute-mode auth so consumers can adopt signing keys
before any enforcement flips (key issuance and the retrofit path are
documented in the substrate repo, not here).
The plugin's scheduled compact task writes with a
`{kind:'system', id:'cortext:compact'}` envelope and keeps working under
gated writes.

Read-surface coverage: substrate's `/substrate/v1/recall` route and its
`recall` MCP tool honour these same policies via
`engine.evaluateReadPolicy` — semantic recall is not a
side-channel around `reads: "identity"`.

## More

- Type definitions: `src/namespace.ts`
