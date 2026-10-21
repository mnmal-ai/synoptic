#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
/**
* Render the reconciliation a human reads before anything is written.
*
* Printed unconditionally, including on success. The cluster's recurring
* failure is an operation that reported success while the meaning was
* elsewhere, so "what did you actually resolve" has to be visible when nothing
* is wrong too — otherwise the first time anyone reads it is the first time it
* is already too late.
*/
function renderResolution(result) {
	const lines = ["substrate-conventions fragment — resolution", ...result.report.map((r) => `  ${r}`)];
	if (result.chosen !== null) lines.push(`  -> chose ${result.chosen.version}+${result.chosen.digest ?? "(no digest)"} from ${result.chosen.origin}`);
	switch (result.action) {
		case "install":
			lines.push("  -> INSTALL");
			break;
		case "current":
			lines.push("  -> CURRENT (byte-identical body; nothing to do)");
			break;
		case "refuse":
			lines.push(`  -> REFUSED: ${result.reason}`);
			break;
		case "skip-source-repo": lines.push(`  -> SKIPPED: ${result.reason}`);
	}
	return lines.join("\n");
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
//#region ../synoptic/src/fragment-resolve-entry.js
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
const targetDir = flags["target-dir"] ?? process.cwd();
const pluginsDir = flags["plugins-dir"] ?? join(homedir(), ".claude", "plugins");
const cacheDir = join(pluginsDir, "cache", "mnmal-ai", "cortext");
let installedVersion = null;
try {
	const entries = JSON.parse(readFileSync(join(pluginsDir, "installed_plugins.json"), "utf8"))?.plugins?.["cortext@mnmal-ai"];
	if (Array.isArray(entries) && entries.length > 0) installedVersion = entries[0].version ?? null;
} catch {}
const candidates = [];
let cacheVersions = [];
try {
	cacheVersions = readdirSync(cacheDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
} catch {}
for (const v of cacheVersions) {
	const path = join(cacheDir, v, "fragments", "substrate-conventions.md");
	const text = readOrNull(path);
	if (text === null) continue;
	const marker = readMarker(text);
	candidates.push({
		version: marker?.version ?? v,
		digest: marker?.digest ?? null,
		path,
		origin: `cache/${v}`,
		text
	});
}
const servedRoot = process.env.CLAUDE_PLUGIN_ROOT ?? null;
let servedVersion = null;
if (servedRoot !== null) {
	const text = readOrNull(join(servedRoot, "fragments", "substrate-conventions.md"));
	servedVersion = text === null ? null : readMarker(text)?.version ?? null;
}
const installedText = readOrNull(join(targetDir, ".claude", "substrate-conventions.md"));
const installedFragment = installedText === null ? null : readMarker(installedText);
const result = resolveFragmentSource({
	candidates,
	installedVersion,
	servedVersion,
	installedFragment,
	isSourceRepo: isFragmentSourceRepo({
		cwd: targetDir,
		exists: existsSync
	})
});
console.log(renderResolution(result));
if (result.action === "skip-source-repo") process.exit(2);
if (result.action === "refuse") process.exit(1);
if (result.action === "install" && flags.apply === true) {
	const dest = join(targetDir, ".claude", "substrate-conventions.md");
	writeFileSync(dest, result.chosen.text, "utf8");
	console.log(`  -> wrote ${dest}`);
} else if (result.action === "install") console.log("  (dry run — pass --apply to write)");
process.exit(0);

//#endregion
export {  };