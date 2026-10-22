#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

//#region ../synoptic/src/agent-auth.js
const TTL_SECONDS = 3600;
const REFRESH_SKEW = 60;
/**
* What this identity CLAIMS when nothing overrides it.
*
* The claim is narrowed by the kid's _system/Key row — the server does
* `intersectList(claimed, row.capabilities)` — so the row is the authority and
* the token only asks. A token can never widen itself, which is why claiming a
* superset is safe.
*
* THE HAZARD RUNS THE OTHER WAY, and it is why these stopped being hardcoded.
* A claim that OMITS what the row grants intersects it AWAY. An identity
* registered `admin` against a fixed `['read','mutate']` claim mints a token
* carrying NOTHING: `/substrate/v1/whoami` answers, the identity is verified and
* correctly attributed, and every `/substrate/v1/query` returns
* `{"code":"forbidden","required":"read","have":[]}`.
*
* These remain the DEFAULTS because they are right for every cold-start
* identity in the fleet — the hooks only read, and `mutate` is there for the
* mailbox ack path. The override exists for the identity the defaults are
* wrong for.
*/
const DEFAULT_CAPABILITIES = ["read", "mutate"];
const DEFAULT_NAMESPACES = ["*"];
/**
* Parse a comma-separated env override into a claim list.
* Returns `null` for unset/blank, so an empty string cannot silently mint a
* zero-capability token — which is the exact failure this whole area is about.
*/
function claimList(raw) {
	if (typeof raw !== "string") return null;
	const items = raw.split(",").map((x) => x.trim()).filter((x) => x !== "");
	return items.length === 0 ? null : items;
}
function b64url(buf) {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function mint(kid, key, ns, capabilities) {
	const now = Math.floor(Date.now() / 1e3);
	const exp = now + TTL_SECONDS;
	const signingInput = `${b64url(Buffer.from(JSON.stringify({
		alg: "EdDSA",
		typ: "JWT",
		kid
	}), "utf8"))}.${b64url(Buffer.from(JSON.stringify({
		sub: kid,
		iat: now,
		exp,
		ns,
		capabilities
	}), "utf8"))}`;
	return {
		jwt: `${signingInput}.${b64url(sign(null, Buffer.from(signingInput, "utf8"), key))}`,
		exp
	};
}
function misconfigured(detail) {
	return {
		claim: null,
		getAuthHeader: () => null,
		warning: `<!-- agent identity misconfigured: ${detail} — reads are anonymous -->\n`
	};
}
/**
* Build the hook's auth state from env, with `opts.kid` / `opts.key` overrides
* (the OpenCode V2 skin delivers identity through plugin config — `ctx.options`
* — because a per-project identity cannot live in a shared process env; opts
* win over env).
* @returns {{ getAuthHeader: () => string|null, warning: string|null }}
*   - both unset (env and opts) → anonymous, no warning (the supported open mode)
*   - both set + key loads → getAuthHeader yields `Bearer <jwt>` (cached, refreshed near expiry)
*   - anything in between → anonymous + visible warning, never a throw
*
* The warning names the `options.*` spelling only when `opts` was passed at
* all. A Claude hook is a spawned process that receives env and
* nothing else, so naming a plugin option there points at a setting its
* operator cannot reach. The OpenCode skin always passes an identity object,
* even an empty one, because that seam exists for it.
*/
function createAgentAuth(env, opts) {
	const hasOptionsSeam = opts !== void 0;
	opts ??= {};
	const optionsIdentity = opts.kid !== void 0 && opts.kid !== null && opts.kid !== "" || opts.key !== void 0 && opts.key !== null && opts.key !== "";
	const keyPath = optionsIdentity ? opts.key : env.SUBSTRATE_AGENT_KEY_PATH;
	const kid = optionsIdentity ? opts.kid : env.SUBSTRATE_AGENT_KEY_ID;
	const hasKey = typeof keyPath === "string" && keyPath !== "";
	const hasKid = typeof kid === "string" && kid !== "";
	if (!hasKey && !hasKid) return {
		getAuthHeader: () => null,
		warning: null,
		claim: null
	};
	if (!hasKey || !hasKid) {
		const [envName, optionName] = hasKey ? ["SUBSTRATE_AGENT_KEY_ID", "options.kid"] : ["SUBSTRATE_AGENT_KEY_PATH", "options.key"];
		return misconfigured(`${hasOptionsSeam ? `${envName} / ${optionName}` : envName} is not set`);
	}
	let key;
	try {
		key = createPrivateKey(readFileSync(keyPath, "utf8"));
	} catch (err) {
		return misconfigured(`cannot load ${keyPath}: ${String(err?.message ?? err)}`);
	}
	if (key.asymmetricKeyType !== "ed25519") return misconfigured(`${keyPath} is a ${key.asymmetricKeyType ?? "non-asymmetric"} key; agent tokens are EdDSA and need an ed25519 key`);
	const capabilities = opts.capabilities ?? claimList(env.SUBSTRATE_AGENT_CAPABILITIES) ?? DEFAULT_CAPABILITIES;
	const ns = opts.namespaces ?? claimList(env.SYNOPTIC_AGENT_NAMESPACES) ?? DEFAULT_NAMESPACES;
	if (capabilities.includes("*")) return misconfigured(`capabilities cannot be claimed as '*' — the capability gates do a bare \`includes\` with no wildcard branch, so a wildcard claim is refused everything. Enumerate them instead, e.g. SUBSTRATE_AGENT_CAPABILITIES=${DEFAULT_CAPABILITIES.join(",")}`);
	let cached = null;
	return {
		getAuthHeader: () => {
			const now = Math.floor(Date.now() / 1e3);
			if (cached === null || cached.exp - REFRESH_SKEW <= now) cached = mint(kid, key, ns, capabilities);
			return `Bearer ${cached.jwt}`;
		},
		warning: null,
		/** What this identity CLAIMS — the request, never the grant. See `probeWhoami` for the grant. */
		claim: {
			ns,
			capabilities
		}
	};
}

//#endregion
//#region ../synoptic/src/repo-root.js
/** Owner uid of `path`, or null when it does not exist. */
function ownerOf(path) {
	try {
		return statSync(path).uid;
	} catch {
		return null;
	}
}
/**
* The nearest ancestor of `start` (itself included) holding `.git`, a
* directory in a checkout or a file in a worktree. Null outside any
* repository, and never throws.
*
* The root's settings decide which server this session signs to, so a root
* is accepted only when it and its `.git` belong to the current user, the
* same rule as git's safe.directory: a `.git` planted in a shared ancestor
* such as /tmp must not be able to adopt a session. The walk stops at the
* nearest `.git` either way.
*
* @param {string} start
* @param {{ ownerOf?: (path: string) => number|null, uid?: number|null }} [io]
* @returns {string|null}
*/
function findRepoRoot(start, io = {}) {
	if (!start) return null;
	const owner = io.ownerOf ?? ownerOf;
	const uid = io.uid !== void 0 ? io.uid : process.getuid?.() ?? null;
	try {
		let dir = start;
		for (;;) {
			const gitOwner = owner(join(dir, ".git"));
			if (gitOwner !== null) {
				if (uid === null) return dir;
				return gitOwner === uid && owner(dir) === uid ? dir : null;
			}
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	} catch {
		return null;
	}
}

//#endregion
//#region src/config.js
const CONFIG_PATH = ".codex/cortext.local.json";
const IDENTITY_KEYS = ["SUBSTRATE_AGENT_KEY_ID", "SUBSTRATE_AGENT_KEY_PATH"];
const LOCAL_KEYS = /* @__PURE__ */ new Set([
	"SUBSTRATE_URL",
	"SUBSTRATE_NAMESPACE",
	...IDENTITY_KEYS,
	"SUBSTRATE_AGENT_CAPABILITIES",
	"SYNOPTIC_AGENT_NAMESPACES",
	"SYNOPTIC_PROJECT_SCOPE",
	"SYNOPTIC_COLD_START_MAX_BYTES",
	"SYNOPTIC_HOST_REPORT",
	"SYNOPTIC_INBOX_STOP_CHECK",
	"SYNOPTIC_INBOX_PROMPT_CHECK"
]);
/** One settings source for hooks and MCP. Never read another harness's identity. */
function loadConfig(startDir, processEnv = process.env, readFile = readFileSync) {
	const cwd = findRepoRoot(startDir) ?? startDir;
	const path = join(cwd, CONFIG_PATH);
	let config = {};
	try {
		config = JSON.parse(readFile(path, "utf8"));
		if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
		if (config.env !== void 0 && (!config.env || typeof config.env !== "object" || Array.isArray(config.env))) throw new Error();
	} catch (error) {
		if (error.code !== "ENOENT") throw new Error("Invalid .codex/cortext.local.json settings");
	}
	const env = { ...processEnv };
	const processIdentity = IDENTITY_KEYS.some((key) => processEnv[key] !== void 0);
	for (const [key, value] of Object.entries(config.env ?? {})) {
		if (!LOCAL_KEYS.has(key)) continue;
		if (typeof value !== "string") throw new Error(`Cortext setting ${key} must be a string`);
		if (processIdentity && IDENTITY_KEYS.includes(key)) continue;
		if (env[key] === void 0) env[key] = value;
	}
	if (env.SUBSTRATE_AGENT_KEY_PATH && !isAbsolute(env.SUBSTRATE_AGENT_KEY_PATH)) throw new Error("SUBSTRATE_AGENT_KEY_PATH must be an absolute file path");
	return {
		cwd,
		env,
		mcp: config.mcp ?? null
	};
}
function mcpInvocation(config) {
	const { env, mcp } = config;
	if (!env.SUBSTRATE_URL || !env.SUBSTRATE_AGENT_KEY_ID || !env.SUBSTRATE_AGENT_KEY_PATH) throw new Error("Cortext MCP requires SUBSTRATE_URL and a Codex signing identity; run $cortext:substrate-setup");
	if (!mcp || typeof mcp.command !== "string" || !isAbsolute(mcp.command) || !Array.isArray(mcp.args) || mcp.args.some((arg) => typeof arg !== "string")) throw new Error("Set mcp.command to an absolute installed executable and mcp.args to its arguments");
	return {
		command: mcp.command,
		args: mcp.args,
		cwd: config.cwd,
		env
	};
}

//#endregion
//#region src/mcp-entry.js
try {
	const config = loadConfig(process.cwd());
	if (createAgentAuth(config.env).warning) throw new Error("Codex signing identity is incomplete or unreadable");
	const invocation = mcpInvocation(config);
	const child = spawn(invocation.command, invocation.args, {
		cwd: invocation.cwd,
		env: invocation.env,
		stdio: "inherit",
		shell: false
	});
	for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
	child.on("error", () => {
		process.stderr.write("Cortext MCP executable could not start; check mcp.command.\n");
		process.exitCode = 1;
	});
	child.on("exit", (code, signal) => {
		process.exitCode = code ?? (signal ? 1 : 0);
	});
} catch (error) {
	process.stderr.write(`Cortext MCP: ${error.message}\n`);
	process.exitCode = 1;
}

//#endregion
export {  };