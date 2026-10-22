#!/usr/bin/env node
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

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
/**
* Wrap a fetch implementation so every request carries the agent JWT when one
* is available. The single seam for the whole hook — every HTTP helper takes
* an injectable fetchImpl, so signing needs no per-call-site changes.
*/
function makeSignedFetch(getAuthHeader, fetchImpl = fetch) {
	return (url, init = {}) => {
		const header = getAuthHeader();
		if (header === null) return fetchImpl(url, init);
		return fetchImpl(url, {
			...init,
			headers: {
				...init.headers,
				authorization: header
			}
		});
	};
}

//#endregion
//#region ../synoptic/src/projection-audit.js
/**
* Residue for one response: fields substrate reported as undeclared that the call
* site did not say to expect.
*
* @param {unknown} envelope Parsed /substrate/v1/query response.
* @param {ReadonlyArray<string>} expectUnknown Field names this call site
*   knowingly projects on types that may not declare them.
* @returns {Array<{ key: string, fields: Array<string> }>}
*/
function unexpectedProjections(envelope, expectUnknown = []) {
	const diagnostics = envelope !== null && typeof envelope === "object" ? envelope._diagnostics : null;
	if (diagnostics === null || diagnostics === void 0 || typeof diagnostics !== "object") return [];
	const expected = new Set(expectUnknown);
	const out = [];
	for (const [key, entry] of Object.entries(diagnostics)) {
		const unknown = entry?.unknownProjectionFields;
		if (!Array.isArray(unknown)) continue;
		const residue = unknown.filter((f) => !expected.has(f));
		if (residue.length > 0) out.push({
			key,
			fields: residue
		});
	}
	return out;
}
/**
* Frame keys the request asked for that the response did not answer.
*
* @param {Record<string, unknown>} payload The query frame that was sent.
* @param {unknown} envelope The parsed response.
* @returns {Array<string>}
*/
function unansweredFrames(payload, envelope) {
	if (payload === null || typeof payload !== "object") return [];
	const data = envelope !== null && typeof envelope === "object" ? envelope.data ?? null : null;
	const answered = data !== null && typeof data === "object" ? new Set(Object.keys(data)) : /* @__PURE__ */ new Set();
	return Object.keys(payload).filter((k) => !answered.has(k));
}
/**
* The envelope's `errors`, normalised to `{ key, code, message }`.
*
* `path[0]` is the frame key for a frame-scoped rejection; an error without one
* is envelope-level and reported under '(request)'.
*
* @param {unknown} envelope
* @returns {Array<{ key: string, code: string, message: string }>}
*/
function frameErrors(envelope) {
	const errs = envelope !== null && typeof envelope === "object" ? envelope.errors : null;
	if (!Array.isArray(errs)) return [];
	return errs.map((e) => ({
		key: typeof e?.path?.[0] === "string" ? e.path[0] : "(request)",
		code: typeof e?.code === "string" ? e.code : "error",
		message: typeof e?.message === "string" ? e.message : String(e)
	}));
}

//#endregion
//#region ../synoptic/src/substrate-http.js
const DEFAULT_TIMEOUT_MS = 3e3;
function withTimeout(timeoutMs) {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), timeoutMs);
	return {
		signal: ctl.signal,
		done: () => clearTimeout(t)
	};
}
/**
* POST /substrate/v1/query. Returns the `data` map. Throws on non-2xx / network / timeout.
*
* The return shape deliberately ignores the server's `_diagnostics` sidecar.
* Handing it back
* alongside `data` would churn every caller and, worse, let the projection and
* the statement of what it expects drift apart in different files. Instead the
* call site declares `expectUnknown` right beside its `fields` block, and only
* the residue reaches `onUnexpectedProjection`. See projection-audit.js for why
* the residue — not the raw diagnostic — is the unit of alarm.
*
* `onDiagnostics` is the raw escape hatch, for callers that need the per-type
* unknown sets to do their own cross-type comparison.
*/
async function substrateQuery(substrateUrl, payload, opts = {}) {
	const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, expectUnknown = [], onUnexpectedProjection = null, onDiagnostics = null, onFrameFailure = null } = opts;
	const { signal, done } = withTimeout(timeoutMs);
	try {
		const res = await fetchImpl(`${substrateUrl}/substrate/v1/query`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal
		});
		if (!res.ok) throw new Error(`substrate/query ${res.status}`);
		const json = await res.json();
		try {
			if (onFrameFailure !== null) {
				for (const e of frameErrors(json)) onFrameFailure(e.key, `${e.code}: ${e.message}`);
				for (const key of unansweredFrames(payload, json)) onFrameFailure(key, "requested but absent from `data`, with no error given");
			}
			if (onDiagnostics !== null) onDiagnostics(json?._diagnostics ?? null);
			if (onUnexpectedProjection !== null) {
				const residue = unexpectedProjections(json, expectUnknown);
				if (residue.length > 0) onUnexpectedProjection(residue);
			}
		} catch {}
		return json.data ?? {};
	} finally {
		done();
	}
}

//#endregion
//#region ../synoptic/src/inbox.js
/**
* The session kid's AgentIdentity row id, or null (no kid, or no row).
*/
async function resolveIdentityId({ substrateUrl, namespace = "cortext", agentKid, fetchImpl = fetch }) {
	if (!agentKid) return null;
	return ((await substrateQuery(substrateUrl, { [`${namespace}/AgentIdentity`]: {
		params: {
			where: { kid: { eq: agentKid } },
			limit: 1
		},
		fields: { id: true }
	} }, { fetchImpl }))[`${namespace}/AgentIdentity`] ?? [])[0]?.id ?? null;
}

//#endregion
//#region ../synoptic/src/inbox-push.js
/** A substrate AgentMessage row (with `_metadata`) as a flat message. */
function fromRow(row) {
	return {
		id: row.id,
		shortId: row.shortId,
		subject: row.subject,
		body: row.body ?? null,
		inReplyTo: row.inReplyTo ?? null,
		tags: row.tags ?? null,
		from: row._metadata?.createdBy?.id ?? "unknown sender",
		instance: typeof row.instance === "string" && row.instance !== "" ? row.instance : null,
		createdAt: typeof row._metadata?.createdAt === "string" ? row._metadata.createdAt : ""
	};
}
const URGENT_TAG = "priority:urgent";
/** A substrate row as the watcher's `message` event (spec §4.2 contract). */
function toWatchMessage(row, { kid, urgentFrom }) {
	const m = fromRow(row);
	const tagged = Array.isArray(m.tags) && m.tags.includes(URGENT_TAG);
	return {
		type: "message",
		...m,
		fromSelf: m.from === kid,
		urgent: tagged && urgentFrom.includes(m.from)
	};
}
/** D5 switches. PUSH defaults on, WAKE defaults OFF (D1 — on only after the live check). */
function readInboxKnobs(env) {
	return {
		push: env.SYNOPTIC_INBOX_PUSH !== "off",
		wake: env.SYNOPTIC_INBOX_WAKE === "on",
		urgentFrom: (env.SYNOPTIC_INBOX_URGENT_FROM ?? "").split(",").map((s) => s.trim()).filter(Boolean)
	};
}

//#endregion
//#region ../synoptic/src/inbox-watch.js
/** Incremental text/event-stream parser. */
function parseSse() {
	let buf = "";
	return (chunk) => {
		buf += chunk.replace(/\r\n/g, "\n");
		const blocks = buf.split("\n\n");
		buf = blocks.pop() ?? "";
		const out = [];
		for (const block of blocks) {
			let event = "message";
			const data = [];
			for (const line of block.split("\n")) {
				if (line.startsWith(":") || line === "") continue;
				const i = line.indexOf(":");
				const field = i === -1 ? line : line.slice(0, i);
				const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
				if (field === "event") event = value;
				else if (field === "data") data.push(value);
			}
			if (data.length === 0) continue;
			const raw = data.join("\n");
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				parsed = raw;
			}
			out.push({
				event,
				data: parsed
			});
		}
		return out;
	};
}
const OVERLOAD = "subscription_overloaded";
async function runWatcher({ env, fetchImpl, since, emit, sleep, idleMs = 6e4, namespace }) {
	const ns = namespace ?? env.SUBSTRATE_NAMESPACE ?? "cortext";
	const knobs = readInboxKnobs(env);
	const disabled = (reason) => emit({
		type: "status",
		state: "disabled",
		reason
	});
	if (!env.SUBSTRATE_URL || !env.SUBSTRATE_AGENT_KEY_ID) return disabled("no SUBSTRATE_URL or SUBSTRATE_AGENT_KEY_ID");
	if (!knobs.push) return disabled("SYNOPTIC_INBOX_PUSH=off");
	const backoff = (n) => sleep(Math.min(6e4, 1e3 * 2 ** n));
	let attempt = 0;
	let meId;
	for (;;) try {
		meId = await resolveIdentityId({
			substrateUrl: env.SUBSTRATE_URL,
			namespace: ns,
			agentKid: env.SUBSTRATE_AGENT_KEY_ID,
			fetchImpl
		});
		break;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/^substrate\/query 40[13]$/.test(message)) return disabled(`identity lookup failed: ${message}`);
		emit({
			type: "status",
			state: "reconnecting",
			reason: `identity lookup: ${message}`
		});
		await backoff(attempt);
		attempt += 1;
	}
	if (meId === null) return disabled(`no AgentIdentity row for ${env.SUBSTRATE_AGENT_KEY_ID}`);
	attempt = 0;
	const frame = { [`${ns}/AgentMessage`]: {
		params: { where: {
			recipient: { eq: meId },
			status: { eq: "unread" },
			archived: { eq: false }
		} },
		fields: {
			id: true,
			shortId: true,
			subject: true,
			body: true,
			inReplyTo: true,
			instance: true,
			tags: true,
			_metadata: true
		}
	} };
	const toMsg = (r) => toWatchMessage(r, {
		kid: env.SUBSTRATE_AGENT_KEY_ID,
		urgentFrom: knobs.urgentFrom
	});
	let snapshotSeen = false;
	let restarts = 0;
	const sinceMs = Date.parse(since);
	const isNewer = (row) => {
		const t = Date.parse(row?._metadata?.createdAt);
		return Number.isNaN(t) || Number.isNaN(sinceMs) || t >= sinceMs;
	};
	const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
	for (;;) {
		snapshotSeen = false;
		const outcome = await oneConnection();
		if (snapshotSeen && outcome.reason !== OVERLOAD) attempt = 0;
		if (snapshotSeen) restarts = 0;
		if (outcome.kind === "terminal") return disabled(outcome.reason);
		if (outcome.kind === "now" && (snapshotSeen || ++restarts <= 3)) continue;
		emit({
			type: "status",
			state: "reconnecting",
			reason: outcome.reason
		});
		await backoff(attempt);
		attempt += 1;
	}
	/** One subscription. Resolves { kind: 'terminal'|'now'|'backoff', reason }. */
	async function oneConnection() {
		const ac = new AbortController();
		let res;
		try {
			res = await fetchImpl(`${env.SUBSTRATE_URL}/substrate/v1/subscribe`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "text/event-stream"
				},
				body: JSON.stringify(frame),
				signal: ac.signal
			});
		} catch (err) {
			return {
				kind: "backoff",
				reason: `connect: ${err instanceof Error ? err.message : String(err)}`
			};
		}
		if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return {
			kind: "terminal",
			reason: `HTTP ${res.status}`
		};
		if (!res.ok || res.body == null) return {
			kind: "backoff",
			reason: `HTTP ${res.status}`
		};
		const parse = parseSse();
		const decoder = new TextDecoder();
		const reader = res.body.getReader();
		let idle;
		let live = false;
		const idleTimeout = () => new Promise((resolve) => {
			idle = setTimeout(() => resolve({ idle: true }), idleMs);
		});
		try {
			for (;;) {
				const r = await Promise.race([reader.read(), idleTimeout()]);
				clearTimeout(idle);
				if ("idle" in r) return {
					kind: "backoff",
					reason: `idle ${idleMs} ms`
				};
				if (r.done) return {
					kind: "backoff",
					reason: "stream ended without an end frame"
				};
				for (const { event, data } of parse(decoder.decode(r.value, { stream: true }))) if (event === "snapshot") {
					if (!isObj(data)) continue;
					snapshotSeen = true;
					if (!live) {
						live = true;
						emit({
							type: "status",
							state: "live",
							config: { wake: knobs.wake }
						});
					}
					const rows = Array.isArray(data.rows) ? data.rows : [];
					for (const row of rows) if (isObj(row) && isNewer(row)) emit(toMsg(row));
				} else if (event === "add") {
					if (isObj(data) && isObj(data.row)) emit(toMsg(data.row));
				} else if (event === "remove") {
					if (isObj(data) && typeof data.removedId === "string") emit({
						type: "handled",
						id: data.removedId
					});
				} else if (event === "error") {
					if (isObj(data) && data.code === OVERLOAD) return {
						kind: "backoff",
						reason: OVERLOAD
					};
					return {
						kind: "terminal",
						reason: isObj(data) && data.code || "error"
					};
				} else if (event === "end") return isObj(data) && data.reason === "server_restart" ? {
					kind: "now",
					reason: "server_restart"
				} : {
					kind: "backoff",
					reason: isObj(data) && data.reason || "end"
				};
			}
		} finally {
			clearTimeout(idle);
			ac.abort();
			reader.cancel().catch(() => {});
		}
	}
}

//#endregion
//#region ../synoptic/src/fs-safe.js
/** A file's utf8 text, or null when absent or unreadable. Never throws. */
function readOrNull(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

//#endregion
//#region ../synoptic/src/local-env.js
/** Settings keys a hook may inherit repo-locally. Everything else stays shell-only. */
const LOCAL_ENV_KEYS = [
	"SUBSTRATE_URL",
	"SUBSTRATE_NAMESPACE",
	"SUBSTRATE_AGENT_KEY_ID",
	"SUBSTRATE_AGENT_KEY_PATH",
	"SUBSTRATE_AGENT_CAPABILITIES",
	"SYNOPTIC_AGENT_NAMESPACES",
	"SYNOPTIC_PROJECT_SCOPE",
	"SYNOPTIC_COLD_START_MAX_BYTES",
	"SYNOPTIC_INBOX_STOP_CHECK",
	"SYNOPTIC_INBOX_PROMPT_CHECK",
	"SYNOPTIC_INBOX_PUSH",
	"SYNOPTIC_INBOX_WAKE",
	"SYNOPTIC_INBOX_URGENT_FROM"
];
/**
* The repo-local env overlay: `{ env, source }`.
*
* @param {{ targetDir: string, readFile?: (path: string) => string|null }} p
* @returns {{ env: Record<string,string>, source: string|null }}
*   `source` is the settings path the overlay came from, or null when there
*   is none (absent/unparsable/no env object — all the same observation).
*/
function readLocalEnv({ targetDir, readFile = readOrNull }) {
	const source = join(targetDir, ".claude", "settings.local.json");
	let raw = null;
	try {
		raw = readFile(source);
	} catch {
		return {
			env: {},
			source: null
		};
	}
	if (raw === null) return {
		env: {},
		source: null
	};
	let parsed = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			env: {},
			source: null
		};
	}
	const block = parsed?.env;
	if (block === null || typeof block !== "object" || Array.isArray(block)) return {
		env: {},
		source: null
	};
	const env = {};
	for (const key of LOCAL_ENV_KEYS) {
		const v = block[key];
		if (typeof v === "string" && v !== "") env[key] = v;
	}
	return {
		env,
		source: Object.keys(env).length === 0 ? null : source
	};
}
/**
* Merge process env over the repo-local overlay. Process env always wins —
* an explicitly exported value is a choice, and the fallback must never
* silently replace one.
*
* @param {Record<string,string|undefined>} processEnv
* @param {{ targetDir: string, readFile?: (path: string) => string|null }} p
* @returns {{ env: Record<string,string|undefined>, source: string|null, filled: string[] }}
*   `filled` names the keys the overlay supplied, so callers can report it.
*/
function envWithLocalFallback(processEnv, { targetDir, readFile = readOrNull }) {
	const { env: local, source } = readLocalEnv({
		targetDir,
		readFile
	});
	if (source === null) return {
		env: processEnv,
		source: null,
		filled: []
	};
	const env = { ...processEnv };
	const filled = [];
	for (const [k, v] of Object.entries(local)) if (env[k] === void 0 || env[k] === "") {
		env[k] = v;
		filled.push(k);
	}
	return {
		env,
		source,
		filled: filled.length === 0 ? [] : filled
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
//#region ../synoptic/src/scope.js
/** The repository root for a session started in `start`, or `start` itself outside one. */
function sessionRoot(start) {
	return findRepoRoot(start) ?? start;
}

//#endregion
//#region ../synoptic/src/inbox-watch-entry.js
const i = process.argv.indexOf("--since");
const v = i !== -1 ? process.argv[i + 1] : void 0;
const since = v !== void 0 && !v.startsWith("--") && !Number.isNaN(Date.parse(v)) ? v : (/* @__PURE__ */ new Date(0)).toISOString();
const { env } = envWithLocalFallback(process.env, { targetDir: sessionRoot(process.cwd()) });
const auth = createAgentAuth(env);
if (auth.warning !== null) process.stderr.write(auth.warning);
await runWatcher({
	env,
	since,
	fetchImpl: makeSignedFetch(auth.getAuthHeader),
	emit: (e) => process.stdout.write(`${JSON.stringify(e)}\n`),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms))
}).catch((err) => {
	process.stderr.write(`inbox-watch: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.stdout.write(`${JSON.stringify({
		type: "status",
		state: "disabled",
		reason: "crashed"
	})}\n`);
});
process.stdout.write("", () => process.exit(0));

//#endregion
export {  };