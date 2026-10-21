// Who this session signs as, and what that credential may do: the key file,
// the directory row and the server's own whoami answer.

import { check } from './check.js';

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
export function auditIdentity({
  resolvedKid,
  source,
  declaredName,
  keyFilePresent,
  directoryKids
}) {
  const out = [];

  if (resolvedKid === null) {
    out.push(
      check(
        'identity.resolved',
        'unknown',
        'could not determine the signing identity',
        'ask the running MCP server or read _metadata.createdBy from a write — never this process’s own env, which does not carry it'
      )
    );
    return out;
  }
  out.push(check('identity.resolved', 'ok', `${resolvedKid} (source: ${source ?? 'unknown'})`));

  // A repo declares the stable half of its identity. Until that
  // declaration exists there is nothing to compare a derivation against, so
  // "drift" is undefined rather than absent — which is an unknown, not an ok.
  if (declaredName === null) {
    out.push(
      check(
        'identity.declared',
        'unknown',
        'repo declares no agent name, so the resolved kid cannot be checked',
        'a derivation with nothing to compare against cannot drift OR be verified'
      )
    );
  } else if (!resolvedKid.startsWith(`${declaredName}@`)) {
    out.push(
      check(
        'identity.declared',
        'warn',
        `repo declares '${declaredName}' but the environment resolved '${resolvedKid}'`,
        'most often a session launched from a SUBDIRECTORY, which mints an unregistered kid'
      )
    );
  } else {
    out.push(check('identity.declared', 'ok', `matches the declared '${declaredName}'`));
  }

  if (keyFilePresent === null) {
    out.push(
      check(
        'identity.key',
        'unknown',
        'key directory not readable',
        'cannot list ~/.config/substrate/keys'
      )
    );
  } else if (!keyFilePresent) {
    out.push(
      check(
        'identity.key',
        'warn',
        'no key file for this kid',
        'reads degrade to anonymous — weaker, but not broken'
      )
    );
  } else {
    out.push(check('identity.key', 'ok', 'key file present'));
  }

  if (directoryKids === null) {
    out.push(
      check(
        'identity.registered',
        'unknown',
        'AgentIdentity directory unreadable',
        'the server was not reachable, so registration state is unverified'
      )
    );
  } else if (!directoryKids.includes(resolvedKid)) {
    // Per the skill's own Step 7 warning, this is the WORSE of the two failure
    // modes: a present key with an unknown kid makes every read 401, which
    // surfaces as "substrate offline" rather than as an identity problem.
    // (But a deliberately rowless kid — never Claim.author, never
    // receives mail — must be asserted, not written, so the remedy names the
    // inactive-row path instead of instructing a live row unconditionally.)
    out.push(
      check(
        'identity.registered',
        'warn',
        `'${resolvedKid}' has no AgentIdentity row`,
        keyFilePresent === true
          ? 'a PRESENT key with an unregistered kid 401s every read and reports as "substrate offline". ' +
              'If this kid is deliberately rowless, assert it with an inactive AgentIdentity row carrying ' +
              'intent + expected-live (continuous|per-run) instead of writing a live row.'
          : 'half-registered identity. If deliberately rowless, assert it with an inactive ' +
              'AgentIdentity row carrying intent + expected-live instead of writing a live row.'
      )
    );
  } else {
    out.push(check('identity.registered', 'ok', 'registered in the directory'));
  }
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
export function credentialIsTargets({ whoami, resolvedKid = null, declaredKid = null }) {
  const subject = whoami?.ok === true && whoami.authenticated === true ? (whoami.id ?? null) : null;
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
export function auditAuthority({
  whoami,
  expectedNamespaces = [],
  expectedCapabilities = null,
  resolvedKid = null,
  declaredKid = null,
  selfAudit = true,
  authWarning = null
}) {
  if (whoami === null || whoami === undefined || whoami.ok !== true) {
    const reason = whoami?.failed ?? 'no whoami probe was run';
    // A 401 is not a hole — it is the server refusing this credential, which is
    // exactly what a revoked key looks like. Say which one it is.
    const revoked = /\b401\b/.test(reason);
    return [
      check(
        'authority.grant',
        revoked ? 'warn' : 'unknown',
        revoked
          ? 'this credential was REJECTED by the server (401)'
          : 'could not ask the server what this credential holds',
        revoked
          ? `${reason} — a registered, unrevoked key does not 401. Either this kid was revoked, or the key on disk does not match the registered public key. Reads are degrading to anonymous or failing outright.`
          : `${reason} — so namespaces and capabilities are unverified. This is the one identity fact the local filesystem and the AgentIdentity directory cannot supply.`
      )
    ];
  }

  // The server splits an ambiguous `authenticated: false` into
  // `authEnabled` + `identity`, and the two halves are not the same finding:
  // one is a deployment posture this caller cannot change, the other is this
  // caller's own wiring. Both are DEFINITE answers, so neither is an unknown —
  // an unknown here is reserved for a response without `authEnabled`, which genuinely cannot
  // tell them apart. Reporting a known-bad state as a hole is the failure this
  // section exists to catch, one level up.
  if (whoami.authenticated !== true) {
    if (whoami.authEnabled === false) {
      return [
        check(
          'authority.grant',
          'warn',
          'this server VERIFIES NOTHING — auth is disabled',
          'every credential here is decorative: writes attribute to whoever claims them, and `_metadata.createdBy` records a claim rather than a signature. Presenting a key would change nothing. This is a deployment posture, so the fix is at the server, not in this repo.'
        )
      ];
    }
    if (whoami.authEnabled === true) {
      // `createAgentAuth` already knows WHY nothing was sent whenever the
      // cause is local — an unreadable key path, a malformed PEM, one env var
      // set without the other — and returns that as `warning`. That beats the
      // generic "never took effect" derived from whoami, which points at the
      // wiring when the fault is the file on disk. Fall back to the derived
      // reading only when there is none: the genuine env-never-arrived case.
      const local = typeof authWarning === 'string' ? authWarning.trim() : null;
      return [
        check(
          'authority.grant',
          'warn',
          'auth is ENABLED and this request carried no credential — reads are landing anonymously',
          local === null
            ? 'a present-but-invalid token 401s before this answer, so nothing was rejected: nothing was sent. SUBSTRATE_AGENT_KEY_ID / SUBSTRATE_AGENT_KEY_PATH never took effect for this process. On a reads-open stack an anonymous read and an authenticated one are byte-identical, so this state can persist unnoticed — this is that state, named.'
            : `the signer says why, so this is NOT the env-never-arrived case: ${local}. Both env vars reached this process; the credential itself could not be loaded, so the fix is the key material rather than the wiring. A present-but-invalid token 401s before this answer, so nothing was rejected — nothing was sent.`
        )
      ];
    }
    return [
      check(
        'authority.grant',
        'unknown',
        'the server resolved no identity for this request',
        'the server answered without `authEnabled`, a response shape this client does not understand, so it cannot say whether this instance verifies nothing or the probe carried no Authorization header. A present-but-invalid token 401s before that handler runs, so this is NOT evidence that a token was rejected.'
      )
    ];
  }

  const out = [];
  const flatNs = whoami.namespaces;
  const caps = whoami.capabilities;
  const grants = whoami.grants ?? null;

  // Current servers send neither flat field — the whoami
  // projection is `{ id, grants }` — so the namespace set has to come from the
  // grant keys. Sorted, because object key order is insertion order and this
  // string is rendered for a human to diff against `substrate-admin list`.
  //
  // Every reader past this point treats `ns` as an array: two interpolate it
  // into the text an operator acts on, and one tests `ns.includes('*')`. A null
  // reaching them is not a wrong answer, it is a crash.
  const ns = flatNs ?? (grants === null ? null : Object.keys(grants).sort());

  // `caps === null` alone is not an unknown: the grant is per-namespace and
  // the whoami route nulls the flat field DELIBERATELY whenever no flat list
  // can be honest, putting the real answer in `grants` beside it. So the same
  // null now carries two opposite findings — a hole, or a MORE precise answer
  // than the flat field could express — and only the presence of `grants`
  // separates them. Reading it as a hole reports a correctly-answering server
  // as version skew, which is this check's own failure mode pointed inward.
  //
  // `ns === null` stays unconditional. The route defaults namespaces to `[]`
  // itself and has no second spelling for it, so a null there is skew on every
  // version and no companion field rescues it.
  // Skew is `grants` ABSENT alongside an absent flat field — nothing arrived
  // that could answer. A present `grants` with both flat fields gone is the
  // current shape answering correctly, the same discriminator as for
  // `capabilities` alone. Both wire shapes are still accepted,
  // so neither may be assumed.
  if (grants === null && (flatNs === null || caps === null)) {
    out.push(
      check(
        'authority.grant',
        'unknown',
        'whoami answered in a shape this client does not understand',
        'older servers default namespaces and capabilities to [] in the route, and current ones drop both and send `grants` instead — so on every supported version an absent field with NO `grants` beside it is version skew rather than an empty grant, and reading it as empty would understate authority rather than overstate it. Neither shape that carries `grants` lands here: older servers null `capabilities` on purpose, current ones remove both flat fields, and both put the real answer in `grants`. None arrived.'
      )
    );
    return out;
  }

  // whoami is a SELF view — it answers for the credential THIS PROCESS signs
  // with. That is the TARGET's credential only when the two name the same kid,
  // and under `--target-dir`, or against a repo whose session is not running,
  // they do not: the grant shown would be the AUDITOR's, not the target's.
  //
  // The gate is on ATTRIBUTION, not on the wildcard, because the substitution
  // runs both directions: audit a genuinely over-granted repo from a narrowly
  // scoped session and the narrow grant reports as an `ok`. A false OK is the
  // same defect wearing the state a reader stops at.
  //
  // Two facts can establish the subject and both are TARGET-derived — the kid
  // of the MCP server running in the target dir, and the kid the target's own
  // `.mcp.json` pins. The second is what keeps this answerable from a plain
  // shell with no session up. The auditor's own env is not one of them; it is
  // the input that produced the wrong answer.
  const subject = whoami.id ?? null;
  const attributed = credentialIsTargets({ whoami, resolvedKid, declaredKid });

  // Only a SELF audit can read a kid mismatch as a borrowed key. Pointed at
  // another repo the mismatch is the expected state, and warning on it would
  // train the reader to skip the line that matters.
  if (selfAudit && resolvedKid !== null && subject !== null && subject !== resolvedKid) {
    out.push(
      check(
        'authority.grant',
        'warn',
        `signing as '${subject}' but this repo resolved '${resolvedKid}'`,
        'every write from this session attributes to the server-side identity, not the one the config names — never borrow another agent\u2019s key'
      )
    );
  }

  if (!attributed) {
    const claimed = resolvedKid ?? declaredKid;
    out.push(
      check(
        'authority.grant',
        'unknown',
        `read ${ns.includes('*') ? "'*' — EVERY namespace" : ns.join(',') || 'no namespace'} (${describeGrant({ caps, grants })}) for ${subject === null ? 'a credential the server did not name' : `'${subject}'`} — NOT established as this target's`,
        claimed === null
          ? 'nothing target-derived names whose credential this is: no MCP server is running in the target dir and its .mcp.json pins no SUBSTRATE_AGENT_KEY_ID, so the grant above is whatever credential the AUDIT PROCESS holds. An unresolved subject cannot have a verified authority — pin the kid per repo or run the audit from that repo’s own session.'
          : `this target is '${claimed}', so the grant above belongs to a different identity — the one the AUDIT PROCESS holds. Ask \`substrate-admin list\` for the target’s real grant; nothing readable from here can supply it.`
      )
    );
    out.push(...tail(whoami));
    return out;
  }

  // A capability check, and it comes BEFORE the namespace verdict
  // because a credential that cannot `read` cannot use any namespace it holds
  // — reporting the namespace set as sufficient is then a well-formed answer to
  // a question nobody asked.
  //
  // Without it the terminal `ok` would render `granted cortext,recall (caps:
  // none)` while every read 403s with
  // `{"code":"forbidden","required":"read","have":[]}`: whoami ANSWERS (the
  // route does not gate on `read`), the identity is verified and correctly
  // attributed, and it can do nothing.
  //
  // The usual CAUSE is local rather than a narrow row: the claim is intersected
  // against the _system/Key row (`intersectList(claimed, row.capabilities)`), so a
  // claim that OMITS what the row grants intersects it AWAY — an `admin`-only
  // row against `agent-auth.js`'s hardcoded `['read','mutate']` resolves to
  // `[]`. Both causes are named, because only `substrate-admin list` separates them.
  // The per-namespace form of the same question, and it is a SEPARATE
  // branch rather than a generalisation of the flat one because the two catch
  // different states and merging them would drop one. The flat check below is
  // all-or-nothing and its loudest case is `caps: []`, a credential that is
  // verified and can do nothing. That
  // state cannot arise here: `intersectGrants` DROPS a namespace resolving to
  // no capability, so every namespace in a grant carries at least one thing.
  // What arises instead is narrower and invisible to a flat reading — `mutate`
  // without `read` on one namespace out of several, which the union renders as
  // a healthy `read,mutate` and the audit would pass.
  //
  // Only namespaces this credential actually HOLDS are checked. One it does not
  // hold is a missing-namespace finding a few lines down, and reporting it here
  // as "no read" would answer a question nobody asked, as with the ordering
  // above.
  //
  // Capabilities beyond `read` are checked only where the capability DECLARES
  // them (below). Without a declaration nothing here knows which
  // namespaces are written rather than read, and inventing a requirement would
  // produce a WARN that no declared fact supports.
  if (grants !== null) {
    const readless = expectedNamespaces.filter((n) => {
      const held = capabilitiesOn(n, { caps, grants });
      return held.length > 0 && !held.includes('read');
    });
    if (readless.length > 0) {
      out.push(
        check(
          'authority.grant',
          'warn',
          `verified as '${subject}' but holds no \`read\` on ${readless.join(', ')} — every read there is refused (${describeGrant({ caps, grants })})`,
          `this is the state a flat capability list CANNOT express, which is why the server nulls \`capabilities\` rather than rendering the union — the union would say \`read\` because it is held somewhere. Frames against ${readless.join(', ')} return \`{"code":"forbidden","required":"read"}\` while every other namespace answers normally, so the failure is partial and the render looks healthy. Widen the grant with \`substrate-admin\`: an entry is \`<ns>:<cap>+<cap>\`, and an EXPLICIT entry beats a \`*\` entry rather than adding to it, so a narrow entry is not widened by a broad wildcard beside it.`
        )
      );
      out.push(...tail(whoami));
      return out;
    }
  } else if (!caps.includes('read')) {
    out.push(
      check(
        'authority.grant',
        'warn',
        `verified as '${subject}' but holds ${caps.length === 0 ? 'NO capabilities' : `no \`read\` (caps: ${caps.join(',')})`} — every read is refused`,
        `whoami answers without gating on \`read\`, so this state renders as a healthy identity while \`/substrate/v1/query\` returns \`{"code":"forbidden","required":"read","have":[${caps.map((c) => `"${c}"`).join(',')}]}\`. The namespace grant below is moot until this is fixed. Two causes, and \`substrate-admin list\` tells them apart: the ROW may not grant \`read\`, or the row grants it and our TOKEN CLAIM omitted it — substrate intersects claim against row, so a claim that is a SUBSET of the row silently discards the difference. Widening a row is an operator action; widening the claim is ours. Note \`['*']\` is NOT a valid claim for capabilities — both gates do a bare \`includes\` with no wildcard branch, so a wildcard claim is refused everything.`
      )
    );
    out.push(...tail(whoami));
    return out;
  }

  // What the capability declares it does to each namespace, checked
  // against what is held there. Only HELD namespaces, for the same reason as
  // the read check above: an unheld one is a missing-namespace finding below.
  // `read` is not re-checked; both paths above already returned on it.
  if (expectedCapabilities !== null) {
    const lacking = new Map();
    for (const [n, needed] of Object.entries(expectedCapabilities)) {
      const held = grants !== null ? capabilitiesOn(n, { caps, grants }) : caps;
      if (held.length === 0) continue;
      for (const cap of needed) {
        if (cap === 'read' || held.includes(cap)) continue;
        lacking.set(cap, [...(lacking.get(cap) ?? []), n]);
      }
    }
    if (lacking.size > 0) {
      const what = [...lacking].map(([cap, names]) => `no \`${cap}\` on ${names.join(', ')}`);
      out.push(
        check(
          'authority.grant',
          'warn',
          `verified as '${subject}' but holds ${what.join('; ')} — the capability declares it needs them (${describeGrant({ caps, grants })})`,
          'reads succeed, so the session looks healthy, and the first write there is refused with `{"code":"forbidden"}`: SessionLogs, AnchorIntents and Memory in `cortext`, salience boosts in `recall`. Widen the grant with `substrate-admin`; an entry is `<ns>:<cap>+<cap>`.'
        )
      );
      out.push(...tail(whoami));
      return out;
    }
  }

  if (ns.includes('*')) {
    // Over-broad, and invisible without this check. Not an outage: nothing
    // fails, which is precisely why eleven of twelve kids reached this state.
    out.push(
      check(
        'authority.grant',
        'warn',
        `granted '*' — EVERY namespace (${describeGrant({ caps, grants })}) — as '${subject}'`,
        `this identity needs ${expectedNamespaces.length > 0 ? expectedNamespaces.join(',') : 'a declared set'}. A wildcard is what \`substrate-admin register\` grants when \`--ns\` is OMITTED, so it is usually inherited rather than chosen.`
      )
    );
    // NOT an early return. The fleet caveat below must render on every path
    // that reaches a real answer — a wildcard grant is exactly the state in
    // which a reader is most likely to assume the whole fleet was checked.
    out.push(...tail(whoami));
    return out;
  }

  const missing = expectedNamespaces.filter((n) => !ns.includes(n));
  if (missing.length > 0) {
    // The cold-start does not fail on this, it silently renders
    // Agent Memory through the weaker ranker behind a rejected-frames banner.
    out.push(
      check(
        'authority.grant',
        'warn',
        `missing namespace(s): ${missing.join(', ')} — granted ${ns.join(',')}`,
        'frames against a missing namespace are rejected per-key with `unauthorized_namespace`; the cold-start degrades rather than failing, so the render looks complete and simply carries a different heading'
      )
    );
  } else {
    out.push(
      check(
        'authority.grant',
        'ok',
        `granted ${ns.join(',')} (${describeGrant({ caps, grants })}) — covers what this capability needs, as '${subject}'`
      )
    );
  }

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
  // `Object.hasOwn`, not a bare lookup. Namespace names arrive off the wire and
  // land as KEYS here, so `grants['constructor']` would resolve up the
  // prototype chain to a function — which passes a `.length > 0` test and then
  // throws on `.includes`. Unlikely as a namespace name and free to rule out.
  if (Object.hasOwn(grants, name)) return grants[name];
  return Object.hasOwn(grants, '*') ? grants['*'] : [];
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
  if (caps !== null && caps !== undefined) return `caps: ${caps.join(',') || 'none'}`;
  const entries = Object.entries(grants ?? {}).map(([n, c]) => `${n}:${[...c].sort().join('+')}`);
  // Reachable: `intersectGrants` yields `{}` when claim and row share nothing.
  // "NOTHING" rather than an empty string, which would render as a blank pair
  // of brackets and read as a formatting bug instead of as a finding.
  return entries.length === 0 ? 'grant: NOTHING' : `grant: ${entries.sort().join(' ')}`;
}

function tail() {
  return [fleetCaveat()];
}

/** Never let the self-view read as a fleet audit. This is the caveat for the
 *  fleet-wide checks a self view cannot make. `info`, not `unknown`: it is
 *  true of every run, so as an unknown it would make the audit exit 1 forever
 *  and "Nothing to do" unreachable. */
function fleetCaveat() {
  return check(
    'authority.fleet',
    'info',
    'other identities\u2019 credentials are not visible from here',
    'whoami is a self view. A registered _system/Key with no directory row, or a retired row whose key is still live, needs `substrate-admin list` and stays unchecked — a decommissioned agent can hold a live `*` credential with nothing here showing it'
  );
}
