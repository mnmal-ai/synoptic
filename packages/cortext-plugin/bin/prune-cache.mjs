#!/usr/bin/env node
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

//#region ../synoptic/src/cache-prune.js
/**
* Decide what to delete.
*
* Pure: no filesystem access, so the whole policy is testable without a cache.
*
* @param {object} p
* @param {ReadonlyArray<string>} p.versions Directory names in the cache.
* @param {string|null} p.installedVersion From `installed_plugins.json`.
* @param {string|null} p.servedVersion The version serving this session.
* @param {number} [p.keep=2] How many to retain: installed plus rollbacks.
* @param {(a: string, b: string) => number} p.compare
* @returns {{ keep: Array<string>, remove: Array<string>, refusal: string|null,
*             protectedReason: Record<string, string> }}
*/
function planCachePrune({ versions, installedVersion, servedVersion, keep = 2, compare }) {
	const protectedReason = {};
	if (installedVersion === null || installedVersion === void 0) return {
		keep: [...versions],
		remove: [],
		refusal: "no installed version could be determined, so there is no floor to protect. Refusing to prune — \"keep the highest N\" would happily delete the version in use on a box whose registry is unreadable.",
		protectedReason
	};
	if (!versions.includes(installedVersion)) return {
		keep: [...versions],
		remove: [],
		refusal: `the installed version (${installedVersion}) is not present in the cache. That is a broken install, not a pruning opportunity — deleting anything here would remove a fallback while the thing it falls back to is already missing.`,
		protectedReason
	};
	const ordered = [...versions].sort((a, b) => compare(b, a));
	const keepSet = /* @__PURE__ */ new Set();
	keepSet.add(installedVersion);
	protectedReason[installedVersion] = "installed";
	if (servedVersion !== null && servedVersion !== void 0 && versions.includes(servedVersion)) {
		if (!keepSet.has(servedVersion)) {
			keepSet.add(servedVersion);
			protectedReason[servedVersion] = "serving this session";
		}
	}
	for (const v of ordered) {
		if (keepSet.size >= Math.max(keep, keepSet.size === 0 ? 1 : keepSet.size)) break;
		if (!keepSet.has(v)) {
			keepSet.add(v);
			protectedReason[v] = "rollback";
		}
	}
	const remove = ordered.filter((v) => !keepSet.has(v));
	return {
		keep: ordered.filter((v) => keepSet.has(v)),
		remove,
		refusal: null,
		protectedReason
	};
}
/** Human-readable plan. Rendered before anything is deleted, always. */
function renderPrunePlan(plan, { apply = false } = {}) {
	const lines = ["cortext plugin cache — prune plan", ""];
	if (plan.refusal !== null) {
		lines.push(`  REFUSED: ${plan.refusal}`);
		lines.push("");
		lines.push("  Nothing was deleted.");
		return lines.join("\n");
	}
	for (const v of plan.keep) lines.push(`  KEEP    ${v.padEnd(10)} (${plan.protectedReason[v] ?? "kept"})`);
	for (const v of plan.remove) lines.push(`  ${apply ? "DELETE " : "would  "} ${v}`);
	lines.push("");
	if (plan.remove.length === 0) lines.push("  Nothing to prune.");
	else if (apply) lines.push(`  Deleted ${plan.remove.length} cached version(s).`);
	else lines.push(`  ${plan.remove.length} cached version(s) would be removed. Re-run with --apply to delete them.`);
	return lines.join("\n");
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
//#region ../synoptic/src/cache-prune-entry.js
function parseArgs(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		const name = argv[i].slice(2);
		flags[name] = name === "apply" ? true : argv[++i];
	}
	return flags;
}
const flags = parseArgs(process.argv.slice(2));
const pluginsDir = flags["plugins-dir"] ?? join(homedir(), ".claude", "plugins");
const cacheDir = join(pluginsDir, "cache", "mnmal-ai", "cortext");
const keep = Number(flags.keep ?? 2);
let versions = [];
try {
	versions = readdirSync(cacheDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
} catch {
	console.log("cortext plugin cache — prune plan\n\n  REFUSED: cache directory not readable.");
	process.exit(1);
}
let installedVersion = null;
try {
	const e = JSON.parse(readFileSync(join(pluginsDir, "installed_plugins.json"), "utf8"))?.plugins?.["cortext@mnmal-ai"];
	if (Array.isArray(e) && e.length > 0) installedVersion = e[0].version ?? null;
} catch {}
function selfRoot() {
	try {
		return dirname(dirname(fileURLToPath(import.meta.url)));
	} catch {
		return null;
	}
}
const servedRoot = selfRoot() ?? process.env.CLAUDE_PLUGIN_ROOT ?? null;
let servedVersion = null;
if (servedRoot !== null) {
	try {
		const text = readFileSync(join(servedRoot, "fragments", "substrate-conventions.md"), "utf8");
		servedVersion = readMarker(text)?.version ?? null;
	} catch {
		servedVersion = null;
	}
	if (servedVersion === null) {
		const base = servedRoot.replace(/\/+$/, "").split("/").pop();
		if (versions.includes(base)) servedVersion = base;
	}
}
const plan = planCachePrune({
	versions,
	installedVersion,
	servedVersion,
	keep,
	compare: compareVersions
});
if (plan.refusal !== null) {
	console.log(renderPrunePlan(plan, { apply: false }));
	process.exit(1);
}
if (flags.apply === true) for (const v of plan.remove) rmSync(join(cacheDir, v), {
	recursive: true,
	force: true
});
console.log(renderPrunePlan(plan, { apply: flags.apply === true }));
process.exit(0);

//#endregion
export {  };