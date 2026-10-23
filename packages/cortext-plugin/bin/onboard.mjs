#!/usr/bin/env node
import { homedir, hostname } from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

//#region ../synoptic/src/apply-onboard.js
/** Resolve a plan file path: `~/…` → under home, anything else → under targetDir. */
function resolvePath(p, { targetDir, home }) {
	if (p === "~") return home;
	if (p.startsWith("~/")) return join(home, p.slice(2));
	return join(targetDir, p);
}
function buildIdentityScript(identity) {
	const lines = [`# Agent identity: ${identity.kid}`, "# Run in order. SAFE steps are local; PRIVILEGED steps need an operator."];
	for (const step of identity.steps) lines.push("", `# [${step.privileged ? "PRIVILEGED" : "SAFE"}] ${step.label}`, ...step.commands);
	return `${lines.join("\n")}\n`;
}
/**
* Decide the apply actions for a plan. Pure — fs state is injected via
* `existing` (absolute paths that already exist) so it's fully testable.
*
* @param {{ files: Array<{path:string,content:string,merge?:boolean}>, identity: object, primeHint: string|null }} plan
* @param {{ targetDir: string, home: string, existing?: string[] }} ctx
*/
function planActions(plan, ctx) {
	const existing = new Set(ctx.existing ?? []);
	const writes = [];
	const skipped = [];
	for (const f of plan.files) {
		const path = resolvePath(f.path, ctx);
		if (existing.has(path)) skipped.push({
			path,
			content: f.content,
			merge: f.merge === true
		});
		else writes.push({
			path,
			content: f.content
		});
	}
	return {
		writes,
		skipped,
		identityScript: buildIdentityScript(plan.identity),
		primeHint: plan.primeHint
	};
}
/**
* Apply a plan to disk: write files that don't yet exist (creating dirs),
* surface the rest. Returns a summary; the identity script + prime hint are for
* the operator to act on.
*/
function applyOnboard(plan, ctx) {
	const existing = plan.files.map((f) => resolvePath(f.path, ctx)).filter((p) => existsSync(p));
	const actions = planActions(plan, {
		...ctx,
		existing
	});
	const written = [];
	for (const w of actions.writes) {
		mkdirSync(dirname(w.path), { recursive: true });
		writeFileSync(w.path, w.content);
		written.push(w.path);
	}
	return {
		written,
		skipped: actions.skipped,
		identityScript: actions.identityScript,
		primeHint: actions.primeHint
	};
}

//#endregion
//#region ../synoptic/src/capability.js
/**
* `namespaces` takes two forms. A list of names means `read` on each,
* which is all the authority audit ever checked, so existing capabilities audit
* exactly as before. `{ ns: ['read', 'mutate'] }` declares what the capability
* does to each namespace, so the audit can warn on a key that can read
* somewhere this capability writes. The normalised `namespaces` is always the
* list of names; the per-namespace needs are in `needs`.
*
* @param {{ name: string, namespaces: string[] | Record<string, string[]>,
*           conventions: string, coldStart: (ctx: { project: string }) => string,
*           requiresIdentity?: boolean }} spec
*/
function defineCapability(spec) {
	for (const field of [
		"name",
		"namespaces",
		"conventions",
		"coldStart"
	]) if (spec[field] === void 0) throw new Error(`defineCapability: missing required field '${field}'`);
	const needs = normaliseNeeds(spec.namespaces);
	if (typeof spec.coldStart !== "function") throw new Error("defineCapability: `coldStart` must be a function (ctx) => string");
	return {
		name: spec.name,
		namespaces: Object.keys(needs),
		needs,
		requiresIdentity: spec.requiresIdentity ?? true,
		conventions: spec.conventions,
		coldStart: spec.coldStart
	};
}
/** `namespaces` in either form, as `{ ns: caps }`. Throws on an empty or malformed spec. */
function normaliseNeeds(namespaces) {
	if (Array.isArray(namespaces)) {
		if (namespaces.length === 0) throw new Error("defineCapability: `namespaces` must be a non-empty array or object");
		return Object.fromEntries(namespaces.map((ns) => [ns, ["read"]]));
	}
	if (namespaces === null || typeof namespaces !== "object" || Object.keys(namespaces).length === 0) throw new Error("defineCapability: `namespaces` must be a non-empty array or object");
	for (const [ns, caps] of Object.entries(namespaces)) if (!Array.isArray(caps) || caps.length === 0) throw new Error(`defineCapability: namespace '${ns}' must list at least one capability`);
	return { ...namespaces };
}

//#endregion
//#region ../synoptic/src/capabilities/cortext.js
/**
* Build the cortext capability bound to a coordination `namespace`.
* @param {string} [namespace='cortext'] the qualified-key namespace stem.
*/
function createCortext(namespace = "cortext") {
	const ns = namespace;
	const CONVENTIONS = [
		"## Conventions",
		"",
		`- **Qualified frame keys**: every key is \`<namespace>/<Type>\` — e.g. \`${ns}/Todo\`, \`${ns}/createTodo\`.`,
		"- **Filters live in `where`**: `eq`, `neq`, `gt|gte|lt|lte`, `between`, `in|nin`, `contains`, `startsWith|endsWith`.",
		"  Indexed handle fields (name/title/topic/synopsis/description) filter freely; long-form fields",
		"  (body/summary/notes/rationale) are unindexed — prefer `recall` for prose. `eq: null` never matches.",
		"- **Server-managed metadata**: `createdAt`/`updatedAt`/`createdBy`/`updatedBy` are server-filled —",
		"  never send them on write (rejected); read via the `_metadata` projection.",
		"- **Batched mutations**: an array under one op-key is one atomic transaction; never put the array inside `params`.",
		"- **Write context as it happens**: Decision when one is made; Todo when a gap surfaces (close with",
		"  `archived: true`); SessionLog at every stable milestone (with a retrieval-tuned `synopsis`).",
		"  Per-project rows carry `project` = repo basename; cross-cutting rows use `project: null`."
	].join("\n");
	return defineCapability({
		name: "cortext",
		namespaces: {
			[ns]: ["read", "mutate"],
			recall: ["read", "mutate"]
		},
		requiresIdentity: true,
		conventions: CONVENTIONS,
		coldStart: ({ project }) => [
			`1. \`schema\` — discover types + mutations (the \`${ns}\` namespace).`,
			"2. Query active operational rules and APPLY them silently:",
			"   ```json",
			`   { "${ns}/AgentRule": { "params": { "where": { "active": { "eq": true } } },`,
			"     \"fields\": { \"id\": true, \"rule\": true, \"category\": true, \"rationale\": true } } }",
			"   ```",
			`3. Orient (≤5 lines): open Todos for \`${project}\`, recent \`${ns}/Memory\`, and`,
			"   `recall` for the task at hand.",
			`4. RESUME (cross-agent handoff) — the latest breadcrumb for \`${project}\`:`,
			"   ```json",
			`   { "${ns}/AnchorIntent": { "params": { "where": { "project": { "eq": "${project}" }, "archived": { "eq": false } }, "orderBy": [{ "createdAt": "desc" }], "limit": 1 }, "fields": { "synopsis": true, "body": true, "_metadata": true } } }`,
			"   ```",
			"   If one exists, continue from its `synopsis`/`body` — another agent may have left it.",
			`   When you pause mid-task, leave your own via \`${ns}/createAnchorIntent\` so the next agent resumes.`
		].join("\n")
	});
}
const cortext = createCortext("cortext");

//#endregion
//#region ../synoptic/src/wire-mcp.js
/** @typedef {'claude-code'|'kimi'|'cursor'|'gemini'|'codex'|'opencode'|'muse'} Harness */
const HARNESSES$1 = {
	"claude-code": {
		instructionFile: "CLAUDE.md",
		autoLoadsInstructions: true,
		injectionHook: "session-start",
		coldStartTier: "live-inject",
		mcp: {
			projectPath: ".mcp.json",
			userPath: "~/.claude.json",
			format: "json",
			envStyle: "var-expansion",
			merge: false
		}
	},
	kimi: {
		instructionFile: "AGENTS.md",
		autoLoadsInstructions: false,
		injectionHook: null,
		coldStartTier: "manual-prime",
		mcp: {
			projectPath: ".kimi-code/mcp.json",
			userPath: "~/.kimi-code/mcp.json",
			format: "json",
			envStyle: "literal",
			merge: false
		}
	},
	cursor: {
		instructionFile: ".cursor/rules/substrate.mdc",
		autoLoadsInstructions: true,
		injectionHook: null,
		coldStartTier: "auto-file",
		mcp: {
			projectPath: ".cursor/mcp.json",
			userPath: "~/.cursor/mcp.json",
			format: "json",
			envStyle: "literal",
			merge: false,
			toolCeiling: 40
		}
	},
	gemini: {
		instructionFile: "GEMINI.md",
		autoLoadsInstructions: true,
		injectionHook: null,
		coldStartTier: "auto-file",
		mcp: {
			projectPath: ".gemini/settings.json",
			userPath: "~/.gemini/settings.json",
			format: "json",
			envStyle: "literal",
			merge: true
		}
	},
	codex: {
		instructionFile: "AGENTS.md",
		autoLoadsInstructions: true,
		injectionHook: null,
		coldStartTier: "auto-file",
		mcp: {
			projectPath: ".codex/config.toml",
			userPath: "~/.codex/config.toml",
			format: "toml",
			envStyle: "literal",
			merge: true
		}
	},
	opencode: {
		instructionFile: "AGENTS.md",
		autoLoadsInstructions: true,
		injectionHook: "system-transform",
		coldStartTier: "live-inject",
		mcp: {
			projectPath: "opencode.json",
			userPath: "~/.config/opencode/opencode.json",
			format: "opencode-json",
			envStyle: "interpolation",
			merge: true
		}
	},
	muse: {
		instructionFile: "AGENTS.md",
		autoLoadsInstructions: true,
		injectionHook: "session-start",
		coldStartTier: "live-inject",
		mcp: {
			projectPath: null,
			userPath: "~/.config/muse/settings.json",
			format: "muse-json",
			envStyle: "literal",
			merge: true
		}
	}
};
/**
* The spawn command for the substrate MCP server. Prefer a local install via
* `--mcp-bin` (`node <bin> mcp` — no registry auth); otherwise the published
* package via npx, from npm's `next` tag (`latest` is a placeholder until 1.0.0).
*/
function serverCommand(id) {
	return id.mcpBin ? {
		command: "node",
		args: [id.mcpBin, "mcp"]
	} : {
		command: "npx",
		args: [
			"-y",
			"@mnmal-ai/substrate@next",
			"mcp"
		]
	};
}
function serverEnv(id) {
	return {
		SUBSTRATE_URL: id.substrateUrl,
		SUBSTRATE_AGENT_KEY_PATH: id.keyPath,
		SUBSTRATE_AGENT_KEY_ID: id.kid
	};
}
/**
* Minimal TOML for the one shape we emit: a `[mcp_servers.<name>]` table with a
* string `command`, a string-array `args`, and a `[mcp_servers.<name>.env]`
* subtable of string values. TOML basic strings share JSON string escaping for
* our value space (URLs, POSIX paths, kids — no control characters), so
* JSON.stringify yields a valid TOML basic string.
*/
function emitToml(serverName, entry) {
	const q = (s) => JSON.stringify(s);
	return [
		`[mcp_servers.${serverName}]`,
		`command = ${q(entry.command)}`,
		`args = [${entry.args.map(q).join(", ")}]`,
		"",
		`[mcp_servers.${serverName}.env]`,
		...Object.entries(entry.env).map(([k, v]) => `${k} = ${q(v)}`),
		""
	].join("\n");
}
/**
* OpenCode's dialect differs on every key: in 2.x servers live under
* `mcp.servers` (not `mcpServers`, and not 1.x's bare `mcp.<name>`, which 2.x
* still migrates) inside opencode.json, `type: 'local'` is required, `command`
* is a string ARRAY, and env rides under `environment`. `codemode: false`
* because 2.x otherwise hides a local server's tools behind its generic
* `execute` tool: the model never sees `substrate_*` by name, and an agent
* following the conventions concludes it has no substrate tools. Identity values are
* emitted as `{env:VAR}` interpolation refs — never literals: opencode.json
* is committed, and a key path or kid baked in here would be machine-specific
* (the indirected arrangement from substrate-setup Step 4.3).
* SUBSTRATE_URL stays literal; it is the fleet-public value.
*/
function emitOpencode(serverName, id) {
	const cmd = serverCommand(id);
	return `${JSON.stringify({ mcp: { servers: { [serverName]: {
		type: "local",
		command: [cmd.command, ...cmd.args],
		codemode: false,
		environment: {
			SUBSTRATE_URL: id.substrateUrl,
			SUBSTRATE_AGENT_KEY_PATH: "{env:SUBSTRATE_AGENT_KEY_PATH}",
			SUBSTRATE_AGENT_KEY_ID: "{env:SUBSTRATE_AGENT_KEY_ID}"
		}
	} } } }, null, 2)}\n`;
}
/**
* Muse's dialect: the block is `mcpServers` (the binary migrates a
* `mcp_servers` key to this spelling on load — measured, against docs that
* still print the snake_case form) inside settings.json, each server carrying
* an explicit stdio `transport`. `enabled: true` + `mode: 'optional'` are
* emitted explicitly: optional is the measured default and matches this
* repo's never-break-dispatch posture (a down Substrate warns instead of aborting
* the run; the cold-start hook degrades to its offline note beside it).
* Identity rides as literals — the user settings file is machine-local and
* never committed.
*/
function emitMuse(serverName, entry) {
	return `${JSON.stringify({ mcpServers: { [serverName]: {
		transport: "stdio",
		command: entry.command === "node" ? process.execPath : entry.command,
		args: entry.args,
		env: entry.env,
		enabled: true,
		mode: "optional"
	} } }, null, 2)}\n`;
}
/**
* Emit the MCP-server config to connect `harness` to the Substrate context store as
* the given identity.
*
* @param {Harness} harness
* @param {{ substrateUrl: string, kid: string, keyPath: string, mcpBin?: string }} id
* @param {{ scope?: 'project'|'user', serverName?: string }} [opts]
* @returns {{ harness: Harness, path: string, format: 'json'|'toml'|'opencode-json'|'muse-json', merge: boolean, content: string }}
*/
function wireMCP(harness, id, opts = {}) {
	const caps = HARNESSES$1[harness];
	if (caps === void 0) throw new Error(`wireMCP: unknown harness '${harness}' (known: ${Object.keys(HARNESSES$1).join(", ")})`);
	const serverName = opts.serverName ?? "substrate";
	const entry = {
		...serverCommand(id),
		env: serverEnv(id)
	};
	const path = opts.scope === "user" ? caps.mcp.userPath : caps.mcp.projectPath;
	if (path === null) throw new Error(`wireMCP: '${harness}' has no project-scope config (one fleet server, user scope only) — use { scope: 'user' }`);
	const merge = caps.mcp.merge;
	const content = caps.mcp.format === "toml" ? emitToml(serverName, entry) : caps.mcp.format === "opencode-json" ? emitOpencode(serverName, id) : caps.mcp.format === "muse-json" ? emitMuse(serverName, entry) : `${JSON.stringify({ mcpServers: { [serverName]: entry } }, null, 2)}\n`;
	return {
		harness,
		path,
		format: caps.mcp.format,
		merge,
		content
	};
}

//#endregion
//#region ../synoptic/src/cold-start-projector.js
/** Host framing for the embedded (tier B/C) self-query; `DO THIS FIRST` is the
*  marker that distinguishes an embedded self-query from hook delivery. */
function selfQueryFraming(body) {
	return [
		"## Cold-start — DO THIS FIRST, EVERY SESSION",
		"",
		"Nothing is auto-injected, so load context yourself before other work:",
		"",
		body,
		"",
		"Re-run this cold-start after any context compaction."
	].join("\n");
}
/** Tier-A framing: cold-start is delivered live by the host's session hook. */
function hookBlock(capabilityName) {
	return [
		"## Cold-start",
		"",
		`The ${capabilityName} cold-start rule index (binding and always-on AgentRules, one line`,
		"each, plus pointers to everything else) is **injected automatically** at session start",
		"by the Synoptic hook — read it before acting. The hook re-runs after any compaction."
	].join("\n");
}
function header(project, capabilityName, namespace) {
	return [
		`# ${capabilityName} — shared agent context store`,
		"",
		`Project: \`${project}\`. You read + write the shared coordination store via the \`substrate\``,
		"MCP server (`schema`, `query`, `mutate`, `recall`, `ask`).",
		"",
		`> \`${namespace}/*\` is a neutral **codename** for the shared namespace, not Claude-only —`,
		"> every agent (you included) is a first-class reader/writer; rows attribute to whoever",
		"> wrote them via `_metadata.createdBy`. Write freely."
	].join("\n");
}
/** Always-apply rule frontmatter so Cursor auto-attaches the doc (.mdc). */
function cursorFrontmatter() {
	return [
		"---",
		"alwaysApply: true",
		"description: shared agent context store — conventions + cold-start",
		"---",
		""
	].join("\n");
}
/**
* Project a capability's cold-start + conventions into `harness`'s instruction
* file, resolving its tier.
*
* @param {'claude-code'|'kimi'|'cursor'|'gemini'|'codex'|'opencode'|'muse'} harness
* @param {{ project: string, capability: { name: string, namespaces: string[], conventions: string, coldStart: (ctx: object) => string } }} ctx
* @returns {{ harness: string, capability: string, tier: string, path: string, content: string, primeHint: string|null }}
*/
function projectColdStart(harness, ctx) {
	const caps = HARNESSES$1[harness];
	if (caps === void 0) throw new Error(`projectColdStart: unknown harness '${harness}' (known: ${Object.keys(HARNESSES$1).join(", ")})`);
	const { project, capability } = ctx;
	if (capability === void 0) throw new Error("projectColdStart: ctx.capability is required (the northbound capability to deliver)");
	const namespace = capability.namespaces[0];
	const coldStart = caps.coldStartTier === "live-inject" ? hookBlock(capability.name) : selfQueryFraming(capability.coldStart({ project }));
	let content = `${[
		header(project, capability.name, namespace),
		coldStart,
		capability.conventions.trim()
	].join("\n\n")}\n`;
	if (harness === "cursor") content = `${cursorFrontmatter()}\n${content}`;
	const primeHint = caps.coldStartTier === "manual-prime" ? `Start each session with \`@${caps.instructionFile}\` — ${harness} does not auto-load it.` : null;
	return {
		harness,
		capability: capability.name,
		tier: caps.coldStartTier,
		path: caps.instructionFile,
		content,
		primeHint
	};
}

//#endregion
//#region ../synoptic/src/provision-identity.js
/** Expand a leading `~` to the absolute home dir. The key path is written into
*  an MCP config that a NON-shell process (the substrate MCP server) reads with
*  `readFileSync` — `~` is never expanded there, so a tilde path fails-loud on
*  boot. Found onboarding Codex (the config carried `~/.config/substrate/keys/…`). Key
*  paths must be absolute; the keygen shell commands tolerate absolute fine. */
function expandHome(p) {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return `${homedir()}/${p.slice(2)}`;
	return p;
}
/**
* @param {string} agent  short agent label, e.g. 'cursor', 'gemini', 'codex'
* @param {{ host?: string, project?: string, keyDir?: string, runtimeEnv?: string, store?: string,
*           namespace?: string, namespaces?: ReadonlyArray<string>, caps?: ReadonlyArray<string> }} [opts]
* @returns {{ agent: string, host: string, kid: string, keyPath: string, pubPath: string,
*            namespaces: ReadonlyArray<string>, caps: ReadonlyArray<string>,
*            steps: Array<{ id: string, label: string, privileged: boolean, commands: string[] }> }}
*/
function provisionIdentity(agent, opts = {}) {
	const host = opts.host ?? hostname();
	const keyDir = expandHome(opts.keyDir ?? `${homedir()}/.config/substrate/keys`);
	const runtimeEnv = opts.runtimeEnv ?? "./.env";
	const adminBin = opts.adminBin ?? `${dirname(runtimeEnv)}/node_modules/.bin/substrate-admin`;
	const store = opts.store ?? "${SUBSTRATE_DATABASE_URL}";
	const kid = opts.project ? `${agent}-${opts.project}@${host}` : `${agent}@${host}`;
	const keyPath = `${keyDir}/${kid}.key`;
	const pubPath = `${keyDir}/${kid}.pub`;
	const namespace = opts.namespace ?? "cortext";
	const namespaces = opts.namespaces ?? [namespace, "recall"];
	const caps = opts.caps ?? ["read", "mutate"];
	for (const [name, list] of [["namespaces", namespaces], ["caps", caps]]) if (!Array.isArray(list) || list.length === 0) throw new Error(`provisionIdentity: '${name}' must be a non-empty array — omitting it on the substrate-admin command line grants \`*\`, so there is no safe empty value`);
	const nsCsv = namespaces.join(",");
	const capsCsv = caps.join(",");
	return {
		agent,
		host,
		kid,
		keyPath,
		pubPath,
		namespaces,
		caps,
		steps: [
			{
				id: "keygen",
				label: "Generate the Ed25519 keypair (local, private key stays on this box)",
				privileged: false,
				commands: [
					`mkdir -p ${keyDir} && chmod 700 ${keyDir}`,
					`openssl genpkey -algorithm ed25519 -out ${keyPath} && chmod 600 ${keyPath}`,
					`openssl pkey -in ${keyPath} -pubout -out ${pubPath}`
				]
			},
			{
				id: "register",
				label: `Register the PUBLIC key as a _system/Key (admin → the store), granting ${capsCsv} on namespaces: ${nsCsv}`,
				privileged: true,
				commands: [`SUBSTRATE_DATABASE_URL=$(grep '^SUBSTRATE_DATABASE_URL=' ${runtimeEnv} | cut -d= -f2-)`, `SUBSTRATE_DATABASE_URL="${store}" ${adminBin} register "${kid}" --pubkey ${pubPath} --ns ${nsCsv} --caps ${capsCsv}`]
			},
			{
				id: "restart",
				label: "Restart the substrate binary so it re-primes the key registry from the DB",
				privileged: true,
				commands: ["sudo systemctl restart substrate-binary"]
			}
		]
	};
}

//#endregion
//#region ../synoptic/src/onboard.js
/** Agent label per harness. Most agents are named for their harness; Claude
*  Code signs as `claude` (the historical kid stem), not `claude-code`. */
const AGENT_LABEL = { "claude-code": "claude" };
/**
* @param {'claude-code'|'kimi'|'cursor'|'gemini'|'codex'|'opencode'|'muse'} harness
* @param {{ host?: string, project: string, substrateUrl: string, mcpBin?: string,
*           keyDir?: string, capability?: object, scope?: 'project'|'user', agent?: string }} opts
*/
function onboard(harness, opts = {}) {
	if (HARNESSES$1[harness] === void 0) throw new Error(`onboard: unknown harness '${harness}' (known: ${Object.keys(HARNESSES$1).join(", ")})`);
	const agent = opts.agent ?? AGENT_LABEL[harness] ?? harness;
	const capability = opts.capability ?? cortext;
	const identity = provisionIdentity(agent, {
		namespaces: capability.namespaces,
		...opts.host !== void 0 ? { host: opts.host } : {},
		...opts.keyDir !== void 0 ? { keyDir: opts.keyDir } : {}
	});
	const scope = opts.scope ?? (harness === "muse" ? "user" : void 0);
	const mcp = wireMCP(harness, {
		substrateUrl: opts.substrateUrl,
		kid: identity.kid,
		keyPath: identity.keyPath,
		...opts.mcpBin !== void 0 ? { mcpBin: opts.mcpBin } : {}
	}, scope !== void 0 ? { scope } : {});
	const doc = projectColdStart(harness, {
		project: opts.project,
		capability
	});
	const files = [{
		kind: "mcp",
		path: mcp.path,
		content: mcp.content,
		format: mcp.format,
		merge: mcp.merge
	}, {
		kind: "instructions",
		path: doc.path,
		content: doc.content
	}];
	return {
		harness,
		agent,
		capability: capability.name,
		kid: identity.kid,
		identity,
		files,
		primeHint: doc.primeHint
	};
}

//#endregion
//#region ../synoptic/src/onboard-entry.js
const HARNESSES = Object.keys(HARNESSES$1);
function parseArgs(argv) {
	const [harness, ...rest] = argv;
	const flags = {};
	for (let i = 0; i < rest.length; i++) {
		if (!rest[i].startsWith("--")) continue;
		const name = rest[i].slice(2);
		flags[name] = name === "apply" ? true : rest[++i];
	}
	return {
		harness,
		flags
	};
}
const { harness, flags } = parseArgs(process.argv.slice(2));
const substrateUrl = flags["substrate-url"] ?? process.env.SUBSTRATE_URL;
if (!harness || !HARNESSES.includes(harness) || !substrateUrl) {
	process.stderr.write(`usage: onboard <${HARNESSES.join("|")}> --substrate-url URL (or SUBSTRATE_URL) [--project X] [--host X] [--mcp-bin PATH] [--target-dir DIR] [--scope project|user] [--apply]\n`);
	process.exit(1);
}
const plan = onboard(harness, {
	host: flags.host ?? hostname(),
	project: flags.project ?? "default",
	substrateUrl,
	...flags["mcp-bin"] ? { mcpBin: flags["mcp-bin"] } : {},
	...flags.scope ? { scope: flags.scope } : {}
});
const ctx = {
	targetDir: flags["target-dir"] ?? process.cwd(),
	home: process.env.HOME ?? "~"
};
const out = (s) => process.stdout.write(`${s}\n`);
out(`\nonboard ${plan.harness} → ${plan.kid}\n`);
if (flags.apply) {
	const s = applyOnboard(plan, ctx);
	out("WROTE:");
	for (const p of s.written) out(`  + ${p}`);
	if (s.skipped.length) {
		out("SKIPPED (exists — review/merge):");
		for (const k of s.skipped) out(`  ~ ${k.path}${k.merge ? "  (structured merge)" : ""}`);
	}
	out("\nIDENTITY — run these (PRIVILEGED steps need an operator):\n");
	out(s.identityScript);
	if (s.primeHint) out(`PRIME: ${s.primeHint}`);
} else {
	const a = planActions(plan, {
		...ctx,
		existing: []
	});
	out("WOULD WRITE (dry-run — pass --apply to write):");
	for (const w of a.writes) out(`  + ${w.path}`);
	out("\nIDENTITY:\n");
	out(a.identityScript);
	if (a.primeHint) out(`PRIME: ${a.primeHint}`);
}

//#endregion
export {  };