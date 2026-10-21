#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";

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
//#region ../synoptic/src/audit/check.js
/** @typedef {{ id: string, state: 'ok'|'warn'|'unknown', text: string, detail?: string }} Check */
/** One check line. `unknown` requires a reason — a hole with no explanation is not reportable. */
function check(id, state, text, detail) {
	if (state === "unknown" && (detail === void 0 || detail === null || detail === "")) throw new Error(`audit check '${id}' is unknown without a reason`);
	return detail === void 0 ? {
		id,
		state,
		text
	} : {
		id,
		state,
		text,
		detail
	};
}

//#endregion
//#region ../synoptic/src/audit/identity.js
/**
* Identity reconciliation.
*
* `resolvedKid` must come from the RUNNING MCP server or from a write's
* `_metadata.createdBy` — never from the auditing process's own environment.
* The auditing shell can lack SUBSTRATE_AGENT_KEY_ID while the MCP child has
* it, because mise exports per-directory into the LAUNCHING shell. An
* audit reading its own env reports "no identity" on a correctly configured box.
*
* @param {{ resolvedKid: string|null, source: string|null, declaredName: string|null,
*           keyFilePresent: boolean|null, directoryKids: ReadonlyArray<string>|null }} p
*/
function auditIdentity({ resolvedKid, source, declaredName, keyFilePresent, directoryKids }) {
	const out = [];
	if (resolvedKid === null) {
		out.push(check("identity.resolved", "unknown", "could not determine the signing identity", "ask the running MCP server or read _metadata.createdBy from a write — never this process’s own env, which does not carry it"));
		return out;
	}
	out.push(check("identity.resolved", "ok", `${resolvedKid} (source: ${source ?? "unknown"})`));
	if (declaredName === null) out.push(check("identity.declared", "unknown", "repo declares no agent name, so the resolved kid cannot be checked", "a derivation with nothing to compare against cannot drift OR be verified"));
	else if (!resolvedKid.startsWith(`${declaredName}@`)) out.push(check("identity.declared", "warn", `repo declares '${declaredName}' but the environment resolved '${resolvedKid}'`, "most often a session launched from a SUBDIRECTORY, which mints an unregistered kid"));
	else out.push(check("identity.declared", "ok", `matches the declared '${declaredName}'`));
	if (keyFilePresent === null) out.push(check("identity.key", "unknown", "key directory not readable", "cannot list ~/.config/substrate/keys"));
	else if (!keyFilePresent) out.push(check("identity.key", "warn", "no key file for this kid", "reads degrade to anonymous — weaker, but not broken"));
	else out.push(check("identity.key", "ok", "key file present"));
	if (directoryKids === null) out.push(check("identity.registered", "unknown", "AgentIdentity directory unreadable", "the server was not reachable, so registration state is unverified"));
	else if (!directoryKids.includes(resolvedKid)) out.push(check("identity.registered", "warn", `'${resolvedKid}' has no AgentIdentity row`, keyFilePresent === true ? "a PRESENT key with an unregistered kid 401s every read and reports as \"substrate offline\". If this kid is deliberately rowless, assert it with an inactive AgentIdentity row carrying intent + expected-live (continuous|per-run) instead of writing a live row." : "half-registered identity. If deliberately rowless, assert it with an inactive AgentIdentity row carrying intent + expected-live instead of writing a live row."));
	else out.push(check("identity.registered", "ok", "registered in the directory"));
	return out;
}
/**
* Is the credential this process signs with the TARGET's credential?
*
* Exported because two sections depend on the answer and must not each derive
* it: `authority` reports the grant, and `recall.available` reports whether
* hybrid recall answers — a per-credential fact, so probing it with the
* auditor's key answers about the auditor.
*
* Both accepted witnesses are TARGET-derived: the kid of the MCP server running
* in the target directory, and the kid the target's own `.mcp.json` pins. The
* auditing process's env is deliberately not one of them.
*/
function credentialIsTargets({ whoami, resolvedKid = null, declaredKid = null }) {
	const subject = whoami?.ok === true && whoami.authenticated === true ? whoami.id ?? null : null;
	if (subject === null) return false;
	return subject === resolvedKid || subject === declaredKid;
}
/**
* What this credential is AUTHORISED to do.
*
* ## The gap this closes
*
* Every other identity check in this file models identity as *key files on disk
* vs `AgentIdentity` rows*. Neither is authority. The _system/Key table is, so a
* decommissioned agent whose key was never revoked still holds a live
* credential, and the file-based checks cannot tell it apart from a revoked one.
*
* Worse, `orphans.keys` keys off key FILES, so deleting a private key — the act
* that feels like decommissioning — makes the audit QUIETER while the credential
* stays live.
*
* ## What this can and cannot see, stated because the boundary matters
*
* whoami is a SELF view. It answers "what does the credential I am signing with
* hold", authoritatively and post-intersection. It cannot enumerate the key
* table, so it does NOT close:
*
*   - a registered _system/Key with no directory row
*   - a retired directory row with a live key, for identities OTHER than this one
*
* Those need admin enumeration and stay open. Claiming otherwise would be the
* same overreach this check exists to catch, so the render says so.
*
* @param {{ whoami: { ok: boolean, authEnabled?: boolean|null,
*                     authenticated?: boolean, id?: string|null,
*                     capabilities?: string[]|null, namespaces?: string[]|null,
*                     grants?: Record<string, string[]>|null,
*                     failed?: string },
*           expectedNamespaces: ReadonlyArray<string>,
*           expectedCapabilities?: Record<string, ReadonlyArray<string>>|null,
*           resolvedKid: string|null, declaredKid: string|null,
*           selfAudit: boolean, authWarning: string|null }} p
*/
function auditAuthority({ whoami, expectedNamespaces = [], expectedCapabilities = null, resolvedKid = null, declaredKid = null, selfAudit = true, authWarning = null }) {
	if (whoami === null || whoami === void 0 || whoami.ok !== true) {
		const reason = whoami?.failed ?? "no whoami probe was run";
		const revoked = /\b401\b/.test(reason);
		return [check("authority.grant", revoked ? "warn" : "unknown", revoked ? "this credential was REJECTED by the server (401)" : "could not ask the server what this credential holds", revoked ? `${reason} — a registered, unrevoked key does not 401. Either this kid was revoked, or the key on disk does not match the registered public key. Reads are degrading to anonymous or failing outright.` : `${reason} — so namespaces and capabilities are unverified. This is the one identity fact the local filesystem and the AgentIdentity directory cannot supply.`)];
	}
	if (whoami.authenticated !== true) {
		if (whoami.authEnabled === false) return [check("authority.grant", "warn", "this server VERIFIES NOTHING — auth is disabled", "every credential here is decorative: writes attribute to whoever claims them, and `_metadata.createdBy` records a claim rather than a signature. Presenting a key would change nothing. This is a deployment posture, so the fix is at the server, not in this repo.")];
		if (whoami.authEnabled === true) {
			const local = typeof authWarning === "string" ? authWarning.trim() : null;
			return [check("authority.grant", "warn", "auth is ENABLED and this request carried no credential — reads are landing anonymously", local === null ? "a present-but-invalid token 401s before this answer, so nothing was rejected: nothing was sent. SUBSTRATE_AGENT_KEY_ID / SUBSTRATE_AGENT_KEY_PATH never took effect for this process. On a reads-open stack an anonymous read and an authenticated one are byte-identical, so this state can persist unnoticed — this is that state, named." : `the signer says why, so this is NOT the env-never-arrived case: ${local}. Both env vars reached this process; the credential itself could not be loaded, so the fix is the key material rather than the wiring. A present-but-invalid token 401s before this answer, so nothing was rejected — nothing was sent.`)];
		}
		return [check("authority.grant", "unknown", "the server resolved no identity for this request", "the server answered without `authEnabled`, a response shape this client does not understand, so it cannot say whether this instance verifies nothing or the probe carried no Authorization header. A present-but-invalid token 401s before that handler runs, so this is NOT evidence that a token was rejected.")];
	}
	const out = [];
	const flatNs = whoami.namespaces;
	const caps = whoami.capabilities;
	const grants = whoami.grants ?? null;
	const ns = flatNs ?? (grants === null ? null : Object.keys(grants).sort());
	if (grants === null && (flatNs === null || caps === null)) {
		out.push(check("authority.grant", "unknown", "whoami answered in a shape this client does not understand", "older servers default namespaces and capabilities to [] in the route, and current ones drop both and send `grants` instead — so on every supported version an absent field with NO `grants` beside it is version skew rather than an empty grant, and reading it as empty would understate authority rather than overstate it. Neither shape that carries `grants` lands here: older servers null `capabilities` on purpose, current ones remove both flat fields, and both put the real answer in `grants`. None arrived."));
		return out;
	}
	const subject = whoami.id ?? null;
	const attributed = credentialIsTargets({
		whoami,
		resolvedKid,
		declaredKid
	});
	if (selfAudit && resolvedKid !== null && subject !== null && subject !== resolvedKid) out.push(check("authority.grant", "warn", `signing as '${subject}' but this repo resolved '${resolvedKid}'`, "every write from this session attributes to the server-side identity, not the one the config names — never borrow another agent’s key"));
	if (!attributed) {
		const claimed = resolvedKid ?? declaredKid;
		out.push(check("authority.grant", "unknown", `read ${ns.includes("*") ? "'*' — EVERY namespace" : ns.join(",") || "no namespace"} (${describeGrant({
			caps,
			grants
		})}) for ${subject === null ? "a credential the server did not name" : `'${subject}'`} — NOT established as this target's`, claimed === null ? "nothing target-derived names whose credential this is: no MCP server is running in the target dir and its .mcp.json pins no SUBSTRATE_AGENT_KEY_ID, so the grant above is whatever credential the AUDIT PROCESS holds. An unresolved subject cannot have a verified authority — pin the kid per repo or run the audit from that repo’s own session." : `this target is '${claimed}', so the grant above belongs to a different identity — the one the AUDIT PROCESS holds. Ask \`substrate-admin list\` for the target’s real grant; nothing readable from here can supply it.`));
		out.push(...tail(whoami));
		return out;
	}
	if (grants !== null) {
		const readless = expectedNamespaces.filter((n) => {
			const held = capabilitiesOn(n, {
				caps,
				grants
			});
			return held.length > 0 && !held.includes("read");
		});
		if (readless.length > 0) {
			out.push(check("authority.grant", "warn", `verified as '${subject}' but holds no \`read\` on ${readless.join(", ")} — every read there is refused (${describeGrant({
				caps,
				grants
			})})`, `this is the state a flat capability list CANNOT express, which is why the server nulls \`capabilities\` rather than rendering the union — the union would say \`read\` because it is held somewhere. Frames against ${readless.join(", ")} return \`{"code":"forbidden","required":"read"}\` while every other namespace answers normally, so the failure is partial and the render looks healthy. Widen the grant with \`substrate-admin\`: an entry is \`<ns>:<cap>+<cap>\`, and an EXPLICIT entry beats a \`*\` entry rather than adding to it, so a narrow entry is not widened by a broad wildcard beside it.`));
			out.push(...tail(whoami));
			return out;
		}
	} else if (!caps.includes("read")) {
		out.push(check("authority.grant", "warn", `verified as '${subject}' but holds ${caps.length === 0 ? "NO capabilities" : `no \`read\` (caps: ${caps.join(",")})`} — every read is refused`, `whoami answers without gating on \`read\`, so this state renders as a healthy identity while \`/substrate/v1/query\` returns \`{"code":"forbidden","required":"read","have":[${caps.map((c) => `"${c}"`).join(",")}]}\`. The namespace grant below is moot until this is fixed. Two causes, and \`substrate-admin list\` tells them apart: the ROW may not grant \`read\`, or the row grants it and our TOKEN CLAIM omitted it — substrate intersects claim against row, so a claim that is a SUBSET of the row silently discards the difference. Widening a row is an operator action; widening the claim is ours. Note \`['*']\` is NOT a valid claim for capabilities — both gates do a bare \`includes\` with no wildcard branch, so a wildcard claim is refused everything.`));
		out.push(...tail(whoami));
		return out;
	}
	if (expectedCapabilities !== null) {
		const lacking = /* @__PURE__ */ new Map();
		for (const [n, needed] of Object.entries(expectedCapabilities)) {
			const held = grants !== null ? capabilitiesOn(n, {
				caps,
				grants
			}) : caps;
			if (held.length === 0) continue;
			for (const cap of needed) {
				if (cap === "read" || held.includes(cap)) continue;
				lacking.set(cap, [...lacking.get(cap) ?? [], n]);
			}
		}
		if (lacking.size > 0) {
			const what = [...lacking].map(([cap, names]) => `no \`${cap}\` on ${names.join(", ")}`);
			out.push(check("authority.grant", "warn", `verified as '${subject}' but holds ${what.join("; ")} — the capability declares it needs them (${describeGrant({
				caps,
				grants
			})})`, "reads succeed, so the session looks healthy, and the first write there is refused with `{\"code\":\"forbidden\"}`: SessionLogs, AnchorIntents and Memory in `cortext`, salience boosts in `recall`. Widen the grant with `substrate-admin`; an entry is `<ns>:<cap>+<cap>`."));
			out.push(...tail(whoami));
			return out;
		}
	}
	if (ns.includes("*")) {
		out.push(check("authority.grant", "warn", `granted '*' — EVERY namespace (${describeGrant({
			caps,
			grants
		})}) — as '${subject}'`, `this identity needs ${expectedNamespaces.length > 0 ? expectedNamespaces.join(",") : "a declared set"}. A wildcard is what \`substrate-admin register\` grants when \`--ns\` is OMITTED, so it is usually inherited rather than chosen.`));
		out.push(...tail(whoami));
		return out;
	}
	const missing = expectedNamespaces.filter((n) => !ns.includes(n));
	if (missing.length > 0) out.push(check("authority.grant", "warn", `missing namespace(s): ${missing.join(", ")} — granted ${ns.join(",")}`, "frames against a missing namespace are rejected per-key with `unauthorized_namespace`; the cold-start degrades rather than failing, so the render looks complete and simply carries a different heading"));
	else out.push(check("authority.grant", "ok", `granted ${ns.join(",")} (${describeGrant({
		caps,
		grants
	})}) — covers what this capability needs, as '${subject}'`));
	out.push(...tail(whoami));
	return out;
}
/**
* What this credential holds ON `name`.
*
* The resolution rule is substrate's `capabilitiesFor`, and it is NOT a union: an
* EXPLICIT entry BEATS the wildcard rather than adding to it. So
* `{'*': ['read'], cortext: ['read','mutate']}` confers exactly `read` on
* `recall` — reading it as `read,mutate` everywhere would over-report the one
* namespace the operator went out of their way to narrow, which is the whole
* reason they wrote two entries.
*
* A flat identity (no `grants` — a file-registry key, or any pre-5.23.0 server)
* has no per-namespace structure to consult, so every namespace confers the
* flat list. That is not an approximation: for a flat grant the two forms are
* the same grant, which is the equivalence substrate pins over a table in
* `test/_system/grant.test.ts`.
*/
function capabilitiesOn(name, { caps, grants }) {
	if (grants === null) return caps ?? [];
	if (Object.hasOwn(grants, name)) return grants[name];
	return Object.hasOwn(grants, "*") ? grants["*"] : [];
}
/**
* The grant, spelled for a human.
*
* Keyed on `caps` rather than on `grants`, and that is the whole point: a
* NON-NULL `caps` is substrate's own assertion that a flat list is honest here, so
* a uniform per-namespace grant keeps rendering `caps: read,mutate` exactly as a
* flat grant does. The
* two-dimensional spelling appears only where one-dimensional would lie.
*
* When it does appear it uses substrate's own `encodeGrant` entry syntax
* (`cortext:read+mutate`), so the line an operator reads here matches the line
* `substrate-admin list` shows them. A second spelling for the same fact would make
* the two impossible to diff by eye, which is the only way anyone checks them.
*/
function describeGrant({ caps, grants }) {
	if (caps !== null && caps !== void 0) return `caps: ${caps.join(",") || "none"}`;
	const entries = Object.entries(grants ?? {}).map(([n, c]) => `${n}:${[...c].sort().join("+")}`);
	return entries.length === 0 ? "grant: NOTHING" : `grant: ${entries.sort().join(" ")}`;
}
function tail() {
	return [fleetCaveat()];
}
/** Never let the self-view read as a fleet audit. This is the caveat for the
*  fleet-wide checks a self view cannot make. `info`, not `unknown`: it is
*  true of every run, so as an unknown it would make the audit exit 1 forever
*  and "Nothing to do" unreachable. */
function fleetCaveat() {
	return check("authority.fleet", "info", "other identities’ credentials are not visible from here", "whoami is a self view. A registered _system/Key with no directory row, or a retired row whose key is still live, needs `substrate-admin list` and stays unchecked — a decommissioned agent can hold a live `*` credential with nothing here showing it");
}

//#endregion
//#region ../synoptic/src/inbox-push.js
/** D5 switches. PUSH defaults on, WAKE defaults OFF (D1 — on only after the live check). */
function readInboxKnobs(env) {
	return {
		push: env.SYNOPTIC_INBOX_PUSH !== "off",
		wake: env.SYNOPTIC_INBOX_WAKE === "on",
		urgentFrom: (env.SYNOPTIC_INBOX_URGENT_FROM ?? "").split(",").map((s) => s.trim()).filter(Boolean)
	};
}

//#endregion
//#region ../synoptic/src/audit/inbox.js
/**
* The inbox push switches (synoptic 2.4.0), as this repo resolves
* them: process env first, then `.claude/settings.local.json`, the same overlay
* the watcher reads when it starts.
*
* A value that is neither of the two the code recognises is the failure worth
* catching. `readInboxKnobs` treats anything but "off" as push ON and anything
* but "on" as wake OFF, so `SYNOPTIC_INBOX_PUSH=false` silently does nothing. The
* audit says so instead.
*
* The urgent allowlist is printed: kids are public directory names, not secrets.
*/
function auditInboxPush({ env }) {
	const knobs = readInboxKnobs(env);
	const out = [];
	const pushRaw = env.SYNOPTIC_INBOX_PUSH;
	if (pushRaw !== void 0 && pushRaw !== "" && pushRaw !== "off" && pushRaw !== "on") out.push(check("inbox.push", "warn", `SYNOPTIC_INBOX_PUSH="${pushRaw}" is not "off", so push stays on`, "only the literal \"off\" disables it"));
	else if (!knobs.push) out.push(check("inbox.push", "ok", "push off (SYNOPTIC_INBOX_PUSH=off)", "mail arrives as summary lines at the prompt and at Stop, as before 2.4.0"));
	else if (!env.SUBSTRATE_AGENT_KEY_ID) out.push(check("inbox.push", "warn", "push on, but no agent identity is wired", "the watcher needs SUBSTRATE_AGENT_KEY_ID to find this repo's inbox, so nothing is pushed"));
	else out.push(check("inbox.push", "ok", "push on: agent mail is delivered mid-turn", "SYNOPTIC_INBOX_PUSH=off is the rollback; it takes effect at the next session start"));
	const wakeRaw = env.SYNOPTIC_INBOX_WAKE;
	if (wakeRaw !== void 0 && wakeRaw !== "" && wakeRaw !== "on" && wakeRaw !== "off") out.push(check("inbox.wake", "warn", `SYNOPTIC_INBOX_WAKE="${wakeRaw}" is not "on", so wake stays off`, "only the literal \"on\" enables it"));
	else out.push(check("inbox.wake", "ok", knobs.wake ? "wake on: idle mail starts a turn (6/hour, 2/thread)" : "wake off: idle mail waits for the next prompt"));
	out.push(knobs.urgentFrom.length === 0 ? check("inbox.urgent", "ok", "urgent preemption off (no SYNOPTIC_INBOX_URGENT_FROM)") : check("inbox.urgent", "ok", `urgent preemption allowed from ${knobs.urgentFrom.length} kid(s): ${knobs.urgentFrom.join(", ")}`, "their priority:urgent mail may stop a running turn (3/hour)"));
	return out;
}

//#endregion
//#region ../synoptic/src/audit/install.js
/**
* How many cached plugin versions is too many.
*
* Not hygiene: every cached directory is a live skill source, and multiple
* plausible answers to "the plugin's copy" sitting side by side is how a
* session ends up on a stale copy. The resolver now chooses
* explicitly, so pruning is belt-and-braces rather than load-bearing — but a
* resolver bug is survivable only if the set of wrong answers is small.
*
* Two: the installed version, plus one to roll back to.
*/
const CACHE_KEEP = 2;
/**
* Plugin-cache reconciliation.
*
* ## Why each fact carries WHY it is missing
*
* As nullable primitives, three inputs here would answer two questions at once
* with one null: "I could not look" and "I looked, and the answer is bad."
* Those are different states in this file's own model — `unknown` versus `warn`
* (see the note at the top) — and collapsing them reports a verified defect as
* a hole:
*
*   installedVersion  null   registry unreadable | no cortext entry | no version field
*   cacheVersions     []     cache dir unreadable | dir read fine and EMPTY
*   servedVersion     null   CLAUDE_PLUGIN_ROOT unset | set, but no readable marker
*
* The left cause of each pair is a genuine hole. The right one is a verified
* bad answer — an unregistered plugin, an empty cache, a served root with no
* fragment — and each was rendering as `????` with a `detail` that ASSERTED the
* left cause. "cache not readable" is simply false about a cache that read
* fine and was empty.
*
* The caller now says which. `audit-entry.js` built the collapse with
* `listOrNull(cacheDir) ?? []` and a bare `catch { }` — the same
* `data[key] ?? []` move the conventions fragment warns about, where the thing
* destroyed is PRESENCE, not emptiness.
*
* All three discriminators default to the unknown-producing value and treat an
* unrecognised value the same way. A caller that stops passing one degrades to
* reporting a hole, never to claiming health.
*
* @param {{ installedVersion: string|null,
*           installedRegistry?: 'unreadable'|'no-entry'|'malformed'|'present',
*           cacheVersions: ReadonlyArray<string>,
*           cacheDir?: 'unreadable'|'readable',
*           servedVersion: string|null,
*           servedRoot?: 'unset'|'set',
*           compare: (a: string, b: string) => number }} p
*/
function auditPlugin({ installedVersion, installedRegistry = "unreadable", cacheVersions, cacheDir = "unreadable", servedVersion, servedRoot = "unset", compare }) {
	const out = [];
	const sorted = [...cacheVersions].sort(compare);
	if (installedVersion !== null) out.push(check("plugin.installed", "ok", `installed ${installedVersion}`));
	else if (installedRegistry === "no-entry") out.push(check("plugin.installed", "warn", "no cortext@mnmal-ai entry in installed_plugins.json", "the registry read fine and does not list this plugin — a hand-dropped copy never meets a package manager, so nothing establishes a downgrade floor and the pin below has nothing to reconcile against"));
	else if (installedRegistry === "malformed") out.push(check("plugin.installed", "warn", "the cortext@mnmal-ai registry entry carries no version", "the entry exists but its `version` is absent — a malformed registry, not a missing install"));
	else out.push(check("plugin.installed", "unknown", "installed version unresolved", "installed_plugins.json could not be read or parsed, so whether this plugin is registered is unknown — distinct from reading it and finding no entry"));
	if (cacheVersions.length > 0 && cacheVersions.length <= 2) out.push(check("plugin.cache", "ok", `cache holds ${cacheVersions.length} version(s)`));
	else if (cacheVersions.length === 0 && cacheDir === "readable") out.push(check("plugin.cache", "warn", "the plugin cache is EMPTY", "the cache directory read fine and holds no version with a readable fragment — every skill source is missing, which is a broken install rather than an unchecked one"));
	else if (cacheVersions.length === 0) out.push(check("plugin.cache", "unknown", "cache not readable", "the plugin cache directory could not be listed, so what it holds is unknown — distinct from listing it and finding it empty"));
	else if (cacheVersions.length > 2) out.push(check("plugin.cache", "warn", `cache holds ${cacheVersions.length} versions (${sorted[0]} … ${sorted[sorted.length - 1]})`, `every one is a live skill source; keep ${2} (installed + one rollback) so a resolver bug has fewer wrong answers available. Fix: node "$CLAUDE_PLUGIN_ROOT/bin/prune-cache.mjs" (dry-run; add --apply to delete)`));
	const rootState = SERVED_ROOT_STATES.has(servedRoot) ? servedRoot : "unrecognised";
	if (servedVersion === null && (rootState === "set" || rootState === "derived-cache")) out.push(check("plugin.served", "warn", rootState === "set" ? "CLAUDE_PLUGIN_ROOT is set but carries no readable fragment marker" : "the plugin directory this audit is running from carries no readable fragment marker", "the serving root was named and looked at, and it has no version to report — a broken or half-written plugin directory, not an unasked question"));
	else if (rootState === "derived-source") out.push(check("plugin.served", "unknown", "this audit is running from a SOURCE TREE, not a plugin install", "so it can report what it is running, but not what served the skill this session is following — those are different trees whenever the source is ahead of the install, which in this repo is most of the time"));
	else if (servedVersion === null) out.push(check("plugin.served", "unknown", "cannot tell which version served this skill", "no serving root could be named or derived, so there is nothing to interrogate — distinct from a root that was found and unreadable"));
	else if (installedVersion !== null && compare(servedVersion, installedVersion) < 0) out.push(check("plugin.served", "warn", `this session was served ${servedVersion}, older than the installed ${installedVersion} — the skill text being followed is RETIRED`, `any instruction in it may have been superseded, and nothing reconciles skill prose the way the resolver reconciles the fragment. Re-read the skill from the installed version before acting on it, and restart the session to rebind CLAUDE_PLUGIN_ROOT.`));
	else out.push(check("plugin.served", "ok", `served ${servedVersion}`));
	return out;
}
/** The serving roots `auditPlugin` recognises. `set` = CLAUDE_PLUGIN_ROOT was
*  present; `derived-cache` = located from this file's own path inside the
*  plugin cache; `derived-source` = located, but in a source checkout.
*  Anything else is a caller error and reports a hole. */
const SERVED_ROOT_STATES = /* @__PURE__ */ new Set([
	"set",
	"derived-cache",
	"derived-source",
	"unset"
]);
/**
* Fragment state, expressed from a resolver result so the audit and the
* installer can never disagree about what "current" means.
*/
function auditFragment(resolution) {
	switch (resolution.action) {
		case "current": return [check("fragment", "ok", `repo is current (${resolution.chosen.digest})`)];
		case "install": return [check("fragment", "warn", "repo fragment differs from the best available", `would install ${resolution.chosen.version}+${resolution.chosen.digest} — run /substrate-setup`)];
		case "skip-source-repo": return [check("fragment", "ok", "this repo SHIPS the fragment; its tree is authoritative")];
		default: return [check("fragment", "unknown", "could not resolve a fragment to compare", resolution.reason)];
	}
}

//#endregion
//#region ../synoptic/src/audit/mcp-json.js
/**
* Is a TRACKED `.mcp.json` still the committable form?
*
* The gitignore rule is conditional on CONTENT rather than on the file's name: a fully-indirected file (pure `${VAR}` refs, public
* `SUBSTRATE_URL` literal) is committed, and one carrying an absolute path, a
* host-pinned kid or a literal secret is ignored.
*
* The rule introduces exactly one failure mode: a file that starts portable and
* STAYS TRACKED while someone edits a machine value into it. The cost lands in
* git history, where it is not retractable.
*
* ## What is deliberately NOT flagged
*
* `${VAR:-default}` is not automatically machine-specific. The skill's own Step
* 4.2 form uses `${SUBSTRATE_AGENT_KEY_ID:-default}`, whose fallback is the FLEET
* default rather than a host-pinned identity. So a kid fallback is flagged only
* when it names a host (`@`), and a path fallback only when it is absolute.
* Flagging every fallback would flag the arrangement this skill recommends.
*
* ## Values are never printed
*
* A `.mcp.json` env block can hold a token. Findings name the FIELD and the
* marker kind, never the value — the same discipline as the identity checks,
* which report a boolean for the key file rather than reading it out.
*
* @param {{ present: boolean|null, tracked: boolean|null,
*           markers: ReadonlyArray<{ field: string, kind: string }>|null }} p
*/
function auditMcpJson({ present, tracked, markers }) {
	if (present === null) return [check("mcp-json", "unknown", "a project .mcp.json exists but could not be read or parsed", "so whether it carries machine-specific values is unknown — distinct from reading it and finding none")];
	if (present === false) return [check("mcp-json", "ok", "no project .mcp.json", "nothing to commit or ignore — this repo uses a user-scope server or none")];
	if (tracked === null || markers === null) return [check("mcp-json", "unknown", "cannot tell whether .mcp.json is tracked", "git could not answer (not a repository, or the command failed), and an untracked-vs-committed distinction is the whole of this check")];
	const named = markers.map((m) => `${m.field} (${m.kind})`).join(", ");
	if (tracked && markers.length > 0) return [check("mcp-json", "warn", `.mcp.json is TRACKED and carries ${markers.length} machine-specific value(s): ${named}`, "the portable form is committed and this one is ignored. Every commit from here puts a machine path or an identity into git history, which is not retractable — either indirect the value through the environment (Step 7.2) or `git rm --cached .mcp.json` and ignore it")];
	if (tracked) return [check("mcp-json", "ok", ".mcp.json is tracked and fully indirected — the committable form")];
	if (markers.length > 0) return [check("mcp-json", "ok", `.mcp.json is ignored and carries machine-specific value(s): ${named} — correctly ignored`)];
	return [check("mcp-json", "ok", ".mcp.json is ignored and carries no machine-specific value", "harmless, but a tracked repo would commit this form: a fresh clone then gets a working server with no setup step")];
}

//#endregion
//#region ../synoptic/src/audit/orphans.js
/**
* Kid/key bindings declared in mise.toml env assignments.
*
* A daemon is never an MCP session, so its kid never appears in any
* `.mcp.json` — `APP_DAEMON_KID`/`APP_DAEMON_KEY` in `mise.toml` is the same
* kind of binding `scanKeyRefs` reads from MCP server env, and the audit must
* consult it before calling a key unowned.
*
* Pure: entries are already read. Groups assignments by their shared stem
* (`FOO_KID` + `FOO_KEY`/`FOO_SIGNING_KEY`), so a binding is only reported
* when the file actually writes it down — an unpaired name is not a binding.
*
* @param {ReadonlyArray<{ path: string, text: string|null }>} entries
* @returns {Array<{ keyName: string, kid: string, source: string }>}
*/
function scanMiseRefs(entries) {
	const out = [];
	for (const { path, text } of entries ?? []) {
		if (typeof text !== "string") continue;
		const env = {};
		for (const line of text.split("\n")) {
			const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']*)["']\s*(?:#.*)?$/.exec(line);
			if (m !== null) env[m[1]] = m[2];
		}
		const groups = /* @__PURE__ */ new Map();
		for (const [name, value] of Object.entries(env)) {
			const m = /^(.*?)_(KID|KEY_ID|SIGNING_KEY|KEY_PATH|KEY|PUB)$/.exec(name);
			if (m === null) continue;
			const g = groups.get(m[1]) ?? {};
			g[m[2] === "KID" || m[2] === "KEY_ID" ? "kid" : "key"] = value;
			groups.set(m[1], g);
		}
		for (const g of groups.values()) {
			if (typeof g.kid !== "string" || !g.kid.includes("@")) continue;
			if (typeof g.key !== "string" || g.key === "" || g.key.includes("$")) continue;
			const keyName = (g.key.split("/").pop() ?? "").replace(/\.(key|pub)$/, "");
			if (keyName !== "") out.push({
				keyName,
				kid: g.kid,
				source: path
			});
		}
	}
	return out;
}
/**
* Kid/key bindings in a repo's `.codex/cortext.local.json` — the
* fourth surface. The Codex skin reads its identity from that file's `env`
* (or from the process env, which no file scan can see), never from
* `.mcp.json`, so without this scan `codex@host-a` would read as unreferenced
* while it signs every Codex session in the repo.
*
* Pure: entries are already read. Only an absolute path into `.config/substrate/keys/`
* counts, matching what the skin itself accepts.
*
* @param {ReadonlyArray<{ path: string, text: string|null }>} entries
* @returns {Array<{ keyName: string, kid: string|null, source: string }>}
*/
function scanCodexRefs(entries) {
	const out = [];
	for (const { path, text } of entries ?? []) {
		if (typeof text !== "string") continue;
		let env;
		try {
			env = JSON.parse(text)?.env;
		} catch {
			continue;
		}
		const key = env?.SUBSTRATE_AGENT_KEY_PATH;
		if (typeof key !== "string" || !key.startsWith("/") || !/\.config\/substrate\/keys\//.test(key)) continue;
		const keyName = (key.split("/").pop() ?? "").replace(/\.(key|pub)$/, "");
		if (keyName === "") continue;
		const kid = env.SUBSTRATE_AGENT_KEY_ID;
		out.push({
			keyName,
			kid: typeof kid === "string" && kid.includes("@") ? kid : null,
			source: path
		});
	}
	return out;
}
/**
* Key bindings written into systemd units — the third surface, after
* `.mcp.json` and `mise.toml`. A daemon's worker can sign with
* `Environment=APP_SUBSTRATE_AGENT_KEY=%h/.config/substrate/keys/app.key`, and
* without this scan the audit would say "nothing signs with these" about it.
*
* Unlike the other two surfaces, a unit often names the key WITHOUT the kid —
* the daemon derives it elsewhere. So a key path alone is reported, with
* `kid: null`: it proves something signs with the key, which is the claim the
* orphan check was getting wrong, while claiming nothing about which kid.
*
* Only values pointing into `.config/substrate/keys/` count; `API_KEY=abc` and
* `SSH_KEY=%h/.ssh/...` are not Substrate bindings.
*
* Pure: entries are already read.
*
* @param {ReadonlyArray<{ path: string, text: string|null }>} entries
* @returns {Array<{ keyName: string, kid: string|null, source: string }>}
*/
function scanSystemdRefs(entries) {
	const out = [];
	for (const { path, text } of entries ?? []) {
		if (typeof text !== "string") continue;
		const env = {};
		for (const line of text.split("\n")) {
			const m = /^\s*Environment\s*=\s*(.*)$/.exec(line);
			if (m === null) continue;
			for (const t of m[1].matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
				const tok = t[1] ?? t[2] ?? t[3] ?? "";
				const eq = tok.indexOf("=");
				if (eq > 0) env[tok.slice(0, eq)] = tok.slice(eq + 1);
			}
		}
		const groups = /* @__PURE__ */ new Map();
		for (const [name, value] of Object.entries(env)) {
			const m = /^(.*?)_(KID|KEY_ID|SIGNING_KEY|KEY_PATH|KEY|PUB)$/.exec(name);
			if (m === null) continue;
			const g = groups.get(m[1]) ?? {};
			if (m[2] === "KID" || m[2] === "KEY_ID") g.kid = value;
			else g.key = value;
			groups.set(m[1], g);
		}
		for (const g of groups.values()) {
			if (typeof g.key !== "string" || !/\.config\/substrate\/keys\//.test(g.key)) continue;
			const keyName = (g.key.split("/").pop() ?? "").replace(/\.(key|pub)$/, "");
			if (keyName === "") continue;
			const kid = typeof g.kid === "string" && g.kid.includes("@") ? g.kid : null;
			out.push({
				keyName,
				kid,
				source: path
			});
		}
	}
	return out;
}
/**
* Drift between the key files on disk and the directory rows.
*
* @param {{ keyNames: ReadonlyArray<string>|null, revokedNames: ReadonlyArray<string>|null,
*           directoryKids: ReadonlyArray<string>|null,
*           activeKids: ReadonlyArray<string>|null,
*           directoryRows: ReadonlyArray<{ kid: string, active: boolean, description: string|null, roaming?: boolean|null }>|null,
*           keyRefs: ReadonlyArray<{ keyName: string, kid: string|null, source: string }>|null,
*           refScanComplete: boolean }} p
*/
function auditOrphans({ keyNames, revokedNames, directoryKids, activeKids = null, directoryRows = null, keyRefs = null, refScanComplete = false }) {
	const out = [];
	if (keyNames === null || directoryKids === null) {
		out.push(check("orphans", "unknown", "cannot cross-check keys against the directory", keyNames === null ? "key directory unreadable" : "directory unreadable"));
		return out;
	}
	const liveKids = activeKids ?? directoryKids;
	const nameMatched = (n) => liveKids.some((k) => k.startsWith(`${n}@`));
	const unmatched = keyNames.filter((n) => !nameMatched(n));
	if (unmatched.length === 0) out.push(check("orphans.keys", "ok", "every key file has a directory row"));
	else if (keyRefs === null || keyRefs === void 0) out.push(check("orphans.keys", "unknown", `${unmatched.length} keypair(s) not matched by name: ${unmatched.join(", ")}`, "no .mcp.json scan available — a key file name is not its identity, so these cannot be called orphans. Re-run with --fleet to establish it."));
	else {
		const asserted = /* @__PURE__ */ new Map();
		if (directoryRows !== null && directoryRows !== void 0) {
			for (const r of directoryRows) if (r?.active === false && typeof r?.kid === "string" && typeof r?.description === "string" && r.description.trim() !== "") asserted.set(r.kid, r.description);
		}
		const isLive = (kid) => activeKids === null || activeKids === void 0 ? directoryKids.includes(kid) : activeKids.includes(kid);
		const refFor = (n) => keyRefs.find((r) => r.keyName === n && r.kid !== null) ?? keyRefs.find((r) => r.keyName === n) ?? null;
		const registered = [];
		const assertedList = [];
		const risky = [];
		const unreferenced = [];
		const kidless = [];
		for (const n of unmatched) {
			const ref = refFor(n);
			if (ref === null) unreferenced.push(n);
			else if (ref.kid === null) kidless.push(`${n} (used by ${ref.source}, kid not stated)`);
			else if (isLive(ref.kid)) registered.push(`${n} -> ${ref.kid}`);
			else if (asserted.has(ref.kid)) assertedList.push(`${n} -> ${ref.kid} (asserted absent by design)`);
			else risky.push(`${n} -> ${ref.kid}`);
		}
		if (risky.length > 0) out.push(check("orphans.keys", "warn", `${risky.length} keypair(s) configured against an unregistered kid: ${risky.join(", ")}`, "a PRESENT key with an unregistered kid 401s every read and reports as \"substrate offline\". If the kid is deliberately rowless (never Claim.author, never receives mail), assert it with an inactive AgentIdentity row carrying intent + expected-live (continuous|per-run) instead of writing a live row."));
		else if (unreferenced.length > 0) out.push(refScanComplete ? check("orphans.keys", "warn", `${unreferenced.length} keypair(s) unreferenced by any scanned config (.mcp.json, mise.toml, .codex/cortext.local.json, systemd user units): ` + unreferenced.join(", "), "no scanned config signs with these, so none of those can 401 on them — but a key used through a tool (e.g. an operator key a CLI enrolment writes) or by a process started some other way is invisible to a config scan. Confirm via `substrate-admin list` that no live credential depends on one before retiring it; a file scan cannot see revocation state, so retiring on this finding alone is unsound.") : check("orphans.keys", "unknown", `${unreferenced.length} keypair(s) not matched by name and not referenced here: ` + unreferenced.join(", "), "only this repo's configs were read — the repo that signs with one of these may not have been scanned. Re-run with --fleet before treating it as unowned."));
		else {
			const bits = [`every key file is accounted for (${[...registered, ...kidless].join(", ")})`];
			if (assertedList.length > 0) bits.push(`asserted absent by design: ${assertedList.join(", ")}`);
			out.push(check("orphans.keys", "ok", bits.join("; "), assertedList.length > 0 ? "asserted kids hold inactive, intent-documented directory rows (expected liveness per row description) — visible here rather than silently exonerated" : void 0));
		}
	}
	if (revokedNames !== null && revokedNames.length > 0) out.push(check("orphans.revoked", "warn", `${revokedNames.length} revoked keypair(s) still on disk: ${revokedNames.join(", ")}`, "harmless but indistinguishable from a live key at a glance"));
	const roamingKids = new Set((directoryRows ?? []).filter((r) => r?.roaming === true).map((r) => r.kid));
	const liveGroups = sameNameDifferentHost(activeKids ?? directoryKids);
	const isRoamingGroup = (g) => g.every((k) => roamingKids.has(k));
	const dupes = liveGroups.filter((g) => !isRoamingGroup(g));
	const roamingPairs = liveGroups.filter(isRoamingGroup);
	const roamingNote = roamingPairs.length > 0 ? ` (roaming, one per host by design: ${roamingPairs.map((g) => g.join(" / ")).join(" | ")})` : "";
	out.push(dupes.length === 0 ? check("orphans.hosts", "ok", `no LIVE agent name registered against two hosts${roamingNote}`) : check("orphans.hosts", "warn", `${dupes.length} name(s) on multiple hosts: ${dupes.map((c) => c.join(" / ")).join(" | ")}`, "expected if the agent genuinely runs on both; otherwise the host is being derived inconsistently (hostname -s on one path, a hardcoded value on another)"));
	if (activeKids !== null) {
		const retiredPairs = sameNameDifferentHost(directoryKids).filter((group) => !liveGroups.some((d) => d.join() === group.join()));
		if (retiredPairs.length > 0) out.push(check("orphans.retired", "ok", `${retiredPairs.length} name(s) with a retired host counterpart: ${retiredPairs.map((g) => g.join(" / ")).join(" | ")}`, "one live identity plus one deactivated — the normal end state of a host migration, and nothing to do"));
	}
	return out;
}
/**
* One agent NAME registered against more than one host.
*
* ## Why this is not a host-casing check
*
* Two registrations of one agent can differ by more than case:
*
*     peer-claude@laptop-b   active=true
*     peer-claude@laptop     active=false
*
* A case-insensitive check finds nothing there. A typical cause is
* `hostname -s` on one path against a hardcoded host in a template on another.
*
* So the invariant checked is the broader and actually-true one: one name, more
* than one host. Case-only variants are a subset and still caught.
*
* This can legitimately fire for an agent genuinely running on two machines, so
* it reports rather than accuses — the operator knows whether two hosts are two
* machines and the audit does not.
*
* @param {ReadonlyArray<string>} kids
* @returns {Array<Array<string>>} groups of kids sharing a name half.
*/
function sameNameDifferentHost(kids) {
	const byName = /* @__PURE__ */ new Map();
	for (const k of kids) {
		const at = k.lastIndexOf("@");
		if (at <= 0) continue;
		const name = k.slice(0, at);
		const set = byName.get(name) ?? /* @__PURE__ */ new Set();
		set.add(k);
		byName.set(name, set);
	}
	return [...byName.values()].filter((s) => s.size > 1).map((s) => [...s].sort());
}

//#endregion
//#region ../synoptic/src/audit/recall.js
/**
* Does the salient tier actually RANK SEMANTICALLY — right now, on this box?
*
* ## Why a live read rather than the cold-start's boost result
*
* The audit runs in a separate process from the cold-start and never has a
* boost result to read. So this asks the question the other way round. Instead
* of reporting
* on a write that happened elsewhere, it performs the READ half live and checks
* whether the ranker's inputs are actually obtainable. That is a measurement of
* the current box rather than a claim about a past run, and — boost-on-fetch
* being opt-in — fetching vectors writes nothing, so it belongs in a read-only
* mode.
*
* ## Why "wired" was never the question
*
* `rankRules` short-circuits to structural when either the anchor vector or the
* rule vectors are missing, and returns a perfectly good structural ranking
* when it does. Nothing downstream can tell the two apart: a signed call the
* server refuses, swallowed by design, leaves every instrument individually
* correct while the feature is dead.
*
* So the assertion has to be about EFFECT, not configuration. Same distinction
* as `applied` against `requested`, and as frame PRESENCE against emptiness.
*
* @param {{ probe: { vectors: Map<string, number[]>, failed: string|null },
*           activeRuleIds: ReadonlyArray<string>,
*           anchorId: string|null }} p
*   `probe.failed` carries the server's own reason when the fetch could not be
*   performed, and null when it was. An empty `vectors` map with `failed: null`
*   is a real answer — nothing is embedded — and must not read as a hole.
*/
function auditSalientTier({ probe, activeRuleIds, anchorId, anchorHistory = null }) {
	if (probe.failed !== null) return [check("salient.rank", "unknown", "could not fetch rule vectors, so whether ranking is semantic is unknown", `${probe.failed} — the fetch fails, the ranker silently falls back to structural, and the render looks fine`)];
	const out = [];
	const withVector = activeRuleIds.filter((id) => probe.vectors.has(id));
	const unembedded = activeRuleIds.filter((id) => !probe.vectors.has(id));
	if (activeRuleIds.length === 0) {
		out.push(check("salient.rank", "unknown", "no active rules to rank", "nothing to measure — an empty rule set cannot demonstrate that ranking works"));
		return out;
	}
	const anchorVectorPresent = anchorId !== null && probe.vectors.has(anchorId);
	if (withVector.length > 0 && anchorVectorPresent) out.push(check("salient.rank", "ok", `ranking is SEMANTIC: ${withVector.length}/${activeRuleIds.length} rules and the anchor both have vectors`));
	else if (anchorId === null) {
		const base = "rankRules needs an anchor vector to score against — with none, the semantic half cannot run even when every rule is embedded";
		const notPlaceholder = "Write a real one describing what this repo is actually for; a placeholder is worse than none, because the ranker scores against the anchor’s own vector and would then rank against noise instead of falling back honestly";
		if (anchorHistory === "none") out.push(check("salient.rank", "warn", "this project has NEVER had an anchor, so ranking falls back to structural", `${base}. /substrate-setup does not seed one, so this is an outstanding onboarding step rather than a fault. ${notPlaceholder}`));
		else if (anchorHistory === "archived") out.push(check("salient.rank", "warn", "every anchor for this project is ARCHIVED, so ranking falls back to structural", `${base}. This repo had an anchor and retired it — the focus it described is over and nothing replaced it. ${notPlaceholder}`));
		else out.push(check("salient.rank", "warn", "no anchor, so ranking falls back to structural regardless of the rule vectors", `${base} — and whether this project ever had one was not established, so it is unclear if this is a fresh repo or a retired focus`));
	} else if (!anchorVectorPresent) out.push(check("salient.rank", "warn", "the anchor has no embedding row, so ranking falls back to structural", "the whole rule set can be embedded and this still short-circuits — the anchor is the other half of the comparison, and it is the half nobody thinks to check"));
	else out.push(check("salient.rank", "warn", `no active rule has an embedding row (0/${activeRuleIds.length}), so ranking is structural-only`, "the corpus was never embedded, or the embed hook is not running for AgentRule"));
	if (unembedded.length > 0 && withVector.length > 0) out.push(check("salient.embedded", "warn", `${unembedded.length} active rule(s) have NO embedding row: ${unembedded.join(", ")}`, "a rule that exists but was never embedded can still be promoted and can never be ranked semantically — it sits in the structural half invisibly"));
	return out;
}
/**
* Is semantic recall reachable at all?
*
* One line. The cold-start
* already renders the answer — `## Agent Memory (hybrid recall — RRF, unified)`
* when recall answers, `## Agent Memory (from <ns>/Memory — N total, M top)`
* when it does not — but nobody reads the heading.
*
* A degradation path that is correct, silent, and permanent is indistinguishable
* from working software. The only fix is an instrument that states which branch
* was taken, rather than one that reports faults.
*
* ## Why this needs `reachable` and cannot infer it
*
* `recall` returns null for a refusal AND for an unreachable server — the
* two are deliberately merged there, because a cold-start's response to both is
* the same: degrade to structural. An audit's response is NOT the same. "Recall
* does not answer" is a verified fault; "the server is down" is a check that
* could not run, and this module's one rule is that those must never render
* alike. Reported as a warn on an unreachable box, this line would assert a
* defect it never observed — the false-confidence bug inverted, which is no
* better for being loud instead of quiet.
*
* With the server up this branch is unreachable, so test it against a dead
* port.
*
* @param {{ answered: boolean, reachable: boolean, reason: string|null }} p
*/
function auditSemanticRecall({ answered, reachable, reason, credentialAttributed = true }) {
	if (!credentialAttributed) return [check("recall.available", "unknown", "recall was probed with a credential that is not established as this target’s", "whether hybrid recall answers depends on the asking credential’s namespace grant, so this probe answers for the auditor. See the authority section — the same substitution, one section up.")];
	if (answered) return [check("recall.available", "ok", "semantic recall answers — Agent Memory renders hybrid")];
	if (!reachable) return [check("recall.available", "unknown", "could not reach the server, so whether recall answers is unknown", `${reason ?? "no reason given"} — an unreachable server is a check that did not run, not a recall fault`)];
	return [check("recall.available", "warn", "semantic recall does NOT answer — Agent Memory silently degrades to structural", `${reason ?? "no reason given"} — this is a correct, silent, permanent fallback, which is why it went unnoticed: the render looks complete and simply carries a different heading`)];
}

//#endregion
//#region ../synoptic/src/audit/render.js
const MARKER = {
	ok: "ok  ",
	warn: "WARN",
	unknown: "????",
	info: "note"
};
/**
* Render the report.
*
* The summary counts `unknown` separately and never folds it into either side —
* see the note at the top of this file. A report that said "3 ok, 0 warnings"
* while four checks never ran is the bug this audit exists to find.
*/
function renderAudit(groups) {
	const lines = ["# /substrate-setup --audit — read-only reconciliation", ""];
	let ok = 0;
	let warn = 0;
	let unknown = 0;
	for (const [title, checks] of groups) {
		lines.push(`## ${title}`);
		lines.push("");
		for (const c of checks) {
			if (c.state === "ok") ok++;
			else if (c.state === "warn") warn++;
			else if (c.state !== "info") unknown++;
			lines.push(`  [${MARKER[c.state]}]  ${c.text}`);
			if (c.detail) lines.push(`          ${c.detail}`);
		}
		lines.push("");
	}
	lines.push("---");
	lines.push("");
	if (warn === 0 && unknown === 0) lines.push(`**${ok} checks passed.** Nothing to do.`);
	else {
		const parts = [`${ok} ok`];
		if (warn > 0) parts.push(`**${warn} needing attention**`);
		if (unknown > 0) parts.push(`**${unknown} NOT VERIFIED**`);
		lines.push(parts.join(", "));
		if (unknown > 0) {
			lines.push("");
			lines.push("> A `????` is a hole in this audit, not a pass. It means the check could not run — which is the same failure mode the audit exists to catch, one level up. Treat it as unresolved, never as \"probably fine\".");
		}
	}
	lines.push("");
	lines.push("*Nothing above was written. This mode only reads.*");
	return lines.join("\n");
}

//#endregion
//#region ../synoptic/src/fleet-fragments.js
/** `<!-- substrate-conventions vsynoptic-1.11.0+cd38093c ... -->` */
const MARKER_RE$1 = /^<!-- substrate-conventions vsynoptic-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+([0-9a-f]{8}))?/;
/**
* Split a fragment the way the stamper does: line 1 is the marker, everything
* after it is what the digest covers. Excluding the marker keeps the digest
* from being self-referential.
*
* @returns {{ version: string, claimed: string|null, body: string }|null}
*   null when line 1 is not a marker — a structurally broken file.
*/
function readFragment(text) {
	const s = String(text ?? "");
	const nl = s.indexOf("\n");
	if (nl === -1) return null;
	const m = MARKER_RE$1.exec(s.slice(0, nl));
	if (m === null) return null;
	return {
		version: m[1],
		claimed: m[2] ?? null,
		body: s.slice(nl + 1)
	};
}
/**
* The comparable form of a hostname. Hostnames differ in case across the fleet
* (`host-a` vs `Host-A`), and a resolver may append a domain.
*/
function normaliseHost(host) {
	return String(host ?? "").trim().toLowerCase().split(".")[0];
}
/**
* Which scanned repos are WORKED ON THIS HOST.
*
* `--fleet` surveys every checkout on local disk, and a disk can hold copies
* nobody works in. A stale scratch tree reported as drifted gets "fixed" while
* the real checkout on another host stays untouched.
*
* The directory already holds the answer: every active `AgentIdentity` row
* carries `project` and `host`. A repo counts only when its project's agent
* runs HERE. A repo worked elsewhere, or claimed by no row, is excluded and
* reported as unknown rather than ok or warn: this box cannot see the copy
* that matters.
*
* An unreadable directory is unknown for the WHOLE host and `here` is empty.
* Falling back to "everything on disk is local" is the defect itself.
*
* Says WHERE a project is worked, not what is installed there.
*
* @param {object} p
* @param {ReadonlyArray<string>} p.repoNames scanned repo dir names (= project)
* @param {string|null} p.thisHost
* @param {ReadonlyArray<{kid?: string, active?: boolean, project?: string|null,
*   host?: string|null}>|null} p.directoryRows null = the directory could not be read
* @returns {{ placed: boolean, here: string[], elsewhere: Array<{name: string, hosts: string[]}>,
*   unclaimed: string[], findings: Array<{id: string, state: string, text: string,
*   detail?: string}> }}
*/
function scopeFleetToHost({ repoNames, thisHost, directoryRows }) {
	const here = [];
	const elsewhere = [];
	const unclaimed = [];
	const findings = [];
	const self = normaliseHost(thisHost);
	if (directoryRows === null || directoryRows === void 0 || self === "") {
		findings.push({
			id: "fleet.population",
			state: "unknown",
			text: self === "" ? "this host's name could not be resolved, so no repo could be placed" : "the AgentIdentity directory could not be read, so no repo could be placed",
			detail: `${repoNames.length} local checkout(s) were NOT surveyed. Which of them are worked on this host is unknown, and surveying them all as local is the failure this check exists to prevent`
		});
		return {
			placed: false,
			here,
			elsewhere,
			unclaimed,
			findings
		};
	}
	const hostsOf = /* @__PURE__ */ new Map();
	for (const r of directoryRows) {
		if (r.active === false || typeof r.project !== "string" || r.project === "") continue;
		const at = typeof r.kid === "string" ? r.kid.lastIndexOf("@") : -1;
		const host = r.host ?? (at > 0 ? r.kid.slice(at + 1) : null);
		if (host === null || host === "") continue;
		const set = hostsOf.get(r.project) ?? /* @__PURE__ */ new Map();
		set.set(normaliseHost(host), host);
		hostsOf.set(r.project, set);
	}
	for (const name of repoNames) {
		const hosts = hostsOf.get(name);
		if (hosts === void 0) unclaimed.push(name);
		else if (hosts.has(self)) here.push(name);
		else elsewhere.push({
			name,
			hosts: [...hosts.values()].sort()
		});
	}
	if (elsewhere.length > 0) findings.push({
		id: "fleet.elsewhere",
		state: "unknown",
		text: `${elsewhere.length} local cop${elsewhere.length === 1 ? "y is of a repo" : "ies are of repos"} worked on another host, not counted: ${elsewhere.map((e) => `${e.name} (worked on ${e.hosts.join(", ")})`).join(", ")}`,
		detail: "these local copies are not the ones that matter, and this box cannot see the ones that do. Run --fleet on that host to audit them; do not fix the fragment here"
	});
	if (unclaimed.length > 0) findings.push({
		id: "fleet.unclaimed",
		state: "unknown",
		text: `${unclaimed.length} repo(s) claimed by no active AgentIdentity, not counted: ${unclaimed.join(", ")}`,
		detail: "the directory cannot say where these are worked. Register the agent (or reactivate its row) and they will be placed"
	});
	return {
		placed: true,
		here,
		elsewhere,
		unclaimed,
		findings
	};
}
/**
* Reconcile fragments across repos.
*
* Pure: every file has already been read. `digest` is injected so this module
* needs no node built-ins, matching the other classifiers here.
*
* @param {object} p
* @param {ReadonlyArray<{name: string, text: string|null}>} p.repos
*   One per repo holding a `.claude/substrate-conventions.md`. `text: null` means
*   the file could not be read, which is reported, not skipped.
* @param {string|null} p.best The best available fragment text (the plugin's
*   own copy), or null when it could not be resolved.
* @param {(input: string) => string} p.digest
* @param {{releasedInHistory?: boolean|null, branch?: string|null,
*   defaultBranch?: string|null, behindUpstream?: number|null}} [p.sourceGit]
*   Git facts about the source repo's checkout, read by the caller.
*   `releasedInHistory` is whether the RELEASED body's marker appears anywhere
*   in its history: `false` = a stale clone that never received it, `null` =
*   git could not say. Omitted entirely, nothing is claimed about git.
* @param {{elsewhere: number, unclaimed: number}} [p.population] Set when the
*   repos were scoped to this host; the spread line then states the
*   population it counted and what it left out.
* @param {ReadonlyArray<string>} [p.missing] Repos the directory places on this
*   host that hold NO fragment. Placed means an agent opted in, so these
*   are gaps; the caller leaves unplaced checkouts out.
* @returns {{ rows: Array<object>, findings: Array<{id: string, state: string,
*   text: string, detail?: string}> }}
*/
function auditFleetFragments({ repos, best, digest, sourceRepo = null, sourceGit, population, missing = [] }) {
	const bestFragment = best === null || best === void 0 ? null : readFragment(best);
	const bestDigest = bestFragment === null ? null : digest(bestFragment.body);
	const rows = repos.map(({ name, text, committed }) => {
		const isSource = sourceRepo !== null && name === sourceRepo;
		if (text === null || text === void 0) return {
			name,
			isSource,
			readable: false
		};
		const f = readFragment(text);
		if (f === null) return {
			name,
			isSource,
			readable: true,
			parsed: false
		};
		const computed = digest(f.body);
		return {
			name,
			isSource,
			readable: true,
			parsed: true,
			version: f.version,
			claimed: f.claimed,
			computed,
			markerHonest: f.claimed === null ? null : f.claimed === computed,
			matchesBest: bestDigest === null ? null : computed === bestDigest,
			committed: committed === void 0 || committed === null ? committed : readFragment(committed)
		};
	});
	const findings = [];
	const parsed = rows.filter((r) => r.parsed === true);
	const reposWord = population === void 0 ? "repos" : "repos worked here";
	const left = population === void 0 ? 0 : population.elsewhere + population.unclaimed;
	const leftOut = left === 0 ? "" : ` (${left} local cop${left === 1 ? "y" : "ies"} of repos not worked here not counted)`;
	const unreadable = rows.filter((r) => r.readable === false).map((r) => r.name);
	if (unreadable.length > 0) findings.push({
		id: "fleet.unreadable",
		state: "unknown",
		text: `${unreadable.length} repo fragment(s) could not be read: ${unreadable.join(", ")}`,
		detail: "these are not counted in the spread below, so the spread is a floor"
	});
	if (missing.length > 0) findings.push({
		id: "fleet.missing",
		state: "warn",
		text: `${missing.length} repo(s) worked here have no conventions fragment: ${[...missing].sort().join(", ")}`,
		detail: "each has an active agent on this host, so it opted in and is reading none of the conventions. Run /substrate-setup in each to install the fragment and its CLAUDE.md import"
	});
	const unparsed = rows.filter((r) => r.readable === true && r.parsed !== true).map((r) => r.name);
	if (unparsed.length > 0) findings.push({
		id: "fleet.unparsed",
		state: "warn",
		text: `${unparsed.length} fragment(s) have no marker on line 1: ${unparsed.join(", ")}`,
		detail: "a fragment with no marker cannot be compared or updated by digest — it was hand-created or truncated"
	});
	const byDigest = /* @__PURE__ */ new Map();
	for (const r of parsed) {
		const set = byDigest.get(r.computed) ?? [];
		set.push(r.name);
		byDigest.set(r.computed, set);
	}
	if (byDigest.size > 1) {
		const groups = [...byDigest.entries()].sort((a, b) => b[1].length - a[1].length).map(([d, names]) => `${d}: ${names.join(", ")}`);
		const consumerDigests = new Set(parsed.filter((r) => !r.isSource).map((r) => r.computed));
		const sourceRow = parsed.find((r) => r.isSource) ?? null;
		const onlySourceDiffers = sourceRow !== null && byDigest.size === 2 && consumerDigests.size === 1 && !consumerDigests.has(sourceRow.computed);
		findings.push({
			id: "fleet.spread",
			state: "warn",
			text: `${parsed.length} ${reposWord} hold ${byDigest.size} DISTINCT fragment bodies${leftOut}`,
			detail: onlySourceDiffers ? sourceGit?.releasedInHistory === false ? `every consumer agrees; the difference is ${sourceRow.name}, whose checkout is BEHIND the release — a stale clone of the shipping repo, not a propagation failure. ${groups.join(" | ")}` : `every consumer agrees; the difference is ${sourceRow.name}, which SHIPS the fragment and leads the release until it is published — propagation is not implicated. ${groups.join(" | ")}` : `the propagation mechanism is not reaching every consumer — ${groups.join(" | ")}`
		});
	} else if (parsed.length > 0) findings.push({
		id: "fleet.spread",
		state: "ok",
		text: `all ${parsed.length} ${reposWord} hold the same fragment body${leftOut}`
	});
	const uncommitted = parsed.filter((r) => r.committed !== void 0 && r.committed !== null && digest(r.committed.body) !== r.computed);
	if (uncommitted.length > 0) findings.push({
		id: "fleet.uncommitted",
		state: "warn",
		text: `${uncommitted.length} repo(s) have an UNCOMMITTED fragment: ${uncommitted.map((r) => `${r.name} (working tree ${r.version}, HEAD ${r.committed.version})`).join(", ")}`,
		detail: "the install was never committed, so this audit sees it and a fresh clone does not. Commit the fragment in each — until then the repo an agent works in and the repo the team shares disagree"
	});
	const dishonest = parsed.filter((r) => r.markerHonest === false);
	if (dishonest.length > 0) findings.push({
		id: "fleet.marker",
		state: "warn",
		text: `${dishonest.length} fragment(s) have a marker that does not match their own body: ${dishonest.map((r) => `${r.name} (claims ${r.claimed}, is ${r.computed})`).join(", ")}`,
		detail: "hand-edited or partially written. Every digest comparison against these — including the cold-start drift check — is reading a claim rather than the content"
	});
	if (bestDigest === null) findings.push({
		id: "fleet.current",
		state: "unknown",
		text: "no plugin fragment available to compare against",
		detail: "the spread above is still meaningful — repos disagreeing with each other is a finding regardless of which is right"
	});
	else {
		const behind = parsed.filter((r) => r.matchesBest === false && !r.isSource);
		const sourceAhead = parsed.find((r) => r.isSource && r.matchesBest === false) ?? null;
		if (parsed.filter((r) => !r.isSource).length > 0 || behind.length > 0) findings.push(behind.length === 0 ? {
			id: "fleet.current",
			state: "ok",
			text: `all consumer repos match the available ${bestDigest}`
		} : {
			id: "fleet.current",
			state: "warn",
			text: `${behind.length} consumer repo(s) do not match the available ${bestDigest}: ${behind.map((r) => `${r.name} (${r.version}+${r.computed})`).join(", ")}`,
			detail: "remedy is one command per repo: bin/resolve-fragment.mjs --target-dir <repo> --apply. It refuses a downgrade and skips the repo that ships the fragment"
		});
		const direction = sourceGit?.releasedInHistory;
		if (sourceAhead !== null && direction === false) findings.push({
			id: "fleet.source",
			state: "warn",
			text: `${sourceAhead.name} SHIPS the fragment but its checkout is BEHIND the released ${bestDigest} (${sourceAhead.version}+${sourceAhead.computed}) — the released body is nowhere in its history`,
			detail: "a stale clone of the shipping repo reads exactly like unpublished work. Pull it, and check out the default branch, before trusting any source-vs-release comparison — until then this tree is not authoritative"
		});
		else if (sourceAhead !== null && direction === null) findings.push({
			id: "fleet.source",
			state: "unknown",
			text: `${sourceAhead.name} SHIPS the fragment and differs from the released ${bestDigest} (${sourceAhead.version}+${sourceAhead.computed})`,
			detail: "git could not say whether the released body is in its history, so this cannot tell an unpublished edit (ahead) from a stale clone (behind). Check `git log` on the fragment before acting on either reading"
		});
		else if (sourceAhead !== null) findings.push({
			id: "fleet.source",
			state: "ok",
			text: `${sourceAhead.name} SHIPS the fragment and differs from the released ${bestDigest} (${sourceAhead.version}+${sourceAhead.computed})`,
			detail: "expected between editing the fragment and publishing it — its tree is authoritative, so this is the release trailing the source rather than the source drifting. It reaches consumers on the next release + /substrate-setup, and NOT before: a version-only bump leaves the digest unchanged and prompts nobody"
		});
	}
	const sourceName = sourceRepo;
	if (sourceName !== null && sourceGit !== void 0 && sourceGit !== null) {
		const { branch = null, defaultBranch = null, behindUpstream = null } = sourceGit;
		if (typeof behindUpstream === "number" && behindUpstream > 0) findings.push({
			id: "fleet.source-checkout",
			state: "warn",
			text: `${sourceName} checkout is ${behindUpstream} commit(s) behind its upstream${branch ? ` (on ${branch})` : ""}`,
			detail: "every source-side reading in this block is taken from that stale tree. Pull it before trusting them"
		});
		else if (branch !== null && defaultBranch !== null && branch !== defaultBranch) findings.push({
			id: "fleet.source-checkout",
			state: "ok",
			text: `${sourceName} checkout is on ${branch}, not ${defaultBranch} — source-side readings are against that branch`
		});
	}
	return {
		rows,
		findings
	};
}

//#endregion
//#region ../synoptic/src/fragment-resolve.js
/**
* Parse `1.9.0` or `1.0.0-alpha.3` into `[major, minor, patch, ...prerelease]`,
* numeric prerelease identifiers as numbers. Returns null for anything else.
*/
function parseVersion(text) {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(String(text ?? "").trim());
	if (m === null) return null;
	const pre = m[4] === void 0 ? [] : m[4].split(".").map((id) => /^\d+$/.test(id) ? Number(id) : id);
	return [
		Number(m[1]),
		Number(m[2]),
		Number(m[3]),
		...pre
	];
}
/**
* Compare two version strings. Unparseable sorts below everything, so a
* malformed directory name can never win a "highest available" contest.
*
* @returns {number} negative if a < b, 0 if equal, positive if a > b.
*/
function compareVersions(a, b) {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (pa === null && pb === null) return 0;
	if (pa === null) return -1;
	if (pb === null) return 1;
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
	if (pa.length === 3 || pb.length === 3) return pb.length - pa.length;
	for (let i = 3; i < Math.min(pa.length, pb.length); i++) {
		const x = pa[i];
		const y = pb[i];
		if (x === y) continue;
		if (typeof x === "number" && typeof y === "number") return x - y;
		if (typeof x === "number") return -1;
		if (typeof y === "number") return 1;
		return x < y ? -1 : 1;
	}
	return pa.length - pb.length;
}
/**
* Is this repo the SOURCE of the fragment rather than a consumer of it?
*
* synoptic ships `packages/cortext-plugin/fragments/substrate-conventions.md` and
* CLAUDE.md is explicit that when the repo and a plugin cache disagree, the
* repo wins. Installing over it from a cache would discard whatever the working
* tree has that the last release does not — which is exactly the state a repo
* is in while authoring a fragment change.
*
* Detected by the file's presence rather than by repo name, so a fork or a
* rename cannot silently turn the source into a consumer.
*
* @param {{ cwd: string, exists: (p: string) => boolean }} opts
*/
function isFragmentSourceRepo({ cwd, exists }) {
	return exists(`${cwd}/packages/cortext-plugin/fragments/substrate-conventions.md`);
}
/**
* Decide which fragment to install, or refuse and say why.
*
* Pure: every filesystem fact is passed in, so the whole decision table is
* testable without a plugin cache on disk.
*
* @param {object} opts
* @param {ReadonlyArray<{version: string, path: string, origin: string}>} opts.candidates
*   Every fragment this machine could install, already read off disk.
* @param {string|null} opts.installedVersion From `installed_plugins.json`.
* @param {string|null} opts.servedVersion The version that served the skill
*   (`CLAUDE_PLUGIN_ROOT`), for reporting a stale serving root.
* @param {{version: string, digest: string|null}|null} opts.installedFragment
*   The marker currently in the consumer repo, or null when absent.
* @param {boolean} [opts.isSourceRepo=false]
* @returns {{
*   action: 'install'|'current'|'refuse'|'skip-source-repo',
*   chosen: object|null,
*   reason: string|null,
*   report: Array<string>
* }}
*/
function resolveFragmentSource(opts) {
	const { candidates = [], installedVersion = null, servedVersion = null, installedFragment = null, isSourceRepo = false } = opts;
	const report = [];
	const newest = [...candidates].sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
	report.push(`installed:      ${installedVersion ?? "(unknown)"}`);
	report.push(`served skill:   ${servedVersion ?? "(unknown)"}` + (servedVersion !== null && installedVersion !== null && compareVersions(servedVersion, installedVersion) < 0 ? "   <- STALE: bound at session start, before the install" : ""));
	report.push(`cache holds:    ${candidates.length} version(s)` + (candidates.length > 0 ? ` (newest ${newest.version}, oldest ${[...candidates].sort((a, b) => compareVersions(a.version, b.version))[0].version})` : ""));
	report.push(`repo has:       ${installedFragment === null ? "(none — not yet a consumer)" : `v${installedFragment.version}+${installedFragment.digest ?? "(no digest)"}`}`);
	if (isSourceRepo) return {
		action: "skip-source-repo",
		chosen: null,
		reason: "this repo SHIPS the fragment (packages/cortext-plugin/fragments/) — its working tree is the authority and may legitimately be ahead of the last release. Installing over it from a plugin cache would discard unreleased edits.",
		report
	};
	if (newest === null) return {
		action: "refuse",
		chosen: null,
		reason: "no fragment found in any plugin directory. Nothing was written — a missing source is a broken install, not a reason to leave the repo untouched silently.",
		report
	};
	const atInstalled = installedVersion === null ? null : candidates.find((c) => compareVersions(c.version, installedVersion) === 0) ?? null;
	const chosen = atInstalled ?? newest;
	if (installedFragment !== null && compareVersions(chosen.version, installedFragment.version) < 0) return {
		action: "refuse",
		chosen: null,
		reason: `the repo already holds v${installedFragment.version}, NEWER than the best available v${chosen.version}. Installing would revert it. This machine's plugin cache is behind whatever produced the repo copy — refresh it rather than overwriting. (If the repo marker is genuinely wrong, delete the file and re-run; an absent copy has nothing to downgrade.)`,
		report
	};
	if (installedVersion !== null && compareVersions(chosen.version, installedVersion) < 0) return {
		action: "refuse",
		chosen: null,
		reason: `the best available fragment is v${chosen.version}, BELOW the installed v${installedVersion}. Installing it would be a downgrade — Step 3's "do not gate on the version being newer" rule is about digests within a version, and must not be read as permission to go backwards. Refresh the plugin cache and re-run.`,
		report
	};
	if (installedVersion !== null && atInstalled === null && compareVersions(newest.version, installedVersion) > 0) report.push(`note:           cache is AHEAD of the install (${newest.version} > ${installedVersion}); using it, but nothing has validated it as this machine’s version`);
	if (installedFragment !== null && installedFragment.digest === chosen.digest) return {
		action: "current",
		chosen,
		reason: null,
		report
	};
	return {
		action: "install",
		chosen,
		reason: null,
		report
	};
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
/** A directory's entries as Dirents, or null when unreadable. Never throws. */
function listOrNull(path) {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch {
		return null;
	}
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
//#region ../synoptic/src/marketplace-pin.js
/** `v1.10.0` -> `1.10.0`; anything else unchanged. */
function stripRefPrefix(ref) {
	const s = String(ref ?? "").trim();
	return s.startsWith("v") ? s.slice(1) : s;
}
/**
* Compare the installed OpenCode skin with the release the marketplace serves.
* The OpenCode skin publishes on the same release as the Claude plugin, so the
* plugin version the marketplace serves is the version the skin should be.
* A null pin is the pin group's hole, so it is not reported again here.
*
* @returns {Array<{ id: string, state: 'ok'|'warn'|'unknown', text: string, detail?: string }>}
*/
function auditSkin({ pinVersion, opencodeInstalledVersion, compare }) {
	if (pinVersion === null || pinVersion === void 0) return [];
	if (opencodeInstalledVersion === null || opencodeInstalledVersion === void 0) return [{
		id: "skin.installed",
		state: "unknown",
		text: "no opencode skin in the local npm cache, so it cannot be compared to the release",
		detail: "no @mnmal-ai/cortext-opencode under ~/.cache/opencode (node_modules/ or npm/)"
	}];
	const delta = compare(opencodeInstalledVersion, pinVersion);
	if (delta < 0) return [{
		id: "skin.installed",
		state: "warn",
		text: `opencode skin ${opencodeInstalledVersion} is BEHIND the release ${pinVersion}`,
		detail: "update the plugin entry to the release, then restart opencode (config loads once)"
	}];
	if (delta > 0) return [{
		id: "skin.installed",
		state: "warn",
		text: `opencode skin ${opencodeInstalledVersion} is AHEAD of the release ${pinVersion}`,
		detail: "either the marketplace clone is stale, or the install came from outside a release"
	}];
	return [{
		id: "skin.installed",
		state: "ok",
		text: `opencode skin ${opencodeInstalledVersion} matches`
	}];
}
/**
* The newest cortext-opencode version in OpenCode's package cache, or null.
*
* Two layouts, both measured. OpenCode 1.x kept one copy at
* `<cache>/node_modules/@mnmal-ai/cortext-opencode`. OpenCode 2.x keeps one
* per pinned version at `<cache>/npm/@mnmal-ai/cortext-opencode@<v>/<ts>/
* node_modules/@mnmal-ai/cortext-opencode` (measured on OpenCode 2.0.25), and the audit read only
* the first, so every 2.x install reported "no opencode skin". The newest is
* reported because each repo pins its own version; HostInstall rows carry
* what each repo actually loaded.
*
* @param {{ cacheRoot: string, listDir: (d: string) => string[],
*   readFile: (p: string) => string|null, compare: (a: string, b: string) => number }} p
* @returns {string|null}
*/
function newestOpencodeSkin({ cacheRoot, listDir, readFile, compare }) {
	const PKG = [
		"node_modules",
		"@mnmal-ai",
		"cortext-opencode",
		"package.json"
	];
	const join = (...parts) => parts.join("/");
	const versionAt = (path) => {
		try {
			const v = JSON.parse(readFile(path) ?? "null")?.version;
			return typeof v === "string" ? v : null;
		} catch {
			return null;
		}
	};
	const found = [versionAt(join(cacheRoot, ...PKG))];
	const scope = join(cacheRoot, "npm", "@mnmal-ai");
	for (const dir of listDir(scope)) {
		if (!dir.startsWith("cortext-opencode@")) continue;
		for (const ts of listDir(join(scope, dir))) found.push(versionAt(join(scope, dir, ts, ...PKG)));
	}
	const versions = found.filter((v) => v !== null);
	if (versions.length === 0) return null;
	return versions.reduce((a, b) => compare(a, b) >= 0 ? a : b);
}
/**
* Find the cortext pin across every marketplace clone on this machine.
*
* Scans rather than hardcoding `mnmal-ai`, because the marketplace directory is
* named for its owner and a machine may carry several. Returns the first entry
* naming this plugin.
*
* @param {object} p
* @param {string} p.marketplacesDir
* @param {(dir: string) => Array<string>|null} p.listDir
* @param {(path: string) => string|null} p.readFile
* @param {string} [p.pluginName='cortext']
* @returns {{ version: string, ref: string, marketplace: string }|null}
*/
function readMarketplacePin({ marketplacesDir, listDir, readFile, pluginName = "cortext" }) {
	for (const owner of listDir(marketplacesDir) ?? []) {
		const raw = readFile(`${marketplacesDir}/${owner}/.claude-plugin/marketplace.json`);
		if (raw === null) continue;
		let parsed = null;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		const entry = (parsed?.plugins ?? []).find((p) => p?.name === pluginName);
		if (entry === void 0 || entry === null) continue;
		const ref = entry?.source?.ref ?? null;
		if (ref === null) continue;
		return {
			version: stripRefPrefix(ref),
			ref,
			marketplace: owner
		};
	}
	return null;
}
/**
* Reconcile the pin against what this machine installed.
*
* `cloneFreshness` says what was learned about the local marketplace clone
* relative to its remote. It is THREE-valued on purpose:
*
*   'unchecked'  no network was spent, so the pin reading is a hole
*   'current'    checked, and the clone has everything the remote has
*   'behind'     checked, and the clone is MISSING commits — the pin is stale
*   'ahead'      checked, and the clone carries commits the remote does not
*
* ## Why not a boolean
*
* A `cloneVerified` boolean is false both when nothing was checked AND when a
* check ran and found the clone behind — so the one condition worth catching
* rendered as "not checked against its remote … re-run with --fetch", telling
* the reader to re-run the command that had just produced that line. Same
* shape as the defect in the comment
* below — a check that cannot distinguish "I did not look" from "I looked and
* it is bad" reports the second as the first, which reads as merely untidy.
*
* Unrecognised values fall through to 'unchecked' rather than to 'current': a
* caller that stops passing this, or passes a typo, must degrade to reporting a
* hole, never to claiming health.
*
* @returns {Array<{ id: string, state: 'ok'|'warn'|'unknown', text: string, detail?: string }>}
*/
function auditPin({ pin, installedVersion, cloneFreshness = "unchecked", cloneDetail = null, compare }) {
	const out = [];
	if (pin === null || pin === void 0) {
		out.push({
			id: "pin.read",
			state: "unknown",
			text: "no marketplace pin found",
			detail: "no marketplace clone on this machine names the cortext plugin, so there is nothing to compare the install against — \"am I current?\" cannot be answered locally"
		});
		return out;
	}
	out.push({
		id: "pin.read",
		state: "ok",
		text: `pin ${pin.ref} (marketplace ${pin.marketplace})`
	});
	if (cloneFreshness === "behind") out.push({
		id: "pin.freshness",
		state: "warn",
		text: `the marketplace clone is BEHIND its remote — pin ${pin.ref} is STALE`,
		detail: `${cloneDetail === null ? "" : `${cloneDetail}. `}The pin above is what this clone last fetched, not what the marketplace publishes, so "installed matches the pin" below can be true and still leave this box a release behind. Update the marketplace clone FIRST, then the plugin — a plugin update resolves against the stale pin and correctly does nothing.`
	});
	else if (cloneFreshness === "ahead") out.push({
		id: "pin.freshness",
		state: "warn",
		text: "the marketplace clone is AHEAD of its remote",
		detail: `${cloneDetail === null ? "" : `${cloneDetail}. `}A managed clone carrying unpushed commits means the pin being served here is not the one anyone else resolves.`
	});
	else if (cloneFreshness !== "current") out.push({
		id: "pin.freshness",
		state: "unknown",
		text: "the marketplace clone itself was not checked against its remote",
		detail: "the pin above is whatever this local clone last fetched. A clone two commits behind reports a stale pin as authoritative — which is how a box sat a full release behind while every check said healthy. Re-run with --fetch to verify."
	});
	if (installedVersion === null || installedVersion === void 0) {
		out.push({
			id: "pin.installed",
			state: "unknown",
			text: "installed version unknown, so it cannot be compared to the pin",
			detail: "no cortext@mnmal-ai entry in installed_plugins.json"
		});
		return out;
	}
	const delta = compare(installedVersion, pin.version);
	if (delta < 0) out.push({
		id: "pin.installed",
		state: "warn",
		text: `installed ${installedVersion} is BEHIND the pin ${pin.version}`,
		detail: "the marketplace pin does not update an already-installed plugin — update the plugin, then re-run so the fragment check compares against the right version"
	});
	else if (delta > 0) out.push({
		id: "pin.installed",
		state: "warn",
		text: `installed ${installedVersion} is AHEAD of the pin ${pin.version}`,
		detail: "either this clone is stale, or the install came from somewhere other than the marketplace. Both are worth knowing; neither is silently fine"
	});
	else out.push({
		id: "pin.installed",
		state: "ok",
		text: `installed ${installedVersion} matches`
	});
	return out;
}

//#endregion
//#region ../synoptic/src/mcp-json-facts.js
/**
* A `.mcp.json` env value, reduced to the literal it actually commits to.
*
* Handles both `${VAR}` and `${VAR:-fallback}`: the fallback is the interesting
* half, because it is the literal a repo commits to when the environment
* supplies nothing. A bare `${VAR}` commits to nothing and answers null — which
* is why an unpinned repo cannot establish its own kid this way.
*/
function mcpEnvLiteral(v) {
	if (typeof v !== "string") return null;
	const m = v.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-([^}]*))?\}$/);
	if (m === null) return v === "" ? null : v;
	return m[1] === void 0 || m[1] === "" ? null : m[1];
}
/**
* Facts about the project `.mcp.json` for the drift check.
*
* Reads the file ONCE and returns only what the check needs: is it tracked,
* and which FIELDS carry machine-specific values. Values never leave this
* function — an env block can hold a token, and the audit's rule is to report
* a field name rather than read a secret into the transcript.
*
* `${VAR:-fallback}` is the interesting case and is not machine-specific by
* itself: the skill's own Step 4.2 form ships `${SUBSTRATE_AGENT_KEY_ID:-default}`,
* whose fallback is the FLEET default. So a kid is flagged only when its
* literal names a host, and a path only when its literal is absolute.
*/
function readMcpJsonFacts(dir, { gitTimeoutMs = 15e3 } = {}) {
	const path = join(dir, ".mcp.json");
	const raw = readOrNull(path);
	if (raw === null) return {
		present: false,
		tracked: null,
		markers: null
	};
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			present: null,
			tracked: null,
			markers: null
		};
	}
	let tracked = null;
	try {
		execFileSync("git", gitArgs(dir), {
			stdio: "ignore",
			timeout: gitTimeoutMs
		});
		tracked = true;
	} catch (e) {
		tracked = trackedFromError(e);
	}
	return {
		present: true,
		tracked,
		markers: markersOf(parsed)
	};
}
function gitArgs(dir) {
	return [
		"-C",
		dir,
		"ls-files",
		"--error-unmatch",
		".mcp.json"
	];
}
function trackedFromError(e) {
	return e?.status === 1 || e?.code === 1 ? false : null;
}
function markersOf(parsed) {
	const markers = [];
	const isAbsolute = (v) => typeof v === "string" && (v.startsWith("/") || v.startsWith("~/"));
	for (const [name, server] of Object.entries(parsed?.mcpServers ?? {})) {
		if (isAbsolute(mcpEnvLiteral(server?.command))) markers.push({
			field: `${name}.command`,
			kind: "absolute path"
		});
		for (const [i, arg] of (Array.isArray(server?.args) ? server.args : []).entries()) if (isAbsolute(mcpEnvLiteral(arg))) markers.push({
			field: `${name}.args[${i}]`,
			kind: "absolute path"
		});
		for (const [k, v] of Object.entries(server?.env ?? {})) {
			const lit = mcpEnvLiteral(v);
			if (lit === null) continue;
			if (/(TOKEN|SECRET|PASSWORD|PASSPHRASE)/i.test(k)) markers.push({
				field: `${name}.env.${k}`,
				kind: "literal secret"
			});
			else if (isAbsolute(lit)) markers.push({
				field: `${name}.env.${k}`,
				kind: "absolute path"
			});
			else if (/KID$/i.test(k) && lit.includes("@")) markers.push({
				field: `${name}.env.${k}`,
				kind: "host-pinned identity"
			});
		}
	}
	return markers;
}

//#endregion
//#region ../synoptic/src/settings-check.js
/**
* @typedef {{ state: 'ok'|'warn'|'unknown', text: string, detail?: string }} SettingsFinding
*/
/**
* Validate the settings file and its MCP-enabling keys.
*
* @param {object} p
* @param {string|null} p.settingsText Raw `.claude/settings.local.json`, or null if absent.
* @param {boolean} p.hasProjectMcp Whether the repo has its own `.mcp.json`.
* @returns {Array<SettingsFinding>}
*/
function checkSettings({ settingsText, hasProjectMcp }) {
	const out = [];
	if (settingsText === null) {
		out.push({
			state: "ok",
			text: "settings.local.json absent (nothing to invalidate)"
		});
		if (hasProjectMcp) out.push({
			state: "warn",
			text: "a project .mcp.json exists with no settings.local.json to enable it",
			detail: "the server needs enableAllProjectMcpServers or enabledMcpjsonServers, or it stays pending approval and presents as \"substrate offline\""
		});
		return out;
	}
	let parsed = null;
	try {
		parsed = JSON.parse(settingsText);
	} catch (err) {
		out.push({
			state: "warn",
			text: "settings.local.json is NOT VALID JSON — Claude Code is silently ignoring all of it",
			detail: `${String(err?.message ?? err)} — every key in this file is inert, including permission allowlists and MCP enablement, while the file reads as though they apply`
		});
		return out;
	}
	out.push({
		state: "ok",
		text: "settings.local.json parses"
	});
	if (!hasProjectMcp) return out;
	const enabledAll = parsed?.enableAllProjectMcpServers === true;
	const enabledList = Array.isArray(parsed?.enabledMcpjsonServers) ? parsed.enabledMcpjsonServers : [];
	if (!enabledAll && !enabledList.includes("substrate")) out.push({
		state: "warn",
		text: "the project .mcp.json substrate server is not enabled by settings.local.json",
		detail: "set enableAllProjectMcpServers: true or add \"substrate\" to enabledMcpjsonServers; until then it stays pending approval and cold-start reports \"substrate offline\""
	});
	else out.push({
		state: "ok",
		text: "project MCP servers are enabled"
	});
	return out;
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
/**
* Semantic recall. Returns rows[] when recall answered, or null when it did
* not (semantic unavailable) — the contract callers already depend on.
*
* ## Why this is a frame query and not `POST /substrate/v1/recall`
*
* The kernel route 401s a valid agent token (see `substrateMutate`), and this
* function's own `if (!res.ok) return null` turned that into "semantic
* unavailable". The old comment named the hazard exactly — *"a persistent
* misconfig (e.g. 401) looks the same as a transient gap"* — and then the
* misconfig arrived and looked exactly like a transient gap, every session,
* for as long as the hook has been signing.
*
* It was observable the whole time and nobody was reading the instrument: the
* Agent Memory heading renders as `(from cortext/Memory — N total, M top)`
* when recall is unavailable and `(hybrid recall — RRF, unified)` when it is
* not. Live cold-starts have been printing the former.
*
* `recall/Hit` runs through frame dispatch, which authenticates correctly.
*
* ## Two shape notes that will bite anyone editing this
*
* The frame names the query parameter `to`, not `query`. And a REJECTED frame
* arrives as HTTP 200 with its key absent from `data` — so the null return
* below is driven by key PRESENCE, never by an empty array, which is a true
* negative and must stay distinguishable from a refusal.
*
* `boost` is left unset by default, which means the server's default — ON.
* Recall reinforcing what it MATCHED is the founding "recall what you use"
* signal, and unlike a ranking fetch, the result set here really
* is the evidence. So restoring this restores real salience accumulation on
* Memory / SessionLog / Decision, absent for the same reason. A caller that is
* DIAGNOSING rather than using passes `boost: false` — the audit's probe does,
* because an instrument that reinforces what it matched would alter the signal
* it is reporting on.
*/
async function recall(substrateUrl, opts = {}) {
	const { query, namespace, type, k = 60, threshold, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, onFrameFailure = null, boost, where } = opts;
	const key = "recall/Hit";
	const params = {
		to: query,
		namespace,
		type,
		k
	};
	if (threshold !== void 0) params.threshold = threshold;
	if (where !== void 0) params.where = where;
	if (boost !== void 0) params.boost = boost;
	try {
		const data = await substrateQuery(substrateUrl, { [key]: {
			params,
			fields: {
				id: true,
				score: true,
				row: true
			}
		} }, {
			fetchImpl,
			timeoutMs,
			onFrameFailure
		});
		if (!Object.hasOwn(data, key)) return null;
		return Array.isArray(data[key]) ? data[key] : null;
	} catch {
		return null;
	}
}
/**
* GET /substrate/v1/whoami — what this credential ACTUALLY holds.
*
* ## Why the server has to be asked
*
* The obvious shortcut is to read our own token, and it does not work.
* `agent-auth.js` mints `ns: ['*'], capabilities: ['read','mutate']` as a fixed
* CLAIM, and substrate intersects that claim with what the kid's _system/Key row
* actually grants. whoami returns the POST-INTERSECTION view — substrate's own
* comment on the route says it exists because *"a caller currently cannot
* distinguish 'my key is registered but scoped to a different namespace' from
* 'the peer is down'"*.
*
* So the one artifact held locally is precisely the one that cannot answer the
* question, because it is the request rather than the grant. A client that
* trusted its own token would report `*` for every identity in the fleet,
* including the one that is scoped to a single namespace and silently losing
* hybrid recall.
*
* ## The shape changed too, and the new field is the valuable half
*
* Old: a bare `authenticated: false` meaning BOTH "this deployment verifies
* nothing" and "auth is on and your credential never arrived". New:
*
*     { authEnabled: boolean, identity: null | { id, capabilities, namespaces } }
*
* Those two states have completely different fixes — a deployment posture the
* caller cannot change, versus env vars that never took effect — and the old
* shape could not express the second at all — and on a reads-open stack, where
* an authenticated read and an anonymous one are byte-identical, that state
* can persist unnoticed.
*
* This function maps the response onto flat `authenticated` / `id` /
* `capabilities` / `namespaces` fields. A response without `authEnabled` maps
* it to `null` — never `false`, which would report a verifying deployment as
* one that verifies nothing.
*
* ## Failure shapes are kept distinct on purpose
*
* The point is that a check which cannot tell "did not ask" from
* "asked, and the answer is bad" reports the second as the first:
*
*   { ok: true,  authEnabled: true,  authenticated: true,  ... }
*                                             the credential answered
*   { ok: true,  authEnabled: false, authenticated: false }
*                                             auth is DISABLED here; nothing is
*                                             verified and presenting a
*                                             credential would change nothing
*   { ok: true,  authEnabled: true,  authenticated: false }
*                                             auth is ON and this request
*                                             carried no credential — OUR
*                                             wiring, not the server's
*   { ok: false, failed: '<reason>' }         unreachable, non-2xx, malformed
*
* A 401 lands in the last with `failed: 'whoami 401'`, and that is a POSITIVE
* signal worth reading: a token was presented and REJECTED. substrate keeps that
* distinct from anonymous deliberately — no token answers 200 with a null
* identity, a bad token 401s — so this is the one case a revoked key produces.
*
* ## `capabilities: null` is now TWO different answers
*
* The grant is two-dimensional: a key holds
* capabilities PER NAMESPACE, `{ cortext: ['read','mutate'], plane: ['read'] }`,
* and `'*'` is a legal key. The flat `capabilities` field survives as a
* compatibility view, and the whoami route sets it to `null` whenever no flat
* list can be honest — the union would say the holder can `mutate` when they
* can only mutate somewhere, and the intersection would under-report.
*
* So a `null` here means EITHER "this response shape is version skew" (the old
* reading, still correct when nothing else arrived) OR "the grant is
* per-namespace, and it is in the field beside this one". Those are opposite
* findings: the first is a hole, the second is a more precise answer than the
* flat field could ever carry. `grants` is what tells them apart, so it is
* carried through rather than dropped — dropping it is what made the audit
* report a correctly-answering 5.23.0 server as a shape it did not understand.
*
* `grants` is `null` when ABSENT, which is its own real state and not a
* failure: substrate attaches it only to a dataset-backed verification, so a
* file-registry key legitimately has none and its flat `capabilities` is the
* whole truth about it.
*
* @returns {Promise<{ ok: boolean, authEnabled?: boolean|null,
*                     authenticated?: boolean, id?: string|null,
*                     capabilities?: string[]|null, namespaces?: string[]|null,
*                     grants?: Record<string, string[]>|null,
*                     failed?: string }>}
*/
async function probeWhoami(substrateUrl, opts = {}) {
	const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
	const { signal, done } = withTimeout(timeoutMs);
	try {
		const res = await fetchImpl(`${substrateUrl}/substrate/v1/whoami`, { signal });
		if (res.status === 404) return {
			ok: false,
			failed: "whoami 404: this server has no /substrate/v1/whoami route"
		};
		if (!res.ok) return {
			ok: false,
			failed: `whoami ${res.status}`
		};
		const json = await res.json();
		const identity = json?.identity ?? null;
		if (identity === null) return {
			ok: true,
			authEnabled: typeof json?.authEnabled === "boolean" ? json.authEnabled : null,
			authenticated: false
		};
		return {
			ok: true,
			authEnabled: typeof json?.authEnabled === "boolean" ? json.authEnabled : null,
			authenticated: true,
			id: typeof identity.id === "string" ? identity.id : null,
			capabilities: Array.isArray(identity.capabilities) ? identity.capabilities : null,
			namespaces: Array.isArray(identity.namespaces) ? identity.namespaces : null,
			grants: asGrants(identity.grants)
		};
	} catch (e) {
		return {
			ok: false,
			failed: e?.message ?? "whoami unreachable"
		};
	} finally {
		done();
	}
}
/**
* The per-namespace grant, or `null` if this response does not carry one.
*
* Validated rather than trusted, because a HALF-understood grant is worse than
* none: every caller below decides `read` per namespace from this map, so one
* entry arriving as a non-array would either throw mid-render or, worse, read
* as "no capabilities there". Anything not of the exact `{ ns: string[] }`
* shape is rejected WHOLE and falls back to the flat reading, which is the
* behaviour that predates grants and is never wrong — only coarser.
*
* An empty object is deliberately NOT rejected. `intersectGrants` drops a
* namespace that resolves to no capability, so `{}` is the real and reportable
* state of a key whose claim and row share nothing.
*/
function asGrants(raw) {
	if (raw === null || raw === void 0 || typeof raw !== "object" || Array.isArray(raw)) return null;
	const out = {};
	for (const [ns, caps] of Object.entries(raw)) {
		if (!Array.isArray(caps) || caps.some((c) => typeof c !== "string")) return null;
		out[ns] = caps;
	}
	return out;
}
/**
* POST /substrate/v1/mutate. Returns the `data` map. Throws on non-2xx / network / timeout.
*
* Exists because the plugin KERNEL ROUTES cannot authenticate an agent.
* `mountKernelRoute` receives the host's undecorated `AuthConfig`, which has no
* key registry, so a registry-resolved kid cannot be looked up and a perfectly
* valid agent token is rejected as "present-but-invalid". Frame dispatch runs
* inside `compose()`, which derives an auth config that DOES carry the registry
* — so the same credential that 401s on `/substrate/v1/embeddings/fetch` verifies here.
*
* Measured, with a control that rules out a bad key:
*
*     /substrate/v1/query             GOOD token     200
*     /substrate/v1/query             CORRUPT token  401   <- the verifier works
*     /substrate/v1/embeddings/fetch  GOOD token     401
*     /substrate/v1/embeddings/fetch  NO token       200
*
* The frame surface and the kernel routes delegate to ONE core per operation,
* so this is a transport swap and not a behaviour change — verified against the
* live server for all three: byte-identical response shapes, `boost: false` is
* honoured, and a nonexistent ref still reports `applied: 0` with `missing[]`.
*
* Shares `substrateQuery`'s partial-success handling deliberately. A mutate frame
* is rejected exactly the way a query frame is — 200, key ABSENT from `data`,
* reason in `errors` — so a caller reading `data[key] ?? null` cannot tell a
* refusal from a no-op. `onFrameFailure` is the seam that keeps that visible.
*/
async function substrateMutate(substrateUrl, payload, opts = {}) {
	const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, onFrameFailure = null } = opts;
	const { signal, done } = withTimeout(timeoutMs);
	try {
		const res = await fetchImpl(`${substrateUrl}/substrate/v1/mutate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal
		});
		if (!res.ok) throw new Error(`substrate/mutate ${res.status}`);
		const json = await res.json();
		try {
			if (onFrameFailure !== null) {
				for (const e of frameErrors(json)) onFrameFailure(e.key, `${e.code}: ${e.message}`);
				for (const key of unansweredFrames(payload, json)) onFrameFailure(key, "requested but absent from `data`, with no error given");
			}
		} catch {}
		return json.data ?? {};
	} finally {
		done();
	}
}

//#endregion
//#region ../synoptic/src/host-checks.js
/** Non-secret switches whose values are recorded, for fleet-wide drift. */
const SETTINGS_ENV_ALLOWLIST = [
	"SUBSTRATE_URL",
	"SUBSTRATE_NAMESPACE",
	"SYNOPTIC_PROJECT_SCOPE",
	"SYNOPTIC_COLD_START_MEMORY",
	"SYNOPTIC_COLD_START_SALIENT",
	"SYNOPTIC_INBOX_PUSH",
	"SYNOPTIC_INBOX_WAKE",
	"SYNOPTIC_INBOX_URGENT_FROM",
	"RULE_SALIENCE"
];
/** Identity keys recorded only as set or unset: one holds a key file's path. */
const SETTINGS_ENV_PRESENCE = ["SUBSTRATE_AGENT_KEY_ID", "SUBSTRATE_AGENT_KEY_PATH"];

//#endregion
//#region ../synoptic/src/host-install.js
const HOST_INSTALL_FRESH_MS = 864e5;
const HOST_INSTALL_STALE_MS = 7 * HOST_INSTALL_FRESH_MS;
/**
* fresh < 24h, quiet < 7d, stale beyond, or when refreshedAt is missing or
* unparseable. A future timestamp (clock skew) is fresh with age 0, never a
* negative age.
*
* @returns {{ state: 'fresh'|'quiet'|'stale', ageMs: number|null }}
*/
function classifyInstall(row, nowMs) {
	const t = Date.parse(row?.refreshedAt ?? "");
	if (Number.isNaN(t)) return {
		state: "stale",
		ageMs: null
	};
	const ageMs = Math.max(0, nowMs - t);
	if (ageMs < 864e5) return {
		state: "fresh",
		ageMs
	};
	if (ageMs < 6048e5) return {
		state: "quiet",
		ageMs
	};
	return {
		state: "stale",
		ageMs
	};
}
/** Whole-unit age, for rendering beside a state. */
function describeAge(ageMs) {
	if (ageMs === null || ageMs === void 0) return "never";
	for (const [ms, unit] of [
		[864e5, "day"],
		[36e5, "hour"],
		[6e4, "minute"]
	]) {
		const n = Math.floor(ageMs / ms);
		if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
	}
	return "just now";
}

//#endregion
//#region ../synoptic/src/host-audit.js
const STATE_OF = {
	fresh: "ok",
	quiet: "unknown",
	stale: "warn"
};
const INSTALL_DETAIL = {
	quiet: "no session has started in that repo for over a day, so the row is probably still true but unconfirmed; starting one refreshes it",
	stale: "no session has started there for over a week; do not rely on the row, the host or repo may be gone"
};
const DRIFT_KEYS = [...SETTINGS_ENV_ALLOWLIST.filter((k) => k !== "SYNOPTIC_PROJECT_SCOPE"), ...SETTINGS_ENV_PRESENCE];
const MAX_FIELD = 64;
const MAX_NOTE = 200;
function clean(value, max = MAX_FIELD) {
	if (value === null || value === void 0) return null;
	const text = String(value).replace(/[\p{Cc}`]/gu, " ").trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
const token = (value) => (clean(value) ?? "?").replace(/\s+/g, "_");
const FIELDS = [
	"host",
	"project",
	"kid",
	"harness",
	"pluginVersion",
	"fragmentVersion",
	"fragmentDigest",
	"fragmentState",
	"refreshedAt",
	"pinState",
	"pinNote",
	"mcpJsonState",
	"mcpJsonNote",
	"authorityState",
	"authorityNote",
	"settingsState",
	"settingsNote"
];
const CHECKS = [
	[
		"pin",
		"pin",
		"update the plugin on that host, or refresh its marketplace clone"
	],
	[
		"mcpJson",
		".mcp.json",
		"run audit.mjs in that repo for the detail"
	],
	[
		"authority",
		"authority",
		"the note names which: a key rejected or not loaded, a signer other than the repo kid, a server verifying nothing, or a grant too narrow or too broad. Run audit.mjs in that repo for the fix"
	],
	[
		"settings",
		"settings",
		"fix that repo's .claude/settings.local.json; audit.mjs there has the detail"
	]
];
function cleanRow(row) {
	const out = { _metadata: { updatedBy: { id: clean(row?._metadata?.updatedBy?.id) } } };
	for (const f of FIELDS) out[f] = clean(row?.[f], f.endsWith("Note") ? MAX_NOTE : MAX_FIELD);
	return out;
}
/**
* @param {{ rows: Array<object>|null, directoryRows: Array<object>|null,
*   nowMs: number, compare: (a: string, b: string) => number }} p
*/
function auditHosts({ rows, directoryRows, nowMs, compare }) {
	if (rows === null || directoryRows === null) return [{
		id: "hosts.read",
		state: "unknown",
		text: rows === null ? "HostInstall rows could not be read, so no host was checked" : "the AgentIdentity directory could not be read, so no host was checked",
		detail: "a runtime older than the release that added HostInstall refuses the read. Deploy it, then let one session start in each repo"
	}];
	const matchKey = (host, project) => `${normaliseHost(host)}/${String(project ?? "")}`;
	const shownKey = (host, project) => `${token(normaliseHost(host))}/${token(project)}`;
	const expected = /* @__PURE__ */ new Map();
	const roamers = /* @__PURE__ */ new Map();
	const hostOf = (r) => {
		const at = typeof r.kid === "string" ? r.kid.lastIndexOf("@") : -1;
		return r.host ?? (at > 0 ? r.kid.slice(at + 1) : null);
	};
	for (const r of directoryRows) {
		if (r.active === false || r.roaming !== true || typeof r.kid !== "string") continue;
		const host = hostOf(r);
		if (!host) continue;
		const kids = roamers.get(normaliseHost(host)) ?? /* @__PURE__ */ new Set();
		kids.add(r.kid);
		roamers.set(normaliseHost(host), kids);
	}
	for (const r of directoryRows) {
		if (r.active === false || typeof r.project !== "string" || r.project === "") continue;
		const host = hostOf(r);
		if (!host) continue;
		const match = matchKey(host, r.project);
		const entry = expected.get(match) ?? {
			kids: /* @__PURE__ */ new Set(),
			shown: shownKey(host, r.project)
		};
		if (typeof r.kid === "string") entry.kids.add(r.kid);
		expected.set(match, entry);
	}
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const fresh = [];
	for (const raw of rows) {
		const row = cleanRow(raw);
		const serverAt = Date.parse(raw?._metadata?.updatedAt ?? "");
		const hostAt = Date.parse(raw?.refreshedAt ?? "");
		if (!Number.isNaN(serverAt) && !Number.isNaN(hostAt) && serverAt < hostAt) row.refreshedAt = new Date(serverAt).toISOString();
		const match = matchKey(raw?.host, raw?.project);
		const key = `${shownKey(raw?.host, raw?.project)}/${token(raw?.harness)}`;
		seen.add(match);
		const { state, ageMs } = classifyInstall(row, nowMs);
		out.push({
			id: "hosts.install",
			state: STATE_OF[state],
			text: `${key} ${state} — last reported ${describeAge(ageMs)}: plugin ${row.pluginVersion ?? "?"}, fragment ${row.fragmentVersion ?? "?"}+${row.fragmentDigest ?? "?"} (${row.fragmentState}), ${row.harness}${checkSummary(row)}`,
			...INSTALL_DETAIL[state] ? { detail: INSTALL_DETAIL[state] } : {}
		});
		if (state !== "stale") for (const [field, label, remedy] of CHECKS) {
			if (row[`${field}State`] !== "warn") continue;
			out.push({
				id: "hosts.checks",
				state: "warn",
				text: `${key} ${label}: \`${row[`${field}Note`] ?? "no reason recorded"}\``,
				detail: remedy
			});
		}
		const writer = raw?._metadata?.updatedBy?.id ?? null;
		const rowKid = raw?.kid ?? null;
		const roaming = writer !== null && (roamers.get(normaliseHost(raw?.host))?.has(writer) ?? false);
		const owners = expected.get(match)?.kids ?? new Set(rowKid === null ? [] : [rowKid]);
		const ownerText = [...owners].map((k) => `\`${clean(k)}\``).join(" or ");
		if (roaming) out.push({
			id: "hosts.writer",
			state: "ok",
			text: `${key} was written by \`${clean(writer)}\`, a roaming identity on that host`
		});
		else if (writer === null) out.push({
			id: "hosts.writer",
			state: "unknown",
			text: `${key} carries no _metadata.updatedBy, so who wrote it cannot be checked`,
			detail: "the server stamps updatedBy on every write, so its absence means the read did not project it or the row predates attribution"
		});
		else if (owners.size > 0 && !owners.has(writer)) out.push({
			id: "hosts.writer",
			state: "warn",
			text: `${key} was last written by \`${clean(writer)}\`, not by ${ownerText}, the identity that works it`,
			detail: "a key other than the repo's own reported this host; something may be holding a borrowed key"
		});
		if (!roaming && rowKid !== null && owners.size > 0 && !owners.has(rowKid)) out.push({
			id: "hosts.writer",
			state: "warn",
			text: `${key} names kid \`${clean(rowKid)}\`, but the directory says ${ownerText} works it`,
			detail: "the row or the directory is wrong about which identity works this repo on this host"
		});
		const verified = roaming || writer !== null && expected.has(match) && expected.get(match).kids.has(writer);
		if (state === "fresh" && verified) fresh.push({
			key,
			row,
			harness: raw?.harness ?? null,
			env: raw?.settingsEnv ?? null
		});
		if (!expected.has(match) && !roaming) out.push({
			id: "hosts.orphan",
			state: "unknown",
			text: `${key} reports, but no active AgentIdentity works ${row.project} on ${row.host}`,
			detail: "a retired or unregistered identity is still starting sessions there, or the directory row is wrong"
		});
	}
	for (const [match, { shown }] of expected) {
		if (seen.has(match)) continue;
		out.push({
			id: "hosts.unreported",
			state: "unknown",
			text: `${shown} never reported`,
			detail: "its agent has not started a session on a plugin that reports, or SYNOPTIC_HOST_REPORT=off there, or the directory names the wrong host"
		});
	}
	out.push(...settingsDrift(fresh));
	if (fresh.length > 1) {
		const newest = fresh.map((f) => f.row.pluginVersion).filter(Boolean).sort((a, b) => compare(b, a))[0];
		const digests = /* @__PURE__ */ new Map();
		for (const f of fresh) {
			if (f.row.fragmentState === "source" || !f.row.fragmentDigest) continue;
			digests.set(f.row.fragmentDigest, (digests.get(f.row.fragmentDigest) ?? 0) + 1);
		}
		const commonDigest = [...digests].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
		for (const f of fresh) {
			const pluginBehind = Boolean(newest && f.row.pluginVersion && compare(f.row.pluginVersion, newest) < 0);
			const fragmentOff = Boolean(commonDigest && f.row.fragmentState !== "source" && f.row.fragmentDigest && f.row.fragmentDigest !== commonDigest);
			if (!pluginBehind && !fragmentOff) continue;
			const causes = [];
			const remedies = [];
			if (pluginBehind) {
				causes.push(`plugin ${f.row.pluginVersion} is behind the fleet's ${newest}`);
				remedies.push("run /plugin update cortext@mnmal-ai on that host, then start a session there");
			}
			if (fragmentOff) {
				causes.push(`fragment ${f.row.fragmentVersion ?? "?"}+${f.row.fragmentDigest} differs from the fleet's ${commonDigest}`);
				remedies.push("run /substrate-setup in that repo");
			}
			out.push({
				id: "hosts.versions",
				state: "warn",
				text: `${f.key} ${causes.join("; ")}`,
				detail: remedies.join("; ")
			});
		}
	}
	return out;
}
/** ` · pin ok · authority warn …` for the states a row carries, or ''. */
function checkSummary(row) {
	const parts = CHECKS.filter(([field]) => row[`${field}State`] !== null).map(([field, label]) => `${label} ${row[`${field}State`]}`);
	return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}
/**
* Settings that differ across the fleet. Within each harness (their switches
* legitimately differ), for each recorded switch, the value held by MORE THAN
* HALF of the fresh, verified rows; each row that differs gets a finding. With
* no such majority it reports nothing rather than guessing. Only the known
* switches are compared, and only string or boolean values: the json is
* written by whoever holds a key.
*/
function settingsDrift(fresh) {
	const byHarness = /* @__PURE__ */ new Map();
	for (const f of fresh) {
		if (f.env === null || typeof f.env !== "object" || Array.isArray(f.env)) continue;
		const list = byHarness.get(f.harness) ?? [];
		list.push(f);
		byHarness.set(f.harness, list);
	}
	const show = (v) => {
		if (v === true) return "(set)";
		if (v === false || v === void 0) return "(unset)";
		return typeof v === "string" ? `"${clean(v)}"` : null;
	};
	const out = [];
	for (const rows of byHarness.values()) {
		if (rows.length < 3) continue;
		for (const name of DRIFT_KEYS) {
			const values = rows.map((r) => ({
				key: r.key,
				v: show(r.env[name])
			}));
			if (values.some((x) => x.v === null)) continue;
			const counts = /* @__PURE__ */ new Map();
			for (const { v } of values) counts.set(v, (counts.get(v) ?? 0) + 1);
			const [majority, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
			if (n * 2 <= rows.length) continue;
			for (const { key, v } of values) {
				if (v === majority) continue;
				out.push({
					id: "hosts.settings-drift",
					state: "warn",
					text: `${key} ${name}=${v}, where ${n} of ${rows.length} fresh records have ${majority}`,
					detail: "align that repo's .claude/settings.local.json with the fleet, or record why it differs"
				});
			}
		}
	}
	return out;
}

//#endregion
//#region ../synoptic/src/audit-facts/fleet.js
/**
* The fragment as COMMITTED, which is a different artifact from the one on disk
* wherever it is tracked.
*
* Returns null for "untracked, or not a checkout" — a legitimate state, and
* deliberately the same answer as "git could not tell me", because both mean
* this run has no committed copy to compare against and neither is drift.
* Reporting a hole as a difference would be the defect this check exists for.
*
* @param {string} repoDir
* @returns {string|null}
*/
function committedFragment(repoDir) {
	try {
		return execFileSync("git", [
			"-C",
			repoDir,
			"show",
			"HEAD:.claude/substrate-conventions.md"
		], {
			encoding: "utf8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		});
	} catch {
		return null;
	}
}
/** One git answer, or null when git could not give one. */
function gitOut(repoDir, args) {
	try {
		return execFileSync("git", [
			"-C",
			repoDir,
			...args
		], {
			encoding: "utf8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		}).trim();
	} catch {
		return null;
	}
}
/**
* Where the SOURCE repo's checkout stands relative to the release.
*
* A source that is ahead of the release made that release, so the released
* marker (`+<digest>`, stamped by sync-fragment-version and enforced against
* the body by test) is in its history. A stale clone never received it. That
* one pickaxe search is what separates "unpublished edit" from "old checkout",
* which read identically from the working tree alone.
*
* `behindUpstream` counts against the LAST FETCH — this runs no network — so it
* can understate. The history check does not depend on it.
*
* @param {string} repoDir
* @param {string|null} releasedDigest
*/
function sourceGitFacts(repoDir, releasedDigest) {
	let releasedInHistory = null;
	if (releasedDigest !== null) {
		const hit = gitOut(repoDir, [
			"log",
			"--all",
			"--format=%H",
			"-1",
			`-S+${releasedDigest}`,
			"--",
			".claude/substrate-conventions.md",
			"packages/cortext-plugin/fragments/substrate-conventions.md"
		]);
		releasedInHistory = hit === null ? null : hit !== "";
	}
	const branch = gitOut(repoDir, [
		"rev-parse",
		"--abbrev-ref",
		"HEAD"
	]);
	const originHead = gitOut(repoDir, [
		"symbolic-ref",
		"--short",
		"refs/remotes/origin/HEAD"
	]);
	const behind = gitOut(repoDir, [
		"rev-list",
		"--count",
		"HEAD..@{u}"
	]);
	return {
		releasedInHistory,
		branch: branch === null || branch === "HEAD" ? null : branch,
		defaultBranch: originHead === null ? null : originHead.replace(/^origin\//, ""),
		behindUpstream: behind === null || !/^\d+$/.test(behind) ? null : Number(behind)
	};
}
const HOST_INSTALL_LIMIT = 500;
const HOST_INSTALL_FIELDS = [
	"key",
	"host",
	"hostReported",
	"project",
	"kid",
	"harness",
	"pluginVersion",
	"fragmentVersion",
	"fragmentDigest",
	"fragmentState",
	"refreshedAt",
	"pinState",
	"pinNote",
	"mcpJsonState",
	"mcpJsonNote",
	"authorityState",
	"authorityNote",
	"settingsState",
	"settingsNote",
	"settingsEnv"
];
/**
* Both null without --fleet.
*
* @param {{ fleetDir: string|null, directoryRows: Array<object>|null,
*           candidates: Array<{ version: string, text: string }>,
*           substrateUrl: string|null, env: Record<string, string|undefined>,
*           fetchImpl: typeof fetch, thisHost?: string }} p
*/
async function gatherFleet({ fleetDir, directoryRows, candidates, substrateUrl, env, fetchImpl, thisHost = hostname() }) {
	let fleetFindings = null;
	let hostFindings = null;
	if (fleetDir !== null) {
		const repos = [];
		const sourceRepos = [];
		const noFragment = [];
		for (const d of (listOrNull(fleetDir) ?? []).filter((e) => e.isDirectory())) {
			const dir = join(fleetDir, d.name);
			const f = join(dir, ".claude", "substrate-conventions.md");
			if (!existsSync(f)) {
				noFragment.push(d.name);
				continue;
			}
			if (isFragmentSourceRepo({
				cwd: dir,
				exists: existsSync
			})) sourceRepos.push(d.name);
			repos.push({
				name: d.name,
				text: readOrNull(f),
				committed: committedFragment(dir)
			});
		}
		const scope = scopeFleetToHost({
			repoNames: repos.map((r) => r.name),
			thisHost,
			directoryRows
		});
		const here = new Set(scope.here);
		const missing = scopeFleetToHost({
			repoNames: noFragment,
			thisHost,
			directoryRows
		}).here;
		const scoped = repos.filter((r) => here.has(r.name));
		const localSource = sourceRepos.find((name) => here.has(name)) ?? null;
		const bestText = [...candidates].sort((a, b) => compareVersions(b.version, a.version))[0]?.text ?? null;
		const digest = (body) => createHash("sha256").update(body, "utf8").digest("hex").slice(0, 8);
		const bestFragment = bestText === null ? null : readFragment(bestText);
		const surveyed = !scope.placed ? [] : auditFleetFragments({
			repos: scoped,
			best: bestText,
			sourceRepo: localSource,
			sourceGit: localSource === null ? void 0 : sourceGitFacts(join(fleetDir, localSource), bestFragment === null ? null : digest(bestFragment.body)),
			digest,
			population: {
				elsewhere: scope.elsewhere.length,
				unclaimed: scope.unclaimed.length
			},
			missing
		}).findings;
		fleetFindings = [...scope.findings, ...surveyed].map((f) => check(f.id, f.state, f.text, f.detail));
		let hostRows = null;
		if (substrateUrl !== null) try {
			const key = `${env.SUBSTRATE_NAMESPACE ?? "cortext"}/HostInstall`;
			const fields = { _metadata: true };
			for (const f of HOST_INSTALL_FIELDS) fields[f] = true;
			const data = await substrateQuery(substrateUrl, { [key]: {
				params: { limit: HOST_INSTALL_LIMIT },
				fields
			} }, { fetchImpl });
			hostRows = Object.hasOwn(data, key) ? data[key] : null;
		} catch {
			hostRows = null;
		}
		hostFindings = auditHosts({
			rows: hostRows,
			directoryRows,
			nowMs: Date.now(),
			compare: compareVersions
		}).map((f) => check(f.id, f.state, f.text, f.detail));
		if (hostRows !== null && hostRows.length >= HOST_INSTALL_LIMIT) hostFindings.push(check("hosts.truncated", "unknown", `read ${hostRows.length} HostInstall rows, the query limit, so some may be missing`, "\"never reported\" findings above may be false; this audit does not page"));
	}
	return {
		fleetFindings,
		hostFindings
	};
}

//#endregion
//#region ../synoptic/src/rule-vectors.js
/**
* Fetch stored embedding vectors for rows.
*
* Never throws — a cold-start must degrade to less context, never to none, and
* the salient tier degrades to structural-only exactly as it does today.
*
* @param {string} substrateUrl
* @param {ReadonlyArray<{namespace: string, type: string, id: string}>} refs
* @param {{ fetchImpl?: typeof fetch, onFrameFailure?: ((key: string, detail: string) => void)|null }} [opts]
* @returns {Promise<Map<string, number[]>>} id -> vector. Empty on any failure.
*/
async function fetchRowVectors(substrateUrl, refs, { fetchImpl = fetch, onFrameFailure = null } = {}) {
	const out = /* @__PURE__ */ new Map();
	if (!Array.isArray(refs) || refs.length === 0) return out;
	const key = "recall/fetchEmbeddings";
	try {
		const data = await substrateMutate(substrateUrl, { [key]: {
			params: { refs },
			fields: {
				model: true,
				vectors: true
			}
		} }, {
			fetchImpl,
			onFrameFailure
		});
		const vectors = Array.isArray(data?.[key]?.vectors) ? data[key].vectors : [];
		for (const v of vectors) if (typeof v?.id === "string" && Array.isArray(v?.vector)) out.set(v.id, v.vector);
	} catch {}
	return out;
}
/** `{namespace, type, id}` refs for rows that have an id. */
function toRefs(rows, namespace, type) {
	return rows.filter((r) => typeof r?.id === "string").map((r) => ({
		namespace,
		type,
		id: r.id
	}));
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
/** The project slug for a root: its basename, or null (all projects) under SYNOPTIC_PROJECT_SCOPE=all. */
function projectSlug(root, env) {
	if (env.SYNOPTIC_PROJECT_SCOPE === "all") return null;
	return basename(root);
}
/** The `where` for live rows in a project plus cross-cutting rows; unscoped for a null slug. */
function projectWhere(slug) {
	if (slug === null || slug === void 0) return { archived: { eq: false } };
	return {
		archived: { eq: false },
		project: { in: [slug, null] }
	};
}

//#endregion
//#region ../synoptic/src/audit-facts/server.js
const DIRECTORY_LIMIT = 200;
/**
* The AgentIdentity directory. All three are null when there is no server or
* it did not answer: `unknown`, never "unregistered".
*/
async function readDirectory({ substrateUrl, env, fetchImpl }) {
	let directoryKids = null;
	let directoryRows = null;
	let activeKids = null;
	if (substrateUrl !== null) try {
		const key = `${env.SUBSTRATE_NAMESPACE ?? "cortext"}/AgentIdentity`;
		const fields = {
			kid: true,
			active: true,
			description: true,
			project: true,
			host: true
		};
		const readDirectory = (f) => substrateQuery(substrateUrl, { [key]: {
			params: { limit: 200 },
			fields: f
		} }, { fetchImpl });
		let data = await readDirectory({
			...fields,
			roaming: true
		});
		if (!Object.hasOwn(data, key)) data = await readDirectory(fields);
		directoryRows = Object.hasOwn(data, key) ? data[key] : null;
		directoryKids = directoryRows === null ? null : directoryRows.map((r) => r.kid);
		activeKids = directoryRows === null ? null : directoryRows.filter((r) => r.active !== false).map((r) => r.kid);
	} catch {
		directoryKids = null;
	}
	return {
		directoryRows,
		directoryKids,
		activeKids
	};
}
/**
* whoami plus the salient-tier and recall probes, read-only. Without a server
* each answers `unknown` with the reason.
*
* @param {{ substrateUrl: string|null, env: Record<string, string|undefined>,
*           targetDir: string, fetchImpl: typeof fetch, kid: string|null,
*           declaredKid?: string|null }} p
*/
async function probeServer({ substrateUrl, env, targetDir, fetchImpl, kid, declaredKid = null }) {
	let salientFindings = [check("salient.rank", "unknown", "SUBSTRATE_URL is not set, so the salient tier could not be probed", "the audit cannot reach a server to ask whether ranking is semantic")];
	let recallFindings = [check("recall.available", "unknown", "SUBSTRATE_URL is not set, so semantic recall could not be probed", "the audit cannot reach a server to ask whether recall answers")];
	let whoami = {
		ok: false,
		failed: "SUBSTRATE_URL is not set, so the server could not be asked"
	};
	if (substrateUrl !== null) {
		const ns = env.SUBSTRATE_NAMESPACE ?? "cortext";
		whoami = await probeWhoami(substrateUrl, { fetchImpl });
		const ruleKey = `${ns}/AgentRule`;
		const anchorKey = `${ns}/AnchorIntent`;
		const projectSlug$1 = projectSlug(targetDir, env);
		const projectWhere$1 = projectWhere(projectSlug$1);
		let activeRuleIds = [];
		let anchorId = null;
		let anchorHistory = null;
		let failed = null;
		try {
			const data = await substrateQuery(substrateUrl, {
				[ruleKey]: {
					params: {
						where: {
							...projectWhere$1,
							active: { eq: true }
						},
						limit: 200
					},
					fields: { id: true }
				},
				[anchorKey]: {
					params: {
						where: projectWhere$1,
						limit: 1,
						orderBy: [{ createdAt: "desc" }]
					},
					fields: { id: true }
				}
			}, {
				fetchImpl,
				onFrameFailure: (k, d) => failed = `${k}: ${d}`
			});
			activeRuleIds = (Object.hasOwn(data, ruleKey) ? data[ruleKey] : []).map((r) => r.id).filter((id) => typeof id === "string");
			anchorId = (Object.hasOwn(data, anchorKey) ? data[anchorKey] : [])[0]?.id ?? null;
			if (anchorId === null && projectSlug$1 !== null) {
				let everFailed = null;
				const ever = await substrateQuery(substrateUrl, { [anchorKey]: {
					params: {
						where: { project: { eq: projectSlug$1 } },
						limit: 1
					},
					fields: { id: true }
				} }, {
					fetchImpl,
					onFrameFailure: (k, d) => everFailed = `${k}: ${d}`
				});
				anchorHistory = everFailed !== null || !Object.hasOwn(ever, anchorKey) ? null : ever[anchorKey].length > 0 ? "archived" : "none";
			}
		} catch (err) {
			failed = String(err?.message ?? err);
		}
		if (failed === null) {
			const ruleRefs = toRefs(activeRuleIds.map((id) => ({ id })), ns, "AgentRule");
			const anchorRefs = anchorId === null ? [] : toRefs([{ id: anchorId }], ns, "AnchorIntent");
			let probeFailed = null;
			const vectors = /* @__PURE__ */ new Map();
			for (const group of [ruleRefs, anchorRefs]) {
				if (group.length === 0) continue;
				const got = await fetchRowVectors(substrateUrl, group, {
					fetchImpl,
					onFrameFailure: (k, d) => probeFailed = `${k}: ${d}`
				});
				for (const [id, v] of got) vectors.set(id, v);
			}
			if (probeFailed === null && vectors.size === 0 && ruleRefs.length > 0) probeFailed = "the vector fetch returned nothing and reported no reason";
			salientFindings = auditSalientTier({
				probe: {
					vectors,
					failed: probeFailed
				},
				activeRuleIds,
				anchorId,
				anchorHistory
			});
		} else salientFindings = auditSalientTier({
			probe: {
				vectors: /* @__PURE__ */ new Map(),
				failed
			},
			activeRuleIds: [],
			anchorId: null
		});
		let recallReason = null;
		const rows = await recall(substrateUrl, {
			query: "audit probe: is semantic recall reachable",
			namespace: ns,
			type: "Memory",
			k: 1,
			boost: false,
			fetchImpl,
			onFrameFailure: (k, d) => recallReason = `${k}: ${d}`
		});
		recallFindings = auditSemanticRecall({
			answered: rows !== null,
			credentialAttributed: credentialIsTargets({
				whoami,
				resolvedKid: kid,
				declaredKid
			}),
			reachable: failed === null,
			reason: recallReason ?? failed ?? "the recall frame did not answer and gave no reason"
		});
	}
	return {
		whoami,
		salientFindings,
		recallFindings
	};
}

//#endregion
//#region ../synoptic/src/audit-facts/groups.js
/** @param {Record<string, any>} facts every gatherer's output, plus the target and cwd. */
function buildGroups(facts) {
	const { pin, installedVersion, cloneFreshness, cloneDetail, opencodeSkinVersion, installedRegistry, candidates, cacheDirState, servedVersion, servedRootState, resolution, kid, source, declaredName, declaredKid, keyNames, revokedNames, directoryKids, activeKids, directoryRows, whoami, authWarning, targetDir, cwd, env, keyRefs, refScanComplete, mcpJsonFacts, salientFindings, recallFindings, settingsFindings, fleetFindings, hostFindings } = facts;
	return [
		["pin", auditPin({
			pin,
			installedVersion,
			cloneFreshness,
			cloneDetail,
			compare: compareVersions
		}).map((f) => check(f.id, f.state, f.text, f.detail))],
		["skins", auditSkin({
			pinVersion: pin?.version ?? null,
			opencodeInstalledVersion: opencodeSkinVersion,
			compare: compareVersions
		}).map((f) => check(f.id, f.state, f.text, f.detail))],
		["plugin", auditPlugin({
			installedVersion,
			installedRegistry,
			cacheVersions: candidates.map((c) => c.version),
			cacheDir: cacheDirState,
			servedVersion,
			servedRoot: servedRootState,
			compare: compareVersions
		})],
		["fragment", auditFragment(resolution)],
		["identity", auditIdentity({
			resolvedKid: kid,
			source,
			declaredName,
			keyFilePresent: keyNames === null || kid === null ? null : keyNames.includes(kid.split("@")[0]),
			directoryKids
		})],
		["authority", auditAuthority({
			whoami,
			declaredKid,
			selfAudit: targetDir === cwd,
			authWarning,
			expectedNamespaces: createCortext(env.SUBSTRATE_NAMESPACE ?? "cortext").namespaces,
			expectedCapabilities: createCortext(env.SUBSTRATE_NAMESPACE ?? "cortext").needs,
			resolvedKid: kid
		})],
		["drift", [...auditOrphans({
			keyNames,
			revokedNames,
			directoryKids,
			activeKids,
			directoryRows,
			keyRefs,
			refScanComplete
		}), ...directoryRows !== null && directoryRows.length >= 200 ? [check("directory.truncated", "unknown", `read ${directoryRows.length} AgentIdentity rows, the query limit, so some may be missing`, "\"unregistered\" and \"never reported\" findings may be false; this audit does not page")] : []]],
		["mcp-json", auditMcpJson(mcpJsonFacts)],
		["inbox push", auditInboxPush({ env })],
		["salient tier", [...salientFindings, ...recallFindings]],
		["settings", settingsFindings],
		...fleetFindings === null ? [] : [["fleet", fleetFindings]],
		...hostFindings === null ? [] : [["hosts", hostFindings]]
	];
}

//#endregion
//#region ../synoptic/src/audit-facts/identity.js
/**
* The signing identity of the MCP server serving THIS repo.
*
* ## Read this before touching it
*
* It must not come from `process.env`. The auditing shell can carry no
* `SUBSTRATE_AGENT_KEY_ID` while the MCP child does, because `.mcp.json`
* supplies it per-server. An audit reading its own environment reports "no
* identity" on a correctly configured box — a false negative that would send
* someone off to re-provision a working identity.
*
* ## And why it extracts ONE variable instead of dumping
*
* `/proc/<pid>/environ` carries `SUBSTRATE_AGENT_KEY_PATH` and `SUBSTRATE_DATABASE_URL`
* beside the kid. Dumping it and filtering the output afterwards has already
* leaked a live Postgres password in this fleet, because the filter masked the
* patterns someone had thought of and not the one they had not. So this reads
* the buffer, pulls out exactly the two names it needs, returns the kid and a
* BOOLEAN for the key, and never returns or logs anything else.
*
* `/proc` is Linux-only. Elsewhere this returns nulls, which surface as
* `unknown` — not as "no identity".
*/
function resolveIdentityFromMcp(targetDir) {
	const procs = listOrNull("/proc");
	if (procs === null) return {
		kid: null,
		keyEnvSet: null,
		source: null
	};
	for (const d of procs) {
		if (!/^\d+$/.test(d.name)) continue;
		let cwd = null;
		try {
			if (!readFileSync(`/proc/${d.name}/cmdline`, "utf8").includes("substrate")) continue;
			cwd = readlinkSync(`/proc/${d.name}/cwd`);
		} catch {
			continue;
		}
		if (cwd !== targetDir) continue;
		const raw = readOrNull(`/proc/${d.name}/environ`);
		if (raw === null) continue;
		let kid = null;
		let keyEnvSet = false;
		for (const entry of raw.split("\0")) if (entry.startsWith("SUBSTRATE_AGENT_KEY_ID=")) kid = entry.slice(23);
		else if (entry.startsWith("SUBSTRATE_AGENT_KEY_PATH=")) keyEnvSet = true;
		if (kid !== null) return {
			kid,
			keyEnvSet,
			source: `mcp server pid ${d.name}`
		};
	}
	return {
		kid: null,
		keyEnvSet: null,
		source: null
	};
}
/**
* The kid the TARGET repo pins for itself.
*
* First `.mcp.json` (a literal `SUBSTRATE_AGENT_KEY_ID` — never a `${VAR}` ref, which
* commits to nothing), then the repo's own `.claude/settings.local.json`
* `env`. Both are DECLARATIONS, not measurements — they say which identity
* the repo intends to sign as, which is enough to reject a grant read under
* someone else's credential and not enough to prove the key on disk matches.
* The settings file matters because the post-shell-carrier `.mcp.json` names
* no identity at all: it inherits settings `env` at spawn, and without this
* fallback a plain-shell audit of such a repo could never name its subject.
* Two sources naming different kids is ambiguous, so it answers null rather
* than picking one.
*/
function readDeclaredKid(targetDir) {
	let parsed = null;
	try {
		parsed = JSON.parse(readOrNull(join(targetDir, ".mcp.json")) ?? "null");
	} catch {
		parsed = null;
	}
	const kids = /* @__PURE__ */ new Set();
	for (const server of Object.values(parsed?.mcpServers ?? {})) {
		const kid = mcpEnvLiteral(server?.env?.SUBSTRATE_AGENT_KEY_ID);
		if (kid !== null) kids.add(kid);
	}
	if (kids.size > 1) return null;
	if (kids.size === 1) return [...kids][0];
	const settingsRaw = readOrNull(join(targetDir, ".claude", "settings.local.json"));
	if (settingsRaw === null) return null;
	try {
		const kid = JSON.parse(settingsRaw)?.env?.SUBSTRATE_AGENT_KEY_ID;
		return typeof kid === "string" && kid !== "" ? kid : null;
	} catch {
		return null;
	}
}
/** The repo's declared agent name, when it carries one. */
function readDeclaredName(targetDir) {
	const raw = readOrNull(join(targetDir, ".claude", "settings.json"));
	if (raw === null) return null;
	try {
		return JSON.parse(raw)?.env?.SYNOPTIC_AGENT_NAME ?? null;
	} catch {
		return null;
	}
}
/** Live and revoked key names in `keysDir`; both null when it cannot be read. */
function readKeyFiles(keysDir) {
	const keyEntries = listOrNull(keysDir);
	return {
		keyNames: keyEntries === null ? null : keyEntries.filter((f) => f.name.endsWith(".key")).map((f) => f.name.replace(/\.key$/, "")),
		revokedNames: keyEntries === null ? null : keyEntries.filter((f) => f.name.endsWith(".key.revoked")).map((f) => f.name.replace(/\.key\.revoked$/, ""))
	};
}

//#endregion
//#region ../synoptic/src/audit-facts/key-refs.js
/**
* Which key files are actually SIGNED WITH, and under which kid.
*
* A key file's name is not its identity. `claude-agent.key` signs as
* `claude-code@host-a`, and the only place that binding is written down is
* the `.mcp.json` that configures the pair — so that is what has to be read
* before calling a key unowned.
*
* Handles both `${VAR}` and `${VAR:-fallback}`: the fallback is the interesting
* half, because it is the literal a repo commits to when the environment
* supplies nothing.
*
* @param {ReadonlyArray<string>} files absolute paths to candidate .mcp.json
* @returns {Array<{ keyName: string, kid: string, source: string }>}
*/
function scanKeyRefs(files) {
	const refs = [];
	for (const f of files) {
		const raw = readOrNull(f);
		if (raw === null) continue;
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		for (const server of Object.values(parsed?.mcpServers ?? {})) {
			const keyPath = mcpEnvLiteral(server?.env?.SUBSTRATE_AGENT_KEY_PATH);
			const kid = mcpEnvLiteral(server?.env?.SUBSTRATE_AGENT_KEY_ID);
			if (keyPath === null || kid === null) continue;
			const keyName = (keyPath.split("/").pop() ?? "").replace(/\.(key|pub)$/, "");
			if (keyName !== "") refs.push({
				keyName,
				kid,
				source: f
			});
		}
	}
	return refs;
}
/** @param {{ fleetDir: string|null, targetDir: string, home: string }} p */
function gatherKeyRefs({ fleetDir, targetDir, home }) {
	const refScanDirs = fleetDir === null ? [targetDir] : (listOrNull(fleetDir) ?? []).filter((e) => e.isDirectory()).map((e) => join(fleetDir, e.name));
	const systemdUserDir = join(home, ".config", "systemd", "user");
	const systemdUnits = (listOrNull(systemdUserDir) ?? []).filter((e) => e.name.endsWith(".service")).map((e) => join(systemdUserDir, e.name));
	return {
		keyRefs: [
			...scanKeyRefs(refScanDirs.map((d) => join(d, ".mcp.json"))),
			...scanMiseRefs(refScanDirs.map((d) => ({
				path: join(d, "mise.toml"),
				text: readOrNull(join(d, "mise.toml"))
			}))),
			...scanCodexRefs(refScanDirs.map((d) => {
				const path = join(d, ".codex", "cortext.local.json");
				return {
					path,
					text: readOrNull(path)
				};
			})),
			...scanSystemdRefs(systemdUnits.map((path) => ({
				path,
				text: readOrNull(path)
			})))
		],
		refScanComplete: fleetDir !== null
	};
}

//#endregion
//#region ../synoptic/src/audit-facts/pin.js
/** @param {{ pluginsDir: string, fetch: boolean }} p `fetch` verifies the clone against its remote. */
function readPinFacts({ pluginsDir, fetch }) {
	const marketplacesDir = join(pluginsDir, "marketplaces");
	const pin = readMarketplacePin({
		marketplacesDir,
		listDir: (d) => (listOrNull(d) ?? []).filter((e) => e.isDirectory()).map((e) => e.name),
		readFile: readOrNull
	});
	let cloneFreshness = "unchecked";
	let cloneDetail = null;
	if (fetch === true && pin !== null) try {
		const clone = join(marketplacesDir, pin.marketplace);
		const git = (...args) => execFileSync("git", [
			"-C",
			clone,
			...args
		], {
			encoding: "utf8",
			timeout: 15e3
		}).trim();
		execFileSync("git", [
			"-C",
			clone,
			"fetch",
			"--quiet"
		], {
			timeout: 15e3,
			stdio: "ignore"
		});
		const behind = Number(git("rev-list", "--count", "HEAD..@{u}"));
		const ahead = Number(git("rev-list", "--count", "@{u}..HEAD"));
		const local = git("rev-parse", "--short", "HEAD");
		const remote = git("rev-parse", "--short", "@{u}");
		if (behind > 0) {
			cloneFreshness = "behind";
			cloneDetail = `local ${local}, remote ${remote} — ${behind} commit(s) behind` + (ahead > 0 ? ` and ${ahead} ahead (diverged)` : "");
		} else if (ahead > 0) {
			cloneFreshness = "ahead";
			cloneDetail = `local ${local}, remote ${remote} — ${ahead} commit(s) ahead`;
		} else cloneFreshness = "current";
	} catch {
		cloneFreshness = "unchecked";
		cloneDetail = null;
	}
	return {
		marketplacesDir,
		pin,
		cloneFreshness,
		cloneDetail
	};
}
/** @param {{ home: string }} p */
function readSkinFacts({ home }) {
	return { opencodeSkinVersion: newestOpencodeSkin({
		cacheRoot: join(home, ".cache", "opencode"),
		listDir: (d) => (listOrNull(d) ?? []).filter((e) => e.isDirectory()).map((e) => e.name),
		readFile: readOrNull,
		compare: compareVersions
	}) };
}

//#endregion
//#region ../synoptic/src/fragment-drift.js
/** `<!-- substrate-conventions vsynoptic-1.4.1+446ab494 — ... -->` */
const MARKER_RE = /^<!-- substrate-conventions vsynoptic-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+([0-9a-f]{8}))?/;
/**
* Parse line 1's marker.
*
* `digest: null` is a real and distinct answer, not a missing value: markers
* predating the digest suffix (`vsynoptic-0.1.0`) carry a version and nothing to compare content with.
*
* @param {string} text
* @returns {{ version: string, digest: string|null }|null}
*/
function readMarker(text) {
	const match = MARKER_RE.exec(String(text ?? "").split("\n", 1)[0] ?? "");
	if (!match) return null;
	return {
		version: match[1],
		digest: match[2] ?? null
	};
}

//#endregion
//#region ../synoptic/src/audit-facts/plugin.js
/**
* @param {{ pluginsDir: string, cacheDir: string, targetDir: string,
*           envRoot: string|null, selfRoot: string }} p
*   `envRoot` is CLAUDE_PLUGIN_ROOT when set; `selfRoot` is the plugin root
*   this audit is running from.
*/
function gatherPluginFacts({ pluginsDir, cacheDir, targetDir, envRoot, selfRoot }) {
	let installedVersion = null;
	let installedRegistry = "unreadable";
	try {
		const e = JSON.parse(readFileSync(join(pluginsDir, "installed_plugins.json"), "utf8"))?.plugins?.["cortext@mnmal-ai"];
		if (!Array.isArray(e) || e.length === 0) installedRegistry = "no-entry";
		else {
			installedVersion = e[0].version ?? null;
			installedRegistry = installedVersion === null ? "malformed" : "present";
		}
	} catch {
		installedRegistry = "unreadable";
	}
	const cacheListing = listOrNull(cacheDir);
	const cacheDirState = cacheListing === null ? "unreadable" : "readable";
	const cacheEntries = cacheListing ?? [];
	const candidates = [];
	for (const d of cacheEntries) {
		if (!d.isDirectory()) continue;
		const text = readOrNull(join(cacheDir, d.name, "fragments", "substrate-conventions.md"));
		if (text === null) continue;
		const m = readMarker(text);
		candidates.push({
			version: m?.version ?? d.name,
			digest: m?.digest ?? null,
			origin: `cache/${d.name}`,
			text
		});
	}
	const servedRoot = envRoot ?? selfRoot;
	const servedRootState = envRoot !== null ? "set" : selfRoot.startsWith(`${cacheDir}/`) ? "derived-cache" : "derived-source";
	const servedVersion = readMarker(readOrNull(join(servedRoot, "fragments", "substrate-conventions.md")) ?? "")?.version ?? null;
	const repoFragment = readMarker(readOrNull(join(targetDir, ".claude", "substrate-conventions.md")) ?? "");
	const resolution = resolveFragmentSource({
		candidates,
		installedVersion,
		servedVersion,
		installedFragment: repoFragment,
		isSourceRepo: isFragmentSourceRepo({
			cwd: targetDir,
			exists: existsSync
		})
	});
	return {
		installedVersion,
		installedRegistry,
		cacheDirState,
		candidates,
		servedVersion,
		servedRootState,
		resolution
	};
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
	"SYNOPTIC_COLD_START_MEMORY",
	"SYNOPTIC_COLD_START_SALIENT",
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
//#region ../synoptic/src/audit-entry.js
const BOOLEAN_FLAGS = /* @__PURE__ */ new Set(["fetch"]);
function parseArgs(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		const name = argv[i].slice(2);
		flags[name] = BOOLEAN_FLAGS.has(name) ? true : argv[++i];
	}
	return flags;
}
const flags = parseArgs(process.argv.slice(2));
const requestedDir = (() => {
	const dir = resolve(flags["target-dir"] ?? process.cwd());
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
})();
const targetDir = sessionRoot(requestedDir);
const pluginsDir = flags["plugins-dir"] ?? join(homedir(), ".claude", "plugins");
const cacheDir = join(pluginsDir, "cache", "mnmal-ai", "cortext");
const keysDir = join(homedir(), ".config/substrate/keys");
const envRoot = process.env.CLAUDE_PLUGIN_ROOT ?? null;
const selfRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = gatherPluginFacts({
	pluginsDir,
	cacheDir,
	targetDir,
	envRoot,
	selfRoot
});
const { kid, source } = resolveIdentityFromMcp(targetDir);
const { keyNames, revokedNames } = readKeyFiles(keysDir);
const { env } = envWithLocalFallback(process.env, { targetDir });
const substrateUrl = env.SUBSTRATE_URL ?? null;
const agentAuth = createAgentAuth(env);
const fetchImpl = makeSignedFetch(agentAuth.getAuthHeader);
const directory = await readDirectory({
	substrateUrl,
	env,
	fetchImpl
});
const authWarning = agentAuth.warning;
const declaredKid = readDeclaredKid(targetDir);
const server = await probeServer({
	substrateUrl,
	env,
	targetDir,
	fetchImpl,
	kid,
	declaredKid
});
const settingsFindings = checkSettings({
	settingsText: readOrNull(join(targetDir, ".claude", "settings.local.json")),
	hasProjectMcp: existsSync(join(targetDir, ".mcp.json"))
}).map((f, i) => check(`settings.${i}`, f.state, f.text, f.detail));
const pinFacts = readPinFacts({
	pluginsDir,
	fetch: flags.fetch === true
});
const fleetDir = flags.fleet ?? null;
const fleet = await gatherFleet({
	fleetDir,
	directoryRows: directory.directoryRows,
	candidates: plugin.candidates,
	substrateUrl,
	env,
	fetchImpl
});
const refs = gatherKeyRefs({
	fleetDir,
	targetDir,
	home: homedir()
});
const skins = readSkinFacts({ home: homedir() });
const groups = buildGroups({
	...plugin,
	kid,
	source,
	declaredName: readDeclaredName(targetDir),
	declaredKid,
	keyNames,
	revokedNames,
	...directory,
	...server,
	authWarning,
	env,
	targetDir,
	cwd: process.cwd(),
	settingsFindings,
	mcpJsonFacts: readMcpJsonFacts(targetDir),
	...pinFacts,
	...skins,
	...fleet,
	...refs
});
const report = renderAudit(groups);
console.log(report);
process.exit(/\[WARN\]|\[\?\?\?\?\]/.test(report) ? 1 : 0);

//#endregion
export {  };