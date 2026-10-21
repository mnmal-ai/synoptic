// Across-repo conventions-fragment reconciliation.
//
// ## Why no single-repo check sees it
//
// Repos on one box can hold several distinct fragment revisions at once, and
// an old revision can keep teaching an agent something the current one has
// corrected. Every single-repo instrument can be working correctly while that
// aggregate state stays invisible, because each is SINGLE-REPO by construction:
//
//   - the cold-start drift check compares THIS repo against the best locally
//     available plugin copy. On a box whose plugin is stale it is CORRECT to be
//     quiet — and in a repo nobody opened it never runs at all, since a
//     cold-start only fires when someone starts a session there.
//   - `--audit` answers "is this repo current" and cannot answer "is the fleet
//     consistent".
//   - the resolver acts only on the repo it is pointed at.
//
// Nobody owns the across-repo view because no single-repo tool can hold it.
//
// ## Why this reports the SPREAD and not just staleness
//
// "app is three revisions behind" is a fact about app. "Six repos on five
// revisions" is a fact about the PROPAGATION MECHANISM, and it is the one that
// says the mechanism is not working. A per-repo report prints six lines, each
// individually defensible, and never says the thing that matters.
//
// ## Why it hashes the body instead of trusting the marker
//
// The marker's `+<sha8>` is a CLAIM about content. A hand-edited fragment keeps
// its marker and changes its body, and this repo has already shipped one defect
// where a marker and its content disagreed. So the body is hashed here and
// compared against what the marker claims — a disagreement is its own finding,
// and a stronger one than staleness, because it means the file is lying about
// what it is.

/** `<!-- substrate-conventions vsynoptic-1.11.0+cd38093c ... -->` */
const MARKER_RE =
  /^<!-- substrate-conventions vsynoptic-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+([0-9a-f]{8}))?/;

/**
 * Split a fragment the way the stamper does: line 1 is the marker, everything
 * after it is what the digest covers. Excluding the marker keeps the digest
 * from being self-referential.
 *
 * @returns {{ version: string, claimed: string|null, body: string }|null}
 *   null when line 1 is not a marker — a structurally broken file.
 */
export function readFragment(text) {
  const s = String(text ?? '');
  const nl = s.indexOf('\n');
  if (nl === -1) return null;
  const m = MARKER_RE.exec(s.slice(0, nl));
  if (m === null) return null;
  return { version: m[1], claimed: m[2] ?? null, body: s.slice(nl + 1) };
}

/**
 * The comparable form of a hostname. Hostnames differ in case across the fleet
 * (`host-a` vs `Host-A`), and a resolver may append a domain.
 */
export function normaliseHost(host) {
  return String(host ?? '')
    .trim()
    .toLowerCase()
    .split('.')[0];
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
export function scopeFleetToHost({ repoNames, thisHost, directoryRows }) {
  const here = [];
  const elsewhere = [];
  const unclaimed = [];
  const findings = [];
  const self = normaliseHost(thisHost);

  if (directoryRows === null || directoryRows === undefined || self === '') {
    findings.push({
      id: 'fleet.population',
      state: 'unknown',
      text:
        self === ''
          ? "this host's name could not be resolved, so no repo could be placed"
          : 'the AgentIdentity directory could not be read, so no repo could be placed',
      detail: `${repoNames.length} local checkout(s) were NOT surveyed. Which of them are worked on this host is unknown, and surveying them all as local is the failure this check exists to prevent`
    });
    return { placed: false, here, elsewhere, unclaimed, findings };
  }

  // project -> the hosts its active agents run on, original spelling kept for
  // the report.
  const hostsOf = new Map();
  for (const r of directoryRows) {
    if (r.active === false || typeof r.project !== 'string' || r.project === '') continue;
    const at = typeof r.kid === 'string' ? r.kid.lastIndexOf('@') : -1;
    const host = r.host ?? (at > 0 ? r.kid.slice(at + 1) : null);
    if (host === null || host === '') continue;
    const set = hostsOf.get(r.project) ?? new Map();
    set.set(normaliseHost(host), host);
    hostsOf.set(r.project, set);
  }

  for (const name of repoNames) {
    const hosts = hostsOf.get(name);
    if (hosts === undefined) unclaimed.push(name);
    else if (hosts.has(self)) here.push(name);
    else elsewhere.push({ name, hosts: [...hosts.values()].sort() });
  }

  if (elsewhere.length > 0) {
    findings.push({
      id: 'fleet.elsewhere',
      state: 'unknown',
      text: `${elsewhere.length} local cop${elsewhere.length === 1 ? 'y is of a repo' : 'ies are of repos'} worked on another host, not counted: ${elsewhere
        .map((e) => `${e.name} (worked on ${e.hosts.join(', ')})`)
        .join(', ')}`,
      detail:
        'these local copies are not the ones that matter, and this box cannot see the ones that do. Run --fleet on that host to audit them; do not fix the fragment here'
    });
  }
  if (unclaimed.length > 0) {
    findings.push({
      id: 'fleet.unclaimed',
      state: 'unknown',
      text: `${unclaimed.length} repo(s) claimed by no active AgentIdentity, not counted: ${unclaimed.join(', ')}`,
      detail:
        'the directory cannot say where these are worked. Register the agent (or reactivate its row) and they will be placed'
    });
  }
  return { placed: true, here, elsewhere, unclaimed, findings };
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
export function auditFleetFragments({
  repos,
  best,
  digest,
  sourceRepo = null,
  sourceGit,
  population,
  missing = []
}) {
  const bestFragment = best === null || best === undefined ? null : readFragment(best);
  const bestDigest = bestFragment === null ? null : digest(bestFragment.body);

  const rows = repos.map(({ name, text, committed }) => {
    // The repo that SHIPS the fragment is authoritative by construction, and
    // `bestDigest` is the last RELEASED copy — so the source leads the release
    // for the whole window between editing the fragment and publishing it.
    // Comparing it against the release and calling the difference drift gets
    // the direction of authority backwards.
    const isSource = sourceRepo !== null && name === sourceRepo;
    if (text === null || text === undefined) {
      return { name, isSource, readable: false };
    }
    const f = readFragment(text);
    if (f === null) {
      return { name, isSource, readable: true, parsed: false };
    }
    const computed = digest(f.body);
    return {
      name,
      isSource,
      readable: true,
      parsed: true,
      version: f.version,
      claimed: f.claimed,
      computed,
      // A marker that disagrees with its own body is lying about what it is.
      markerHonest: f.claimed === null ? null : f.claimed === computed,
      matchesBest: bestDigest === null ? null : computed === bestDigest,
      // `undefined` = the caller did not read git, `null` = untracked or not a
      // checkout. Both are legitimate and neither is drift; only a readable
      // committed copy that DISAGREES with disk is.
      committed: committed === undefined || committed === null ? committed : readFragment(committed)
    };
  });

  const findings = [];
  const parsed = rows.filter((r) => r.parsed === true);
  // Without scoping the sentence is unchanged; with it, it names its population.
  const reposWord = population === undefined ? 'repos' : 'repos worked here';
  const left = population === undefined ? 0 : population.elsewhere + population.unclaimed;
  const leftOut =
    left === 0
      ? ''
      : ` (${left} local cop${left === 1 ? 'y' : 'ies'} of repos not worked here not counted)`;

  const unreadable = rows.filter((r) => r.readable === false).map((r) => r.name);
  if (unreadable.length > 0) {
    findings.push({
      id: 'fleet.unreadable',
      state: 'unknown',
      text: `${unreadable.length} repo fragment(s) could not be read: ${unreadable.join(', ')}`,
      detail: 'these are not counted in the spread below, so the spread is a floor'
    });
  }

  // A fragment-less checkout is reported, not skipped before scoping, so an
  // onboarded repo that lost its fragment does not read as fine.
  if (missing.length > 0) {
    findings.push({
      id: 'fleet.missing',
      state: 'warn',
      text: `${missing.length} repo(s) worked here have no conventions fragment: ${[...missing].sort().join(', ')}`,
      detail:
        'each has an active agent on this host, so it opted in and is reading none of the conventions. Run /substrate-setup in each to install the fragment and its CLAUDE.md import'
    });
  }

  const unparsed = rows.filter((r) => r.readable === true && r.parsed !== true).map((r) => r.name);
  if (unparsed.length > 0) {
    findings.push({
      id: 'fleet.unparsed',
      state: 'warn',
      text: `${unparsed.length} fragment(s) have no marker on line 1: ${unparsed.join(', ')}`,
      detail:
        'a fragment with no marker cannot be compared or updated by digest — it was hand-created or truncated'
    });
  }

  // THE HEADLINE. Not per-repo staleness — the number of distinct bodies.
  const byDigest = new Map();
  for (const r of parsed) {
    const set = byDigest.get(r.computed) ?? [];
    set.push(r.name);
    byDigest.set(r.computed, set);
  }
  if (byDigest.size > 1) {
    const groups = [...byDigest.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([d, names]) => `${d}: ${names.join(', ')}`);
    // Two states produce a spread and they have different causes. If the ONLY
    // disagreement is the source repo standing alone and every consumer agrees
    // with every other consumer, propagation is working and the source is
    // simply ahead of the last release — the normal state between a fragment
    // edit and its publish. Asserting "the propagation mechanism is not
    // reaching every consumer" there is a true verdict with a false cause
    // attached.
    //
    // The source is still COUNTED and still LISTED. A fleet view that quietly
    // drops a repo is the absence-mistaken-for-nothing failure this audit
    // exists to catch, so the honest move is to keep the number and fix the
    // sentence.
    const consumerDigests = new Set(parsed.filter((r) => !r.isSource).map((r) => r.computed));
    const sourceRow = parsed.find((r) => r.isSource) ?? null;
    const onlySourceDiffers =
      sourceRow !== null &&
      byDigest.size === 2 &&
      consumerDigests.size === 1 &&
      !consumerDigests.has(sourceRow.computed);
    findings.push({
      id: 'fleet.spread',
      state: 'warn',
      text: `${parsed.length} ${reposWord} hold ${byDigest.size} DISTINCT fragment bodies${leftOut}`,
      detail: onlySourceDiffers
        ? sourceGit?.releasedInHistory === false
          ? `every consumer agrees; the difference is ${sourceRow.name}, whose checkout is BEHIND the release — a stale clone of the shipping repo, not a propagation failure. ${groups.join(' | ')}`
          : `every consumer agrees; the difference is ${sourceRow.name}, which SHIPS the fragment and leads the release until it is published — propagation is not implicated. ${groups.join(' | ')}`
        : `the propagation mechanism is not reaching every consumer — ${groups.join(' | ')}`
    });
  } else if (parsed.length > 0) {
    findings.push({
      id: 'fleet.spread',
      state: 'ok',
      text: `all ${parsed.length} ${reposWord} hold the same fragment body${leftOut}`
    });
  }

  // Disk and HEAD are different artifacts wherever the fragment is tracked, and
  // an uncommitted /substrate-setup makes them disagree: disk can read 1.11.0
  // while `git show HEAD:` is still 1.5.0.
  //
  // Both directions mislead, and they mislead different people — the install
  // looks LANDED to this audit, and ABSENT to anyone who clones or to CI. This
  // reports ALONGSIDE the spread above rather than replacing it, because disk
  // is what the agent in that repo actually reads and so stays operative for
  // behaviour. The defect was ever reporting one number for two artifacts.
  const uncommitted = parsed.filter(
    (r) =>
      r.committed !== undefined && r.committed !== null && digest(r.committed.body) !== r.computed
  );
  if (uncommitted.length > 0) {
    findings.push({
      id: 'fleet.uncommitted',
      state: 'warn',
      text: `${uncommitted.length} repo(s) have an UNCOMMITTED fragment: ${uncommitted
        .map((r) => `${r.name} (working tree ${r.version}, HEAD ${r.committed.version})`)
        .join(', ')}`,
      detail:
        'the install was never committed, so this audit sees it and a fresh clone does not. ' +
        'Commit the fragment in each — until then the repo an agent works in and the repo ' +
        'the team shares disagree'
    });
  }

  // A marker disagreeing with its own body outranks staleness: the file is not
  // what it says it is, so every digest-based check downstream is reading a lie.
  const dishonest = parsed.filter((r) => r.markerHonest === false);
  if (dishonest.length > 0) {
    findings.push({
      id: 'fleet.marker',
      state: 'warn',
      text: `${dishonest.length} fragment(s) have a marker that does not match their own body: ${dishonest
        .map((r) => `${r.name} (claims ${r.claimed}, is ${r.computed})`)
        .join(', ')}`,
      detail:
        'hand-edited or partially written. Every digest comparison against these — including the cold-start drift check — is reading a claim rather than the content'
    });
  }

  if (bestDigest === null) {
    findings.push({
      id: 'fleet.current',
      state: 'unknown',
      text: 'no plugin fragment available to compare against',
      detail:
        'the spread above is still meaningful — repos disagreeing with each other is a finding regardless of which is right'
    });
  } else {
    // The source repo is excluded from `behind` rather than filtered out of the
    // report: `resolve-fragment --apply` on it would overwrite the source of
    // truth with the last released copy. The tool refuses that, but it would
    // still be the wrong instruction pointed at the wrong repo, and it could
    // never be satisfied. A check whose clean state is unreachable teaches its
    // reader to skim the block — and this block also carries the stale-fragment
    // findings.
    const behind = parsed.filter((r) => r.matchesBest === false && !r.isSource);
    const sourceAhead = parsed.find((r) => r.isSource && r.matchesBest === false) ?? null;
    // No consumer at all makes "all consumer repos match" vacuously true, and
    // host scoping makes that state routine: a box holding only copies
    // of repos worked elsewhere surveys nothing.
    const consumers = parsed.filter((r) => !r.isSource).length;
    if (consumers > 0 || behind.length > 0)
      findings.push(
        behind.length === 0
          ? {
              id: 'fleet.current',
              state: 'ok',
              text: `all consumer repos match the available ${bestDigest}`
            }
          : {
              id: 'fleet.current',
              state: 'warn',
              text: `${behind.length} consumer repo(s) do not match the available ${bestDigest}: ${behind
                .map((r) => `${r.name} (${r.version}+${r.computed})`)
                .join(', ')}`,
              detail:
                'remedy is one command per repo: bin/resolve-fragment.mjs --target-dir <repo> --apply. It refuses a downgrade and skips the repo that ships the fragment'
            }
      );
    // Reported, never silent — an unpublished edit to the source is exactly
    // what someone reading this block wants to know about.
    //
    // But "differs" has two directions. A source
    // that is AHEAD has the released body somewhere in its history, because it
    // made that release; a stale clone never received it. Without that fact the
    // two read identically, and calling a stale clone `ok` tells its reader
    // nothing is wrong at the moment they are reading an old fragment.
    const direction = sourceGit?.releasedInHistory;
    if (sourceAhead !== null && direction === false) {
      findings.push({
        id: 'fleet.source',
        state: 'warn',
        text: `${sourceAhead.name} SHIPS the fragment but its checkout is BEHIND the released ${bestDigest} (${sourceAhead.version}+${sourceAhead.computed}) — the released body is nowhere in its history`,
        detail:
          'a stale clone of the shipping repo reads exactly like unpublished work. Pull it, and check out the default branch, before trusting any source-vs-release comparison — until then this tree is not authoritative'
      });
    } else if (sourceAhead !== null && direction === null) {
      findings.push({
        id: 'fleet.source',
        state: 'unknown',
        text: `${sourceAhead.name} SHIPS the fragment and differs from the released ${bestDigest} (${sourceAhead.version}+${sourceAhead.computed})`,
        detail:
          'git could not say whether the released body is in its history, so this cannot tell an unpublished edit (ahead) from a stale clone (behind). Check `git log` on the fragment before acting on either reading'
      });
    } else if (sourceAhead !== null) {
      findings.push({
        id: 'fleet.source',
        state: 'ok',
        text: `${sourceAhead.name} SHIPS the fragment and differs from the released ${bestDigest} (${sourceAhead.version}+${sourceAhead.computed})`,
        detail:
          'expected between editing the fragment and publishing it — its tree is authoritative, so this is the release trailing the source rather than the source drifting. It reaches consumers on the next release + /substrate-setup, and NOT before: a version-only bump leaves the digest unchanged and prompts nobody'
      });
    }
  }

  // The source checkout's own position, independent of the digest: the
  // audit reads that tree, so a checkout behind its upstream makes every
  // source-side reading stale, in sync or not. A non-default branch is noted
  // rather than warned — it is the normal state while working — but it says
  // which branch the comparison is actually against.
  const sourceName = sourceRepo;
  if (sourceName !== null && sourceGit !== undefined && sourceGit !== null) {
    const { branch = null, defaultBranch = null, behindUpstream = null } = sourceGit;
    if (typeof behindUpstream === 'number' && behindUpstream > 0) {
      findings.push({
        id: 'fleet.source-checkout',
        state: 'warn',
        text: `${sourceName} checkout is ${behindUpstream} commit(s) behind its upstream${branch ? ` (on ${branch})` : ''}`,
        detail:
          'every source-side reading in this block is taken from that stale tree. Pull it before trusting them'
      });
    } else if (branch !== null && defaultBranch !== null && branch !== defaultBranch) {
      findings.push({
        id: 'fleet.source-checkout',
        state: 'ok',
        text: `${sourceName} checkout is on ${branch}, not ${defaultBranch} — source-side readings are against that branch`
      });
    }
  }

  return { rows, findings };
}
