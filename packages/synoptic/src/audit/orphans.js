// Key files and kid bindings nothing claims: mise, Codex and systemd references,
// and kids that share a name across hosts.

import { check } from './check.js';

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
export function scanMiseRefs(entries) {
  const out = [];
  for (const { path, text } of entries ?? []) {
    if (typeof text !== 'string') continue;
    const env = {};
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']*)["']\s*(?:#.*)?$/.exec(line);
      if (m !== null) env[m[1]] = m[2];
    }
    const groups = new Map();
    for (const [name, value] of Object.entries(env)) {
      const m = /^(.*?)_(KID|KEY_ID|SIGNING_KEY|KEY_PATH|KEY|PUB)$/.exec(name);
      if (m === null) continue;
      const g = groups.get(m[1]) ?? {};
      g[m[2] === 'KID' || m[2] === 'KEY_ID' ? 'kid' : 'key'] = value;
      groups.set(m[1], g);
    }
    for (const g of groups.values()) {
      // A kid without a host is not a kid, an interpolated path is not a
      // literal the file commits to, and either half alone is not a binding.
      if (typeof g.kid !== 'string' || !g.kid.includes('@')) continue;
      if (typeof g.key !== 'string' || g.key === '' || g.key.includes('$')) continue;
      const base = g.key.split('/').pop() ?? '';
      const keyName = base.replace(/\.(key|pub)$/, '');
      if (keyName !== '') out.push({ keyName, kid: g.kid, source: path });
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
export function scanCodexRefs(entries) {
  const out = [];
  for (const { path, text } of entries ?? []) {
    if (typeof text !== 'string') continue;
    let env;
    try {
      env = JSON.parse(text)?.env;
    } catch {
      continue;
    }
    const key = env?.SUBSTRATE_AGENT_KEY_PATH;
    if (typeof key !== 'string' || !key.startsWith('/') || !/\.config\/substrate\/keys\//.test(key))
      continue;
    const keyName = (key.split('/').pop() ?? '').replace(/\.(key|pub)$/, '');
    if (keyName === '') continue;
    const kid = env.SUBSTRATE_AGENT_KEY_ID;
    out.push({
      keyName,
      kid: typeof kid === 'string' && kid.includes('@') ? kid : null,
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
export function scanSystemdRefs(entries) {
  const out = [];
  for (const { path, text } of entries ?? []) {
    if (typeof text !== 'string') continue;
    const env = {};
    for (const line of text.split('\n')) {
      const m = /^\s*Environment\s*=\s*(.*)$/.exec(line);
      if (m === null) continue;
      // systemd splits on whitespace and honours quotes, so one line can carry
      // several assignments: Environment="A=1" "B=2".
      for (const t of m[1].matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
        const tok = t[1] ?? t[2] ?? t[3] ?? '';
        const eq = tok.indexOf('=');
        if (eq > 0) env[tok.slice(0, eq)] = tok.slice(eq + 1);
      }
    }
    const groups = new Map();
    for (const [name, value] of Object.entries(env)) {
      const m = /^(.*?)_(KID|KEY_ID|SIGNING_KEY|KEY_PATH|KEY|PUB)$/.exec(name);
      if (m === null) continue;
      const g = groups.get(m[1]) ?? {};
      if (m[2] === 'KID' || m[2] === 'KEY_ID') g.kid = value;
      else g.key = value;
      groups.set(m[1], g);
    }
    for (const g of groups.values()) {
      if (typeof g.key !== 'string' || !/\.config\/substrate\/keys\//.test(g.key)) continue;
      const base = g.key.split('/').pop() ?? '';
      const keyName = base.replace(/\.(key|pub)$/, '');
      if (keyName === '') continue;
      const kid = typeof g.kid === 'string' && g.kid.includes('@') ? g.kid : null;
      out.push({ keyName, kid, source: path });
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
export function auditOrphans({
  keyNames,
  revokedNames,
  directoryKids,
  activeKids = null,
  directoryRows = null,
  keyRefs = null,
  refScanComplete = false
}) {
  const out = [];
  if (keyNames === null || directoryKids === null) {
    out.push(
      check(
        'orphans',
        'unknown',
        'cannot cross-check keys against the directory',
        keyNames === null ? 'key directory unreadable' : 'directory unreadable'
      )
    );
    return out;
  }

  // A key file provisioned by /substrate-setup is named for the name half of its
  // kid, so `<name>@<host>` matches. That is a CONVENTION, not a binding, and
  // hand-made keys do not follow it — a repo can sign with `claude-agent.key`
  // under the registered kid `claude-code@host-a`. Calling that an orphan
  // "that may 401" invites retiring the key, which breaks a live identity.
  //
  // The binding lives in whichever `.mcp.json` configures the pair, so a key
  // unmatched by name is not answerable from the filename alone.
  // Name-matching counts only LIVE rows. A key file whose only
  // directory row is inactive + intent-documented must reach the refs loop
  // below so the assertion renders visibly, instead of being silently
  // absorbed here. (When activeKids is unknown, every directory kid counts.)
  const liveKids = activeKids ?? directoryKids;
  const nameMatched = (n) => liveKids.some((k) => k.startsWith(`${n}@`));
  const unmatched = keyNames.filter((n) => !nameMatched(n));

  if (unmatched.length === 0) {
    out.push(check('orphans.keys', 'ok', 'every key file has a directory row'));
  } else if (keyRefs === null || keyRefs === undefined) {
    // A key may be referenced by any repo on this box, and auditing one repo
    // cannot see the others. Reporting "orphan" here would be the defect this
    // module exists to catch: answering a question that was never asked.
    out.push(
      check(
        'orphans.keys',
        'unknown',
        `${unmatched.length} keypair(s) not matched by name: ${unmatched.join(', ')}`,
        'no .mcp.json scan available — a key file name is not its identity, so ' +
          'these cannot be called orphans. Re-run with --fleet to establish it.'
      )
    );
  } else {
    // Coverage matters as much as the scan itself. Auditing ONE repo cannot see
    // the .mcp.json of the repo that actually signs with a key — that repo holds
    // the reference that exonerates `claude-agent`, and a substrate-only audit will
    // never find it. So "not referenced in what I read" is evidence of orphan-
    // hood only when the read was complete.
    // A kid with an inactive, intent-documented directory row asserts
    // deliberate absence — a daemon that is never Claim.author and never
    // receives mail correctly has no live row. The assertion must be written
    // down (non-empty description carrying intent + expected-live); an
    // undocumented inactive row is indistinguishable from an oversight and
    // stays on the risky path.
    const asserted = new Map();
    if (directoryRows !== null && directoryRows !== undefined) {
      for (const r of directoryRows) {
        if (
          r?.active === false &&
          typeof r?.kid === 'string' &&
          typeof r?.description === 'string' &&
          r.description.trim() !== ''
        ) {
          asserted.set(r.kid, r.description);
        }
      }
    }
    const isLive = (kid) =>
      activeKids === null || activeKids === undefined
        ? directoryKids.includes(kid)
        : activeKids.includes(kid);
    // A reference that names the kid outranks one that does not: it is the
    // stronger binding, and the only one the directory can be checked against.
    const refFor = (n) =>
      keyRefs.find((r) => r.keyName === n && r.kid !== null) ??
      keyRefs.find((r) => r.keyName === n) ??
      null;
    const registered = [];
    const assertedList = [];
    const risky = [];
    const unreferenced = [];
    // Referenced by a config that names the key but not the kid. Proof
    // that something signs with it; says nothing about under which identity.
    const kidless = [];
    for (const n of unmatched) {
      const ref = refFor(n);
      if (ref === null) unreferenced.push(n);
      else if (ref.kid === null) kidless.push(`${n} (used by ${ref.source}, kid not stated)`);
      else if (isLive(ref.kid)) registered.push(`${n} -> ${ref.kid}`);
      else if (asserted.has(ref.kid))
        assertedList.push(`${n} -> ${ref.kid} (asserted absent by design)`);
      else risky.push(`${n} -> ${ref.kid}`);
    }
    if (risky.length > 0) {
      out.push(
        check(
          'orphans.keys',
          'warn',
          `${risky.length} keypair(s) configured against an unregistered kid: ${risky.join(', ')}`,
          'a PRESENT key with an unregistered kid 401s every read and reports as "substrate offline". ' +
            'If the kid is deliberately rowless (never Claim.author, never receives mail), assert it ' +
            'with an inactive AgentIdentity row carrying intent + expected-live (continuous|per-run) ' +
            'instead of writing a live row.'
        )
      );
    } else if (unreferenced.length > 0) {
      out.push(
        refScanComplete
          ? check(
              'orphans.keys',
              'warn',
              `${unreferenced.length} keypair(s) unreferenced by any scanned config (.mcp.json, mise.toml, .codex/cortext.local.json, systemd user units): ` +
                unreferenced.join(', '),
              'no scanned config signs with these, so none of those can 401 on them — but a key used ' +
                'through a tool (e.g. an operator key a CLI enrolment writes) or by a process started some ' +
                'other way is invisible to a config scan. ' +
                'Confirm via `substrate-admin list` that no live credential depends on one before retiring it; ' +
                'a file scan cannot see revocation state, so retiring on this finding alone is unsound.'
            )
          : check(
              'orphans.keys',
              'unknown',
              `${unreferenced.length} keypair(s) not matched by name and not referenced here: ` +
                unreferenced.join(', '),
              "only this repo's configs were read — the repo that signs with one of these " +
                'may not have been scanned. Re-run with --fleet before treating it as unowned.'
            )
      );
    } else {
      const bits = [`every key file is accounted for (${[...registered, ...kidless].join(', ')})`];
      if (assertedList.length > 0) {
        bits.push(`asserted absent by design: ${assertedList.join(', ')}`);
      }
      out.push(
        check(
          'orphans.keys',
          'ok',
          bits.join('; '),
          assertedList.length > 0
            ? 'asserted kids hold inactive, intent-documented directory rows (expected liveness per row description) — visible here rather than silently exonerated'
            : undefined
        )
      );
    }
  }

  if (revokedNames !== null && revokedNames.length > 0) {
    out.push(
      check(
        'orphans.revoked',
        'warn',
        `${revokedNames.length} revoked keypair(s) still on disk: ${revokedNames.join(', ')}`,
        'harmless but indistinguishable from a live key at a glance'
      )
    );
  }

  // LIVE rows only. An inactive row is a RETIRED identity — the normal
  // end state of a host migration — and counting it would warn forever with
  // no reachable remedy: neither deactivating nor revoking the key clears it,
  // and the only remaining route is deleting the AgentIdentity row, which is exactly what the data
  // model forbids because AgentMessage.recipient is onDelete:set_null with live
  // messages hanging off it.
  //
  // A check that asks for a state whose only route is the destructive act the
  // schema exists to prevent is worse than no check: it sits beside
  // `orphans.keys`, which flags kids that genuinely 401, and a permanent WARN
  // there teaches its reader to skim the one line that matters.
  //
  // A ROAMING identity is one per host by design — `codex@host-a` and
  // `codex@host-b` are two machines' reviewers, not one host spelled two
  // ways — so its pairs are named on the ok line rather than warned about.
  const roamingKids = new Set(
    (directoryRows ?? []).filter((r) => r?.roaming === true).map((r) => r.kid)
  );
  const live = activeKids ?? directoryKids;
  const liveGroups = sameNameDifferentHost(live);
  const isRoamingGroup = (g) => g.every((k) => roamingKids.has(k));
  const dupes = liveGroups.filter((g) => !isRoamingGroup(g));
  const roamingPairs = liveGroups.filter(isRoamingGroup);
  const roamingNote =
    roamingPairs.length > 0
      ? ` (roaming, one per host by design: ${roamingPairs.map((g) => g.join(' / ')).join(' | ')})`
      : '';
  out.push(
    dupes.length === 0
      ? check(
          'orphans.hosts',
          'ok',
          `no LIVE agent name registered against two hosts${roamingNote}`
        )
      : check(
          'orphans.hosts',
          'warn',
          `${dupes.length} name(s) on multiple hosts: ${dupes.map((c) => c.join(' / ')).join(' | ')}`,
          'expected if the agent genuinely runs on both; otherwise the host is being derived inconsistently (hostname -s on one path, a hardcoded value on another)'
        )
  );

  // Retired counterparts are reported, never warned about. Silence would be
  // wrong too — an operator looking at a migration wants to see it — but this
  // is a settled state, not an action.
  if (activeKids !== null) {
    const retiredPairs = sameNameDifferentHost(directoryKids).filter(
      (group) => !liveGroups.some((d) => d.join() === group.join())
    );
    if (retiredPairs.length > 0) {
      out.push(
        check(
          'orphans.retired',
          'ok',
          `${retiredPairs.length} name(s) with a retired host counterpart: ${retiredPairs
            .map((g) => g.join(' / '))
            .join(' | ')}`,
          'one live identity plus one deactivated — the normal end state of a host migration, and nothing to do'
        )
      );
    }
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
export function sameNameDifferentHost(kids) {
  const byName = new Map();
  for (const k of kids) {
    const at = k.lastIndexOf('@');
    if (at <= 0) continue;
    const name = k.slice(0, at);
    const set = byName.get(name) ?? new Set();
    set.add(k);
    byName.set(name, set);
  }
  return [...byName.values()].filter((s) => s.size > 1).map((s) => [...s].sort());
}
