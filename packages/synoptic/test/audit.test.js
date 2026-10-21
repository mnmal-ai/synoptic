import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  auditAuthority,
  auditFragment,
  auditIdentity,
  auditInboxPush,
  auditMcpJson,
  auditOrphans,
  auditPlugin,
  auditSalientTier,
  auditSemanticRecall,
  CACHE_KEEP,
  check,
  credentialIsTargets,
  renderAudit,
  sameNameDifferentHost,
  scanCodexRefs,
  scanMiseRefs,
  scanSystemdRefs
} from '../src/audit.js';
import { compareVersions } from '../src/fragment-resolve.js';

const cmp = compareVersions;

// ---- the three-state rule ----

test('an unknown check without a reason is a programming error', () => {
  // A hole with no explanation is not reportable, and silently allowing one
  // reintroduces exactly the defect this module exists to catch.
  assert.throws(() => check('x', 'unknown', 'something'), /unknown without a reason/);
  assert.doesNotThrow(() => check('x', 'unknown', 'something', 'because'));
});

test('ok and warn do not require a reason', () => {
  assert.doesNotThrow(() => check('x', 'ok', 'fine'));
  assert.doesNotThrow(() => check('x', 'warn', 'bad'));
});

// ---- plugin ----

test('plugin: a cache holding more than CACHE_KEEP versions warns', () => {
  const out = auditPlugin({
    installedVersion: '1.9.0',
    cacheVersions: ['1.2.0', '1.5.0', '1.7.1', '1.9.0'],
    servedVersion: '1.9.0',
    compare: cmp
  });
  const cache = out.find((c) => c.id === 'plugin.cache');
  assert.equal(cache.state, 'warn');
  assert.match(cache.text, /4 versions/);
  assert.match(cache.detail, /live skill source/);
});

test('plugin: a cache at or below the keep threshold is ok', () => {
  const out = auditPlugin({
    installedVersion: '1.9.0',
    cacheVersions: ['1.7.1', '1.9.0'].slice(0, CACHE_KEEP),
    servedVersion: '1.9.0',
    compare: cmp
  });
  assert.equal(out.find((c) => c.id === 'plugin.cache').state, 'ok');
});

test('plugin: being served an older version than installed warns and names the cause', () => {
  const out = auditPlugin({
    installedVersion: '1.9.0',
    cacheVersions: ['1.9.0'],
    servedVersion: '1.7.1',
    compare: cmp
  });
  const served = out.find((c) => c.id === 'plugin.served');
  assert.equal(served.state, 'warn');
  // The session binding is the CAUSE, but the consequence a reader needs is
  // that the skill text itself is superseded.
  assert.match(served.detail, /superseded/);
  assert.match(served.detail, /rebind CLAUDE_PLUGIN_ROOT/);
});

test('plugin: an unreadable cache is UNKNOWN, never ok', () => {
  const out = auditPlugin({
    installedVersion: '1.9.0',
    cacheVersions: [],
    servedVersion: '1.9.0',
    compare: cmp
  });
  assert.equal(out.find((c) => c.id === 'plugin.cache').state, 'unknown');
});

// ---- "could not look" is not "looked, and the answer is bad" ----
//
// Three facts here reach auditPlugin as a missing value, and each is reachable
// two ways. Collapsing them reports a verified defect as a hole, with a `detail`
// asserting a cause it has not established.

test('plugin: an UNREADABLE registry is unknown; a registry that READ and lists nothing warns', () => {
  const unreadable = auditPlugin({
    installedVersion: null,
    installedRegistry: 'unreadable',
    cacheVersions: ['1.9.0'],
    servedVersion: '1.9.0',
    compare: cmp
  });
  const u = unreadable.find((x) => x.id === 'plugin.installed');
  assert.equal(u.state, 'unknown');
  assert.match(u.detail, /could not be read or parsed/);

  const noEntry = auditPlugin({
    installedVersion: null,
    installedRegistry: 'no-entry',
    cacheVersions: ['1.9.0'],
    servedVersion: '1.9.0',
    compare: cmp
  });
  const n = noEntry.find((x) => x.id === 'plugin.installed');
  assert.equal(n.state, 'warn');
  assert.match(n.detail, /downgrade floor/);
  // It must not claim the read failed, which is what the collapsed version did.
  assert.doesNotMatch(n.detail, /could not be read/);
});

test('plugin: a registry entry with no version field warns as MALFORMED, not as missing', () => {
  const out = auditPlugin({
    installedVersion: null,
    installedRegistry: 'malformed',
    cacheVersions: ['1.9.0'],
    servedVersion: '1.9.0',
    compare: cmp
  });
  const c = out.find((x) => x.id === 'plugin.installed');
  assert.equal(c.state, 'warn');
  assert.match(c.text, /carries no version/);
});

test('plugin: a cache dir that READ and is empty warns; one that could not be listed is unknown', () => {
  const empty = auditPlugin({
    installedVersion: '1.9.0',
    cacheVersions: [],
    cacheDir: 'readable',
    servedVersion: '1.9.0',
    compare: cmp
  });
  const e = empty.find((c) => c.id === 'plugin.cache');
  assert.equal(e.state, 'warn');
  assert.match(e.text, /EMPTY/);
  assert.doesNotMatch(e.text, /not readable/);

  const unlistable = auditPlugin({
    installedVersion: '1.9.0',
    cacheVersions: [],
    cacheDir: 'unreadable',
    servedVersion: '1.9.0',
    compare: cmp
  });
  assert.equal(unlistable.find((c) => c.id === 'plugin.cache').state, 'unknown');
});

test('plugin: CLAUDE_PLUGIN_ROOT set with no readable marker warns; unset is unknown', () => {
  const broken = auditPlugin({
    installedVersion: '1.9.0',
    cacheVersions: ['1.9.0'],
    servedVersion: null,
    servedRoot: 'set',
    compare: cmp
  });
  const b = broken.find((c) => c.id === 'plugin.served');
  assert.equal(b.state, 'warn');
  assert.match(b.text, /set but carries no readable fragment marker/);

  const unset = auditPlugin({
    installedVersion: '1.9.0',
    cacheVersions: ['1.9.0'],
    servedVersion: null,
    servedRoot: 'unset',
    compare: cmp
  });
  const u = unset.find((c) => c.id === 'plugin.served');
  assert.equal(u.state, 'unknown');
  // The audit runs from inside the serving tree, so an unset variable does not
  // mean unanswerable — it means no root could be named OR derived, which is rare.
  assert.match(u.detail, /named or derived/);
});

test('plugin: every discriminator fails CLOSED — a bad or absent value reports a hole', () => {
  // A caller that stops passing one of these, or passes a typo, must degrade to
  // unknown. Claiming health on a check that did not run is the defect itself.
  for (const bad of [undefined, null, true, 'present ', 'READABLE', '']) {
    const out = auditPlugin({
      installedVersion: null,
      installedRegistry: bad,
      cacheVersions: [],
      cacheDir: bad,
      servedVersion: null,
      servedRoot: bad,
      compare: cmp
    });
    for (const id of ['plugin.installed', 'plugin.cache', 'plugin.served']) {
      assert.equal(
        out.find((c) => c.id === id).state,
        'unknown',
        `${id} did not fail closed for ${String(bad)}`
      );
    }
  }
});

// ---- fragment ----

test('fragment: reuses the resolver verdict so audit and installer cannot disagree', () => {
  assert.equal(auditFragment({ action: 'current', chosen: { digest: 'e25b9217' } })[0].state, 'ok');
  assert.equal(
    auditFragment({ action: 'install', chosen: { version: '1.9.0', digest: 'e25b9217' } })[0].state,
    'warn'
  );
  assert.equal(auditFragment({ action: 'skip-source-repo' })[0].state, 'ok');
  assert.equal(auditFragment({ action: 'refuse', reason: 'nope' })[0].state, 'unknown');
});

// ---- identity ----

test('identity: an unresolved kid is UNKNOWN and names the correct source to use', () => {
  const out = auditIdentity({
    resolvedKid: null,
    source: null,
    declaredName: null,
    keyFilePresent: null,
    directoryKids: null
  });
  assert.equal(out[0].state, 'unknown');
  // A shell can lack SUBSTRATE_AGENT_KEY_ID while the MCP child has it.
  assert.match(out[0].detail, /never this process’s own env/);
});

test('identity: no declaration means the resolved kid is UNVERIFIABLE, not fine', () => {
  const out = auditIdentity({
    resolvedKid: 'synoptic-claude@Desk',
    source: 'mcp server env',
    declaredName: null,
    keyFilePresent: true,
    directoryKids: ['synoptic-claude@Desk']
  });
  const d = out.find((c) => c.id === 'identity.declared');
  assert.equal(d.state, 'unknown');
  assert.match(d.detail, /cannot drift OR be verified/);
});

test('identity: a declaration that disagrees points at the subdirectory case', () => {
  const out = auditIdentity({
    resolvedKid: 'substrate-cli-claude@Desk',
    source: 'mcp server env',
    declaredName: 'substrate-client-claude',
    keyFilePresent: false,
    directoryKids: []
  });
  const d = out.find((c) => c.id === 'identity.declared');
  assert.equal(d.state, 'warn');
  assert.match(d.detail, /SUBDIRECTORY/);
});

test('identity: a present key with an unregistered kid names the 401 symptom', () => {
  // The skill's own Step 7 says this is WORSE than no key, because it surfaces
  // as "substrate offline" rather than as an identity problem.
  const out = auditIdentity({
    resolvedKid: 'substrate-cli-claude@Desk',
    source: 'launch env',
    declaredName: null,
    keyFilePresent: true,
    directoryKids: ['other@host']
  });
  const r = out.find((c) => c.id === 'identity.registered');
  assert.equal(r.state, 'warn');
  assert.match(r.detail, /401s every read/);
});

test('identity: an unreachable directory is UNKNOWN, not "unregistered"', () => {
  // Reporting "no row" when the server was simply down would be a false
  // positive of the worst kind — it invites deleting a good identity.
  const out = auditIdentity({
    resolvedKid: 'a@b',
    source: 'x',
    declaredName: null,
    keyFilePresent: true,
    directoryKids: null
  });
  assert.equal(out.find((c) => c.id === 'identity.registered').state, 'unknown');
});

test('identity: a fully wired identity is all ok', () => {
  const out = auditIdentity({
    resolvedKid: 'synoptic-claude@Desk',
    source: 'mcp server env',
    declaredName: 'synoptic-claude',
    keyFilePresent: true,
    directoryKids: ['synoptic-claude@Desk']
  });
  assert.ok(out.every((c) => c.state === 'ok'));
});

// ---- orphans ----

test('orphans: key files with no directory row are listed by name', () => {
  // Naming them requires a config scan to have happened. With one that
  // found nothing, they are unreferenced — which is still reportable, and is
  // no longer phrased as a 401 risk.
  const out = auditOrphans({
    keyNames: ['synoptic-claude', 'codex', 'cursor'],
    revokedNames: [],
    directoryKids: ['synoptic-claude@Desk'],
    keyRefs: [],
    refScanComplete: true
  });
  const o = out.find((c) => c.id === 'orphans.keys');
  assert.equal(o.state, 'warn');
  assert.match(o.text, /codex, cursor/);
});

test('orphans: a key matches a kid on the NAME half, not by equality', () => {
  const out = auditOrphans({
    keyNames: ['synoptic-claude'],
    revokedNames: [],
    directoryKids: ['synoptic-claude@Desk']
  });
  assert.equal(out.find((c) => c.id === 'orphans.keys').state, 'ok');
});

test('orphans: revoked keypairs still on disk are reported', () => {
  const out = auditOrphans({
    keyNames: [],
    revokedNames: ['mnmal-synoptic-claude'],
    directoryKids: []
  });
  assert.equal(out.find((c) => c.id === 'orphans.revoked').state, 'warn');
});

test('orphans: an unreadable side is UNKNOWN rather than "no orphans"', () => {
  const out = auditOrphans({ keyNames: null, revokedNames: null, directoryKids: ['a@b'] });
  assert.equal(out[0].state, 'unknown');
  assert.equal(out.length, 1, 'no further claims are made once a side is missing');
});

test('sameNameDifferentHost catches a host difference that is not casing', () => {
  // These look like two host spellings differing only in case. They are not:
  // lowercased they are `deskbook` vs `desk`, differing by the
  // trailing `book`. A case-insensitive check finds nothing here — which is why
  // the invariant is one-name-many-hosts, not case.
  const c = sameNameDifferentHost([
    'app-claude@deskbook',
    'app-claude@Desk',
    'synoptic-claude@Desk'
  ]);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0], ['app-claude@Desk', 'app-claude@deskbook']);
});

test('sameNameDifferentHost still catches a genuine case-only variant', () => {
  const c = sameNameDifferentHost(['a-claude@Host', 'a-claude@host']);
  assert.equal(c.length, 1);
});

test('sameNameDifferentHost is empty when each name has one host', () => {
  assert.deepEqual(sameNameDifferentHost(['a@h', 'b@h']), []);
});

test('sameNameDifferentHost ignores a malformed kid with no host', () => {
  assert.deepEqual(sameNameDifferentHost(['nohost', 'a@h']), []);
});

// ---- rendering ----

test('render: a clean audit says so plainly', () => {
  const out = renderAudit([['plugin', [check('a', 'ok', 'fine')]]]);
  assert.match(out, /\*\*1 checks passed\.\*\* Nothing to do\./);
  assert.match(out, /Nothing above was written/);
});

test('render: UNKNOWN is counted separately and never folded into either side', () => {
  // A summary reading "1 ok, 0 warnings" while a check never ran is precisely
  // the bug this audit exists to find, one level up.
  const out = renderAudit([
    ['g', [check('a', 'ok', 'fine'), check('b', 'unknown', 'could not check', 'server down')]]
  ]);
  assert.match(out, /1 ok/);
  assert.match(out, /\*\*1 NOT VERIFIED\*\*/);
  assert.ok(!/1 checks passed/.test(out), 'must not claim a pass');
  assert.match(out, /a hole in this audit, not a pass/);
});

test('render: no unknown-explainer when nothing was unverified', () => {
  const out = renderAudit([['g', [check('a', 'warn', 'bad')]]]);
  assert.ok(!out.includes('hole in this audit'));
  assert.match(out, /\*\*1 needing attention\*\*/);
});

test('render: details are indented under their check', () => {
  const out = renderAudit([['g', [check('a', 'warn', 'headline', 'the reason')]]]);
  assert.match(out, /\[WARN\] {2}headline\n {10}the reason/);
});

// ---- a retired identity must not warn forever ----

test('orphans.hosts counts only LIVE rows', () => {
  // The unclearable warning: one live identity plus one deactivated is the
  // normal end state of a host migration. Deactivating did not clear it and
  // revoking the key did not clear it — both verified by substrate-claude — so the
  // only remaining route was deleting the AgentIdentity row, which the data
  // model forbids (AgentMessage.recipient is onDelete:set_null, 40 live
  // messages hang off it).
  const out = auditOrphans({
    keyNames: [],
    revokedNames: [],
    directoryKids: ['app-claude@Desk', 'app-claude@deskbook'],
    activeKids: ['app-claude@deskbook']
  });
  assert.equal(out.find((c) => c.id === 'orphans.hosts').state, 'ok');
});

test('a retired counterpart is REPORTED, not warned about and not hidden', () => {
  // Silence would be wrong too — an operator looking at a migration wants to
  // see it. It is a settled state, not an action.
  const out = auditOrphans({
    keyNames: [],
    revokedNames: [],
    directoryKids: ['app-claude@Desk', 'app-claude@deskbook'],
    activeKids: ['app-claude@deskbook']
  });
  const r = out.find((c) => c.id === 'orphans.retired');
  assert.equal(r.state, 'ok');
  assert.match(r.text, /retired host counterpart/);
  assert.match(r.detail, /nothing to do/);
});

test('two genuinely LIVE hosts still WARN', () => {
  const out = auditOrphans({
    keyNames: [],
    revokedNames: [],
    directoryKids: ['a-claude@h1', 'a-claude@h2'],
    activeKids: ['a-claude@h1', 'a-claude@h2']
  });
  assert.equal(out.find((c) => c.id === 'orphans.hosts').state, 'warn');
  assert.equal(
    out.find((c) => c.id === 'orphans.retired'),
    undefined
  );
});

test('omitting activeKids preserves the old behaviour rather than silently passing', () => {
  const out = auditOrphans({
    keyNames: [],
    revokedNames: [],
    directoryKids: ['a-claude@h1', 'a-claude@h2']
  });
  assert.equal(out.find((c) => c.id === 'orphans.hosts').state, 'warn');
});

// ---- does the salient tier actually RANK SEMANTICALLY? ----
//
// The audit is a separate process from the cold-start, so it measures ranking
// itself rather than reporting on a boost it never saw.

const vecs = (...ids) => new Map(ids.map((id) => [id, [1, 0]]));

test('salient: both inputs present is the ONLY ok state', () => {
  const out = auditSalientTier({
    probe: { vectors: vecs('r1', 'r2', 'anchor'), failed: null },
    activeRuleIds: ['r1', 'r2'],
    anchorId: 'anchor'
  });
  assert.equal(out[0].state, 'ok');
  assert.match(out[0].text, /ranking is SEMANTIC: 2\/2 rules and the anchor/);
});

test('salient: an embedded rule set with an UNEMBEDDED ANCHOR still short-circuits', () => {
  // The half nobody checks. rankRules needs both vectors; a complete rule
  // corpus proves nothing on its own, and reporting the rules as fine here
  // would be a green line beside a feature that is not running.
  const out = auditSalientTier({
    probe: { vectors: vecs('r1', 'r2'), failed: null },
    activeRuleIds: ['r1', 'r2'],
    anchorId: 'anchor'
  });
  assert.equal(out[0].state, 'warn');
  assert.match(out[0].text, /anchor has no embedding row/);
});

test('salient: no anchor at all is a warn, not an ok', () => {
  const out = auditSalientTier({
    probe: { vectors: vecs('r1'), failed: null },
    activeRuleIds: ['r1'],
    anchorId: null
  });
  assert.equal(out[0].state, 'warn');
  assert.match(out[0].text, /no anchor/);
});

test('salient: a failed probe is UNKNOWN, never "structural"', () => {
  // The distinction that matters. "Ranking is structural" is a measurement;
  // "we could not find out" is a hole. Collapsing the second into the first
  // makes a broken tier read as healthy.
  const out = auditSalientTier({
    probe: { vectors: new Map(), failed: 'recall/fetchEmbeddings: policy_denied' },
    activeRuleIds: ['r1'],
    anchorId: 'anchor'
  });
  assert.equal(out[0].state, 'unknown');
  assert.match(out[0].detail, /policy_denied/);
  assert.match(out[0].detail, /silently falls back to structural/);
});

test('salient: a PARTIALLY embedded set names the missing rules and still ranks', () => {
  const out = auditSalientTier({
    probe: { vectors: vecs('r1', 'anchor'), failed: null },
    activeRuleIds: ['r1', 'r2', 'r3'],
    anchorId: 'anchor'
  });
  assert.equal(out[0].state, 'ok');
  const missing = out.find((c) => c.id === 'salient.embedded');
  assert.equal(missing.state, 'warn');
  // Named, not counted — the old write-side check got this right and it is
  // kept: a count says "something is unembedded" and leaves the reader to
  // find which.
  assert.match(missing.text, /NO embedding row: r2, r3/);
});

test('salient: nothing embedded at all is a warn about the CORPUS', () => {
  const out = auditSalientTier({
    probe: { vectors: vecs('anchor'), failed: null },
    activeRuleIds: ['r1', 'r2'],
    anchorId: 'anchor'
  });
  assert.equal(out[0].state, 'warn');
  assert.match(out[0].text, /no active rule has an embedding row \(0\/2\)/);
  // No per-rule list here: naming all of them restates the count.
  assert.equal(
    out.find((c) => c.id === 'salient.embedded'),
    undefined
  );
});

test('salient: an empty rule set is UNKNOWN — nothing to measure is not a pass', () => {
  const out = auditSalientTier({
    probe: { vectors: new Map(), failed: null },
    activeRuleIds: [],
    anchorId: 'anchor'
  });
  assert.equal(out[0].state, 'unknown');
});

test('recall: the availability line states which BRANCH was taken', () => {
  assert.equal(
    auditSemanticRecall({ answered: true, reachable: true, reason: null })[0].state,
    'ok'
  );
  const bad = auditSemanticRecall({
    answered: false,
    reachable: true,
    reason: 'recall/Hit: 401'
  })[0];
  assert.equal(bad.state, 'warn');
  // The point of the line: the fallback is correct, silent and permanent, so a
  // fault-reporting instrument stays quiet. Only a branch-reporting one speaks.
  assert.match(bad.detail, /correct, silent, permanent fallback/);
});

test('recall: an UNREACHABLE server is unknown, never a recall fault', () => {
  // Found by running the audit against a dead port, where it warned that recall
  // was broken having never asked it. That is this module's own rule inverted:
  // asserting a verified-sounding fault from a check that did not run is no
  // better than silently passing one.
  const out = auditSemanticRecall({
    answered: false,
    reachable: false,
    reason: 'fetch failed'
  })[0];
  assert.equal(out.state, 'unknown');
  assert.match(out.detail, /check that did not run, not a recall fault/);
});

// ---- a key file's NAME is not its identity ----
//
// The prefix rule below (`<name>@<host>`) is right for keys provisioned by
// /substrate-setup and wrong for anything hand-made: a config can sign with
// `claude-agent.key` under a registered kid `claude-code@Desk`. Calling that an
// orphan invites retiring a key that is in use.
//
// The binding lives in whichever .mcp.json configures the pair, so that is
// what the audit must consult before claiming a key is unowned.

test('orphans: a name-mismatched key REFERENCED by a config with a registered kid is ok', () => {
  const out = auditOrphans({
    keyNames: ['claude-agent'],
    revokedNames: [],
    directoryKids: ['claude-code@Desk'],
    keyRefs: [{ keyName: 'claude-agent', kid: 'claude-code@Desk', source: 'ledger/.mcp.json' }]
  });
  const o = out.find((c) => c.id === 'orphans.keys');
  assert.equal(o.state, 'ok');
  assert.match(o.text, /claude-code@Desk/);
});

test('orphans: a referenced key whose kid is NOT registered is a real 401 risk', () => {
  const out = auditOrphans({
    keyNames: ['ghost'],
    revokedNames: [],
    directoryKids: ['claude-code@Desk'],
    keyRefs: [{ keyName: 'ghost', kid: 'ghost@Desk', source: 'x/.mcp.json' }]
  });
  const o = out.find((c) => c.id === 'orphans.keys');
  assert.equal(o.state, 'warn');
  assert.match(o.text, /ghost@Desk/);
});

test('orphans: an unreferenced key is reported as unreferenced, never as a 401', () => {
  const out = auditOrphans({
    keyNames: ['cursor'],
    revokedNames: [],
    directoryKids: ['claude-code@Desk'],
    keyRefs: [],
    refScanComplete: true
  });
  const o = out.find((c) => c.id === 'orphans.keys');
  assert.equal(o.state, 'warn');
  assert.match(o.text, /unreferenced/i);
  // The defect was CLAIMING a 401 risk, not mentioning the number. Saying
  // "these cannot 401" is the opposite claim and is worth keeping.
  assert.doesNotMatch(`${o.text} ${o.detail ?? ''}`, /may 401|will 401|401s every/);
});

test('orphans: with no config scan, orphanhood is UNKNOWN rather than asserted', () => {
  // A key may be referenced by any repo on the box. Auditing one repo cannot
  // see the others, so the honest answer is that the question was not asked.
  const out = auditOrphans({
    keyNames: ['claude-agent'],
    revokedNames: [],
    directoryKids: ['claude-code@Desk'],
    keyRefs: null
  });
  const o = out.find((c) => c.id === 'orphans.keys');
  assert.equal(o.state, 'unknown');
  assert.ok(o.detail, 'an unknown must carry a reason');
});

test('orphans: keyRefs omitted entirely stays UNKNOWN, not a silent pass', () => {
  const out = auditOrphans({
    keyNames: ['claude-agent'],
    revokedNames: [],
    directoryKids: ['claude-code@Desk']
  });
  assert.equal(out.find((c) => c.id === 'orphans.keys').state, 'unknown');
});

test('orphans: an incomplete scan cannot call an unreferenced key unowned', () => {
  // The exonerating reference lives in a repo this run did not read. Reporting
  // "orphan" here would be the key-name mistake above with an extra step.
  const out = auditOrphans({
    keyNames: ['claude-agent'],
    revokedNames: [],
    directoryKids: ['claude-code@Desk'],
    keyRefs: [],
    refScanComplete: false
  });
  const o = out.find((c) => c.id === 'orphans.keys');
  assert.equal(o.state, 'unknown');
  assert.match(o.detail, /--fleet/);
});

// ---- unattended identities are first-class, not gaps ----
//
// A daemon-held kid referenced from mise.toml env assignments (never an MCP
// session, never in any .mcp.json) must exonerate exactly like a config
// reference. And a kid with an inactive, intent-documented directory row
// asserts deliberate absence — the audit renders it visibly, not as a warn.

test('mise.toml KID+KEY pairs resolve to keyRefs with source carried', () => {
  const refs = scanMiseRefs([
    {
      path: 'tools/mise.toml',
      text: '[env]\nTOOLS_CONDUCTOR_KID = "tools-conductor@Desk"\nTOOLS_CONDUCTOR_KEY = "~/.config/substrate/keys/tools-conductor.key"\n'
    }
  ]);
  assert.deepEqual(refs, [
    {
      keyName: 'tools-conductor',
      kid: 'tools-conductor@Desk',
      source: 'tools/mise.toml'
    }
  ]);
});

test('mise scan skips unpaired names and non-kid values', () => {
  const refs = scanMiseRefs([
    {
      path: 'x/mise.toml',
      text: '[env]\nSOME_KEY = "~/.config/substrate/keys/orphan.key"\nNOT_A_KID = "plain-string"\nSUBSTRATE_AGENT_KID = "kid-without-host"\n'
    }
  ]);
  assert.deepEqual(refs, []);
});

test('a daemon key referenced from mise.toml with an asserted-absent kid is ok, visibly', () => {
  const out = auditOrphans({
    keyNames: ['tools-conductor'],
    revokedNames: [],
    directoryKids: ['claude-code@Desk', 'tools-conductor@Desk'],
    activeKids: ['claude-code@Desk'],
    directoryRows: [
      { kid: 'claude-code@Desk', active: true, description: 'laptop' },
      {
        kid: 'tools-conductor@Desk',
        active: false,
        description:
          'per-run conductor; expected-live: per-run; never Claim.author, never receives mail'
      }
    ],
    keyRefs: [
      {
        keyName: 'tools-conductor',
        kid: 'tools-conductor@Desk',
        source: 'tools/mise.toml'
      }
    ],
    refScanComplete: true
  });
  const o = out.find((c) => c.id === 'orphans.keys');
  assert.equal(o.state, 'ok');
  assert.match(`${o.text} ${o.detail ?? ''}`, /asserted absent by design/);
});

test('an inactive row WITHOUT documented intent still warns', () => {
  const out = auditOrphans({
    keyNames: ['ghost'],
    revokedNames: [],
    directoryKids: ['claude-code@Desk', 'ghost@Desk'],
    activeKids: ['claude-code@Desk'],
    directoryRows: [{ kid: 'ghost@Desk', active: false, description: null }],
    keyRefs: [{ keyName: 'ghost', kid: 'ghost@Desk', source: 'x/mise.toml' }],
    refScanComplete: true
  });
  const o = out.find((c) => c.id === 'orphans.keys');
  assert.equal(o.state, 'warn');
  assert.match(o.text, /ghost@Desk/);
});

// ---- what the credential HOLDS, which no local file can answer ----
//
// Key files and directory rows are not authority. A decommissioned agent can
// still hold a live `*` credential, and only the server's answer shows it.

const NEEDS = ['cortext', 'recall'];

test('a wildcard grant WARNS and names the omitted flag that causes it', () => {
  const out = auditAuthority({
    whoami: { ok: true, authenticated: true, id: 'a@h', capabilities: ['read'], namespaces: ['*'] },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const g = out.find((c) => c.id === 'authority.grant');
  assert.equal(g.state, 'warn');
  assert.match(g.text, /EVERY namespace/);
  assert.match(g.detail, /--ns` is OMITTED/);
});

test('a missing namespace WARNS and names it', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: ['read', 'mutate'],
      namespaces: ['cortext']
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const g = out.find((c) => c.id === 'authority.grant');
  assert.equal(g.state, 'warn');
  assert.match(g.text, /missing namespace\(s\): recall/);
  // The failure is silent-degradation, not an outage — say so, or a reader
  // triages it as cosmetic.
  assert.match(g.detail, /degrades rather than failing/);
});

test('an exactly-sufficient grant is ok', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: ['read', 'mutate'],
      namespaces: ['cortext', 'recall']
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  assert.equal(out.find((c) => c.id === 'authority.grant').state, 'ok');
});

test('a 401 is a REJECTED credential, not a hole — the revoked-key signal', () => {
  // "could not look" vs "looked", on the one check where a false `unknown`
  // hides a dead credential.
  const out = auditAuthority({
    whoami: { ok: false, failed: 'whoami 401' },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const g = out.find((c) => c.id === 'authority.grant');
  assert.equal(g.state, 'warn');
  assert.match(g.text, /REJECTED by the server/);
  assert.doesNotMatch(g.text, /could not ask/);
});

test('unreachable, unset URL and no-identity are UNKNOWN with distinct reasons', () => {
  const unreachable = auditAuthority({
    whoami: { ok: false, failed: 'connect ECONNREFUSED' },
    expectedNamespaces: NEEDS
  });
  assert.equal(unreachable.find((c) => c.id === 'authority.grant').state, 'unknown');

  // Only an answer without `authEnabled` reaches an unknown here: it genuinely
  // cannot say which of the two states it is.
  const anon = auditAuthority({
    whoami: { ok: true, authEnabled: null, authenticated: false },
    expectedNamespaces: NEEDS
  });
  const a = anon.find((c) => c.id === 'authority.grant');
  assert.equal(a.state, 'unknown');
  // A present-but-invalid token 401s before that handler runs, so this branch
  // must NOT be read as "my token was rejected".
  assert.match(a.detail, /NOT evidence that a token was rejected/);
});

// ---- the whoami route splits the ambiguous half of that answer ----

test('auth-disabled and credential-never-arrived are two WARNS, not one unknown', () => {
  // Both are DEFINITE answers with different fixes — a deployment posture this
  // caller cannot change, versus env vars that never took effect. Reporting
  // either as a hole is the failure this section exists to catch, one level up.
  const off = auditAuthority({
    whoami: { ok: true, authEnabled: false, authenticated: false },
    expectedNamespaces: NEEDS
  }).find((c) => c.id === 'authority.grant');
  assert.equal(off.state, 'warn');
  assert.match(off.text, /VERIFIES NOTHING/);

  const anon = auditAuthority({
    whoami: { ok: true, authEnabled: true, authenticated: false },
    expectedNamespaces: NEEDS
  }).find((c) => c.id === 'authority.grant');
  assert.equal(anon.state, 'warn');
  assert.match(anon.text, /carried no credential/);
  // The app shape: on a reads-open stack this state is byte-identical to a
  // working one, which is how it survived for months.
  assert.match(anon.detail, /SUBSTRATE_AGENT_KEY_PATH/);
  assert.notEqual(off.text, anon.text);
});

test('an unparseable whoami shape is UNKNOWN, never read as an empty grant', () => {
  // Reading absent-as-empty would UNDERSTATE authority, which is the safe
  // direction for a reader and the wrong one for an audit.
  const out = auditAuthority({
    whoami: { ok: true, authenticated: true, id: 'a@h', capabilities: null, namespaces: null },
    expectedNamespaces: NEEDS
  });
  assert.equal(out.find((c) => c.id === 'authority.grant').state, 'unknown');
});

// ---------------------------------------------------------------------------
// Per-namespace grants (substrate 5.23.0).
//
// `capabilities: null` stopped meaning one thing. It is still version skew when
// nothing else arrived, and it is now ALSO substrate's deliberate refusal to render
// a union that would over-report — with the real answer in `grants` beside it.
// Reading the second as the first reports a correctly-answering server as a
// hole, which is this audit's own stated failure mode pointed inward.
// ---------------------------------------------------------------------------

test('a null `capabilities` WITH a grant is answered, not degraded to unknown', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: ['cortext', 'recall'],
      grants: { cortext: ['read', 'mutate'], recall: ['read'] }
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  assert.equal(grant.state, 'ok');
  // Rendered in substrate's own `encodeGrant` entry syntax, so this line and
  // `substrate-admin list` can be diffed by eye.
  assert.match(grant.text, /grant: cortext:mutate\+read recall:read/);
});

test('a null `capabilities` with NO grant is still unknown', () => {
  // The flat reading stays exactly as loud. Nothing arrived
  // that could answer, so the hole is real.
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: ['cortext', 'recall'],
      grants: null
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  assert.equal(out.find((c) => c.id === 'authority.grant').state, 'unknown');
});

// From substrate 6.0.0 both flat fields are off the wire and `grants` is the
// second spelling of `namespaces`. So a null `namespaces` beside a grant is a
// server answering correctly, and the verdict is whatever the GRANT deserves.
test('a null `namespaces` WITH a grant is answerable', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: null,
      grants: { cortext: ['read'] }
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  // Not skew. The finding is about the grant being too narrow for what cortext
  // needs, which is a real answer rather than a hole.
  assert.notEqual(grant.state, 'unknown');
  assert.doesNotMatch(grant.text, /does not understand/);
});

test('`mutate` without `read` on ONE namespace WARNS — the state a flat list hides', () => {
  // The union of these grants is `read,mutate`, which renders as healthy and
  // passes the flat check. Every frame against `recall` is refused.
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: ['cortext', 'recall'],
      grants: { cortext: ['read', 'mutate'], recall: ['mutate'] }
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  assert.equal(grant.state, 'warn');
  assert.match(grant.text, /no `read` on recall/);
  // And the fleet caveat still renders — a partial failure is exactly where a
  // reader is most likely to assume the whole fleet was checked.
  assert.ok(out.some((c) => c.id === 'authority.fleet'));
});

test('an EXPLICIT entry beats the wildcard rather than adding to it', () => {
  // substrate's `capabilitiesFor`. `{'*': read+mutate, recall: read}` confers
  // exactly `read` on recall — the operator narrowed it deliberately, and a
  // union would hand back the reach they just removed. Here the narrow entry is
  // the one WITHOUT read, so a union reading would pass this and it must not.
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: ['*', 'recall'],
      grants: { '*': ['read', 'mutate'], recall: ['mutate'] }
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  assert.equal(grant.state, 'warn');
  assert.match(grant.text, /no `read` on recall/);
});

test('a namespace held only via the wildcard resolves through it', () => {
  // The other direction of the same rule: `cortext` has no explicit entry, so
  // it takes the wildcard's capabilities and is fine. This must not report as
  // missing or as readless.
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: ['*'],
      grants: { '*': ['read', 'mutate'] }
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  // A wildcard is over-broad and that WARN is the finding here — not a
  // read failure, which would be the wrong diagnosis for the same input.
  assert.equal(grant.state, 'warn');
  assert.match(grant.text, /EVERY namespace/);
});

test('a namespace NOT HELD reports as missing, never as readless', () => {
  // `intersectGrants` drops a namespace resolving to no capability, so an
  // absent one holds nothing. Reporting that as "no read" would answer a
  // question nobody asked.
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: ['cortext'],
      grants: { cortext: ['read', 'mutate'] }
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  assert.equal(grant.state, 'warn');
  assert.match(grant.text, /missing namespace\(s\): recall/);
});

test('a UNIFORM grant renders byte-identically to the pre-grant fleet', () => {
  // substrate keeps `capabilities` non-null when a flat list is honest, and the
  // render keys on that rather than on the presence of `grants` — so every
  // repo's audit output is unmoved by this change until a grant is genuinely
  // non-uniform.
  const flat = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: ['read', 'mutate'],
      namespaces: NEEDS
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const granted = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: ['read', 'mutate'],
      namespaces: NEEDS,
      grants: { cortext: ['read', 'mutate'], recall: ['read', 'mutate'] }
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  assert.deepEqual(granted, flat);
});

test('an EMPTY grant does not render as a blank pair of brackets', () => {
  // Reachable — claim and row sharing nothing — and `grant: ` alone would read
  // as a formatting bug rather than as a finding. Reached through the
  // unattributed branch because that is where the grant is actually RENDERED;
  // the missing-namespace line names the namespaces and never the grant.
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: [],
      grants: {}
    },
    expectedNamespaces: NEEDS,
    resolvedKid: null,
    declaredKid: null
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  assert.equal(grant.state, 'unknown');
  assert.match(grant.text, /\(grant: NOTHING\)/);
});

test('the flat zero-capability state stays loud — grants must not swallow it', () => {
  // `caps: []` is the signature of an intersected-away claim: verified, correctly
  // attributed, and able to do nothing. It cannot arise from a grant (empty
  // namespaces are dropped), so the flat branch is the only thing that catches
  // it and had to survive the per-namespace one being added beside it.
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: [],
      namespaces: NEEDS
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  assert.equal(grant.state, 'warn');
  assert.match(grant.text, /NO capabilities/);
});

test('a namespace named for an Object prototype key does not resolve up the chain', () => {
  // Namespace names arrive off the wire and land as KEYS. A bare lookup gives
  // `grants['constructor']` the Object constructor — a function, which passes a
  // length test and then throws on `.includes`. Here `constructor` is genuinely
  // NOT granted, so the right answer is the missing-namespace warn.
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: ['cortext'],
      grants: { cortext: ['read', 'mutate'] }
    },
    expectedNamespaces: ['cortext', 'constructor'],
    resolvedKid: 'a@h'
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  assert.equal(grant.state, 'warn');
  assert.match(grant.text, /missing namespace\(s\): constructor/);
});

test('signing as a different kid than the repo resolved WARNS', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'other@h',
      capabilities: ['read'],
      namespaces: ['cortext', 'recall']
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'mine@h'
  });
  assert.equal(out[0].state, 'warn');
  assert.match(out[0].text, /signing as 'other@h'/);
});

test('the fleet caveat renders on EVERY path that reaches a real answer', () => {
  // Including the wildcard path, which returns early — that is precisely the
  // state in which a reader is most likely to assume the fleet was checked.
  for (const namespaces of [['*'], ['cortext'], ['cortext', 'recall']]) {
    const out = auditAuthority({
      whoami: { ok: true, authenticated: true, id: 'a@h', capabilities: ['read'], namespaces },
      expectedNamespaces: NEEDS,
      resolvedKid: 'a@h'
    });
    const fleet = out.find((c) => c.id === 'authority.fleet');
    assert.notEqual(fleet, undefined, `no fleet caveat for ${namespaces.join(',')}`);
    assert.equal(fleet.state, 'info');
    assert.match(fleet.detail, /substrate-admin list/);
  }
});

// ---- the AUDITOR's grant is not the target's ----
//
// whoami is a SELF view. Auditing another repo, a wildcard grant under an
// unknown identity is the auditing session's own, not the target's.

test('an unresolved subject cannot have a verified authority', () => {
  // No session in the target dir, nothing pinned, so the
  // wildcard belongs to whoever ran the audit.
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'auditor@h',
      capabilities: ['read', 'mutate'],
      namespaces: ['*']
    },
    expectedNamespaces: NEEDS,
    resolvedKid: null,
    declaredKid: null
  });
  const g = out.find((c) => c.id === 'authority.grant');
  assert.equal(g.state, 'unknown');
  // It still prints the reading — withholding it would lose a real signal —
  // but attributes it, which is the whole defect.
  assert.match(g.text, /auditor@h/);
  assert.match(g.text, /NOT established as this target/);
  assert.doesNotMatch(g.text, /^granted/);
});

test('the false OK — a narrow auditor over an over-granted target', () => {
  // The direction that was never observed and is worse: the substitution runs
  // both ways, so gating on the wildcard alone would have fixed half of it.
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'auditor@h',
      capabilities: ['read'],
      namespaces: ['cortext', 'recall']
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'target@h',
    selfAudit: false
  });
  const g = out.find((c) => c.id === 'authority.grant');
  assert.equal(g.state, 'unknown');
  assert.match(g.detail, /target@h/);
  // Pointed at another repo, a kid mismatch is the expected state — warning on
  // it trains the reader to skip the line that matters.
  assert.equal(out.filter((c) => c.id === 'authority.grant' && c.state === 'warn').length, 0);
});

test('a target that PINS its kid stays answerable with no session up', () => {
  // `.mcp.json` is target-derived, so it can establish the subject where the
  // auditor's own env cannot. Without this the fix would downgrade every
  // plain-shell audit to unknown and lose the wildcard signal.
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'target@h',
      capabilities: ['read', 'mutate'],
      namespaces: ['*']
    },
    expectedNamespaces: NEEDS,
    resolvedKid: null,
    declaredKid: 'target@h'
  });
  const g = out.find((c) => c.id === 'authority.grant');
  assert.equal(g.state, 'warn');
  assert.match(g.text, /EVERY namespace/);
  assert.match(g.text, /target@h/);
});

test('an attributed grant names the subject on both verdicts', () => {
  for (const namespaces of [['*'], ['cortext', 'recall']]) {
    const out = auditAuthority({
      whoami: { ok: true, authenticated: true, id: 'a@h', capabilities: ['read'], namespaces },
      expectedNamespaces: NEEDS,
      resolvedKid: 'a@h'
    });
    assert.match(out.find((c) => c.id === 'authority.grant').text, /a@h/);
  }
});

test('the fleet caveat still renders on the unattributable path', () => {
  const out = auditAuthority({
    whoami: { ok: true, authenticated: true, id: 'x@h', capabilities: [], namespaces: ['cortext'] },
    expectedNamespaces: NEEDS,
    resolvedKid: null
  });
  assert.equal(out.find((c) => c.id === 'authority.fleet')?.state, 'info');
});

test('credentialIsTargets accepts only TARGET-derived witnesses', () => {
  const whoami = { ok: true, authenticated: true, id: 'a@h', capabilities: [], namespaces: [] };
  assert.equal(credentialIsTargets({ whoami, resolvedKid: 'a@h' }), true);
  assert.equal(credentialIsTargets({ whoami, declaredKid: 'a@h' }), true);
  assert.equal(credentialIsTargets({ whoami, resolvedKid: 'b@h', declaredKid: 'b@h' }), false);
  assert.equal(credentialIsTargets({ whoami }), false);
  // An unnamed or unauthenticated subject establishes nothing.
  assert.equal(
    credentialIsTargets({ whoami: { ok: true, authenticated: true, id: null }, resolvedKid: null }),
    false
  );
  assert.equal(
    credentialIsTargets({ whoami: { ok: true, authenticated: false }, resolvedKid: 'a@h' }),
    false
  );
});

test('recall answering is a fact about the credential that ASKED', () => {
  // A per-credential difference: a repo whose grant omits
  // `recall` degrades silently while the auditor's credential answers fine.
  const out = auditSemanticRecall({
    answered: true,
    reachable: true,
    reason: null,
    credentialAttributed: false
  });
  assert.equal(out[0].state, 'unknown');
  assert.match(out[0].detail, /namespace grant/);
  // And the self case is untouched.
  assert.equal(
    auditSemanticRecall({ answered: true, reachable: true, reason: null })[0].state,
    'ok'
  );
});

// ---- skill-text staleness is silent, and nothing reconciles it ----
//
// The fragment has a resolver that installs over a stale copy and an audit line
// that reports drift. Skill prose has neither, so a session can be served an
// older skill than the one installed and follow superseded instructions.

test('served OLDER than installed says the skill text is RETIRED, not just rebind', () => {
  const out = auditPlugin({
    installedVersion: '1.13.3',
    cacheVersions: ['1.13.2', '1.13.3'],
    servedVersion: '1.13.2',
    servedRoot: 'derived-cache',
    compare: cmp
  });
  const s = out.find((c) => c.id === 'plugin.served');
  assert.equal(s.state, 'warn');
  assert.match(s.text, /RETIRED/);
  // Session-binding was the old framing and undersells it: the instruction
  // being followed may itself be superseded.
  assert.match(s.detail, /superseded/);
  assert.match(s.detail, /nothing reconciles skill prose/);
});

test('a derived root answers WITHOUT CLAUDE_PLUGIN_ROOT — the check that never fired', () => {
  // The whole reason this line spent its life reporting `[????] normal`: the
  // harness expands the variable into the hook's command string rather than
  // into process.env, so the env-var-only path is the uncommon one.
  const served = auditPlugin({
    installedVersion: '1.13.3',
    cacheVersions: ['1.13.3'],
    servedVersion: '1.13.3',
    servedRoot: 'derived-cache',
    compare: cmp
  });
  assert.equal(served.find((c) => c.id === 'plugin.served').state, 'ok');
});

test('a SOURCE TREE run reports a hole, never the working tree as "served"', () => {
  // Reporting the auditor's own version under a heading the reader takes to be
  // about the session is the auditor-for-target substitution above.
  const out = auditPlugin({
    installedVersion: '1.13.3',
    cacheVersions: ['1.13.3'],
    servedVersion: '9.9.9',
    servedRoot: 'derived-source',
    compare: cmp
  });
  const s = out.find((c) => c.id === 'plugin.served');
  assert.equal(s.state, 'unknown');
  assert.match(s.text, /SOURCE TREE/);
  assert.doesNotMatch(s.text, /9\.9\.9/);
});

test('a derived root with no readable marker warns rather than passing', () => {
  const out = auditPlugin({
    installedVersion: '1.13.3',
    cacheVersions: ['1.13.3'],
    servedVersion: null,
    servedRoot: 'derived-cache',
    compare: cmp
  });
  const s = out.find((c) => c.id === 'plugin.served');
  assert.equal(s.state, 'warn');
  assert.match(s.text, /no readable fragment marker/);
});

// ---- a tracked .mcp.json that drifts to machine-specific ----
//
// The gitignore rule is conditioned on CONTENT. Its one failure mode is a file
// that starts portable and stays TRACKED while someone edits a machine value
// in — and the cost lands in git history, which is not retractable.

const MCP_OK = { present: true, tracked: true, markers: [] };

test('tracked + machine-specific WARNS and names the fields', () => {
  const out = auditMcpJson({
    present: true,
    tracked: true,
    markers: [
      { field: 'substrate.command', kind: 'absolute path' },
      { field: 'substrate.env.SUBSTRATE_AGENT_KEY_ID', kind: 'host-pinned identity' }
    ]
  });
  assert.equal(out[0].state, 'warn');
  assert.match(out[0].text, /TRACKED/);
  assert.match(out[0].text, /substrate\.env\.SUBSTRATE_AGENT_KEY_ID \(host-pinned identity\)/);
  assert.match(out[0].detail, /not retractable/);
});

test('the two CORRECT arrangements are ok, and the ignored-portable case says so', () => {
  assert.equal(auditMcpJson(MCP_OK)[0].state, 'ok');

  const ignoredMachine = auditMcpJson({
    present: true,
    tracked: false,
    markers: [{ field: 'substrate.command', kind: 'absolute path' }]
  });
  assert.equal(ignoredMachine[0].state, 'ok');
  assert.match(ignoredMachine[0].text, /correctly ignored/);

  // Harmless, but the content rule would commit it — a detail, not a warning.
  const ignoredPortable = auditMcpJson({ present: true, tracked: false, markers: [] });
  assert.equal(ignoredPortable[0].state, 'ok');
  assert.match(ignoredPortable[0].detail, /would commit this form/);
});

test('unparseable, absent and un-askable git each report distinctly', () => {
  // "I could not look" must never render as "I looked and found nothing" —
  // the defect this whole file exists to catch.
  assert.equal(auditMcpJson({ present: null, tracked: null, markers: null })[0].state, 'unknown');

  const absent = auditMcpJson({ present: false, tracked: null, markers: null });
  assert.equal(absent[0].state, 'ok');
  assert.match(absent[0].text, /no project \.mcp\.json/);

  // Not a git repo, or git failed: tracked-vs-ignored is the whole check.
  const noGit = auditMcpJson({ present: true, tracked: null, markers: [] });
  assert.equal(noGit[0].state, 'unknown');
  assert.match(noGit[0].detail, /git could not answer/);
});

// ---- "no anchor" has two causes and needs two remediations ----

test('never-had-one is an outstanding ONBOARDING step, not a fault', () => {
  const out = auditSalientTier({
    probe: { vectors: new Map([['r1', [0.1]]]), failed: null },
    activeRuleIds: ['r1'],
    anchorId: null,
    anchorHistory: 'none'
  });
  const r = out.find((c) => c.id === 'salient.rank');
  assert.equal(r.state, 'warn');
  assert.match(r.text, /NEVER had an anchor/);
  assert.match(r.detail, /outstanding onboarding step/);
  // The fix that looks obvious and is wrong.
  assert.match(r.detail, /placeholder is worse than none/);
});

test('all-archived is a RETIRED focus — same symptom, different fix', () => {
  const out = auditSalientTier({
    probe: { vectors: new Map([['r1', [0.1]]]), failed: null },
    activeRuleIds: ['r1'],
    anchorId: null,
    anchorHistory: 'archived'
  });
  const r = out.find((c) => c.id === 'salient.rank');
  assert.equal(r.state, 'warn');
  assert.match(r.text, /ARCHIVED/);
  assert.match(r.detail, /had an anchor and retired it/);
});

test('an unprobed history stays honest rather than guessing either cause', () => {
  const out = auditSalientTier({
    probe: { vectors: new Map([['r1', [0.1]]]), failed: null },
    activeRuleIds: ['r1'],
    anchorId: null
  });
  const r = out.find((c) => c.id === 'salient.rank');
  assert.equal(r.state, 'warn');
  assert.match(r.detail, /was not established/);
  assert.doesNotMatch(r.text, /NEVER|ARCHIVED/);
});

// ---- a capability the audit must CHECK, not only render ----
//
// A claim that omits what the _system/Key row grants is
// intersected AWAY, so an `admin`-registered kid against agent-auth.js's
// hardcoded `['read','mutate']` mints a token holding nothing. whoami answers
// (that route does not gate on `read`), the identity is verified and correctly
// attributed — and every `/substrate/v1/query` returns
// `{"code":"forbidden","required":"read","have":[]}`.
//
// So `ok` ("covers what this capability needs") must never render over a
// credential that cannot read a byte.

test('a ZERO-capability credential WARNS — it must not reach the ok branch', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: [],
      namespaces: ['cortext', 'recall']
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const g = out.find((c) => c.id === 'authority.grant');
  assert.equal(g.state, 'warn');
  assert.match(g.text, /NO capabilities/);
  assert.match(g.text, /every read is refused/);
  // The namespace verdict must NOT also render — it is moot, and an `ok`
  // beside this warn is the contradiction the check exists to remove.
  assert.doesNotMatch(g.text, /covers what this capability needs/);
  assert.equal(
    out.filter((c) => c.id === 'authority.grant').length,
    1,
    'exactly one grant verdict, not a warn and an ok'
  );
});

test('capabilities present but WITHOUT read is the same finding, and names them', () => {
  // The fleet's own admin row: `capabilities: admin`, intersected against the
  // default claim. `admin` is not `read` — substrate refuses /substrate/v1/query
  // with `{"required":"read","have":["admin"]}`.
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: ['admin'],
      namespaces: ['cortext', 'recall']
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const g = out.find((c) => c.id === 'authority.grant');
  assert.equal(g.state, 'warn');
  assert.match(g.text, /no `read`/);
  assert.match(g.text, /caps: admin/);
  assert.match(g.detail, /"have":\["admin"\]/);
});

test('the capability verdict OUTRANKS the wildcard-namespace warn', () => {
  // Both are warns, so a state check alone cannot tell them apart — and a
  // credential with `*` it cannot use is a dead credential, not an over-broad
  // one. Reporting the over-breadth sends the reader to `substrate-admin register
  // --ns`, which fixes nothing here.
  const out = auditAuthority({
    whoami: { ok: true, authenticated: true, id: 'a@h', capabilities: [], namespaces: ['*'] },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const g = out.find((c) => c.id === 'authority.grant');
  assert.match(g.text, /NO capabilities/);
  assert.doesNotMatch(g.text, /EVERY namespace/);
});

test('the detail names BOTH causes and rules out the wildcard claim', () => {
  // The row may not grant `read`, or it does and our claim omitted it. Only
  // `substrate-admin list` separates them, so neither may be asserted as the cause.
  // And `['*']` is not the fix: both capability gates do a
  // bare `includes` with no wildcard branch, so a wildcard claim resolves to
  // the literal `['*']` and is refused everything.
  const g = auditAuthority({
    whoami: { ok: true, authenticated: true, id: 'a@h', capabilities: [], namespaces: ['cortext'] },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  }).find((c) => c.id === 'authority.grant');
  assert.match(g.detail, /substrate-admin list/);
  assert.match(g.detail, /SUBSET/);
  assert.match(g.detail, /`\['\*'\]` is NOT a valid claim/);
});

test('a sufficient credential is still ok — the gate discriminates', () => {
  // Guards the obvious over-correction: a check that warns on everything is as
  // useless as one that warns on nothing.
  const g = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: ['read'],
      namespaces: ['cortext', 'recall']
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  }).find((c) => c.id === 'authority.grant');
  assert.equal(g.state, 'ok');
});

test('an UNATTRIBUTED credential is still unknown, not a capability warn', () => {
  // The grant belongs to the audit PROCESS, not the target. Its caps are
  // none of this target's business, so the capability gate must sit after the
  // attribution gate rather than in front of it.
  const g = auditAuthority({
    whoami: { ok: true, authenticated: true, id: 'other@h', capabilities: [], namespaces: ['*'] },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h',
    selfAudit: false
  }).find((c) => c.id === 'authority.grant');
  assert.equal(g.state, 'unknown');
  assert.match(g.text, /NOT established as this target's/);
});

// ---- the signer already knew why, and the audit threw it away ----

test('a local signer warning REPLACES the derived never-took-effect reading', () => {
  const whoami = { ok: true, authEnabled: true, authenticated: false };
  const derived = auditAuthority({ whoami, expectedNamespaces: NEEDS }).find(
    (c) => c.id === 'authority.grant'
  );
  // Unchanged when the signer has nothing to add — this IS the env case.
  assert.match(derived.detail, /never took effect for this process/);

  const local = auditAuthority({
    whoami,
    expectedNamespaces: NEEDS,
    authWarning:
      '<!-- agent identity misconfigured: cannot load /nonexistent/a.key: ENOENT — reads are anonymous -->\n'
  }).find((c) => c.id === 'authority.grant');
  assert.equal(local.state, 'warn');
  // Both env vars DID arrive; the key material is the fault. Different fix.
  assert.match(local.detail, /NOT the env-never-arrived case/);
  assert.match(local.detail, /ENOENT/);
  assert.doesNotMatch(local.detail, /never took effect for this process/);
});

// ---- substrate 6.0.0 drops the flat Identity fields from the WIRE. The
// whoami projection becomes `{ id, grants }`, so both `namespaces` and
// `capabilities` are absent by design and `grants` carries the whole answer.
//
// A null flat field beside a present `grants` is a MORE precise answer, not a
// hole: absent flat fields are the new shape when `grants` is present, and skew only
// when nothing arrived that could answer. Both wire shapes are still accepted,
// so neither may be assumed.
test('the grants-only whoami of substrate 6.0.0 is not version skew', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      // Absent on the wire, not null-by-default — 6.0.0 removed them.
      capabilities: null,
      namespaces: null,
      grants: { cortext: ['read', 'mutate'], recall: ['read'] }
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  assert.equal(grant.state, 'ok');
  assert.doesNotMatch(grant.text, /does not understand/);
});

// The namespace set has to be DERIVED from the grant keys, or every downstream
// reader of `ns` is reading null. Two of them interpolate it into the text a
// human acts on, and one tests `ns.includes('*')`.
test('the namespace set is derived from the grant keys when the flat field is gone', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: null,
      grants: { recall: ['read'], cortext: ['read', 'mutate'] }
    },
    expectedNamespaces: NEEDS,
    // A kid that does not match, so the unattributed branch renders `ns` into
    // its message — the reader-facing use that would print `null` otherwise.
    resolvedKid: 'someone-else@h'
  });
  const texts = out
    .filter((c) => c.id === 'authority.grant')
    .map((c) => c.text)
    .join(' | ');
  assert.match(texts, /cortext,recall/);
  assert.doesNotMatch(texts, /null/);
});

// A wildcard grant key must still read as the wildcard. substrate 6.0.0's
// systemActor states `{ '*': read+mutate }`, so this is the shape an operator
// audit of a system credential actually sees.
test('a `*` grant key still reads as EVERY namespace', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: null,
      grants: { '*': ['read', 'mutate'] }
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'someone-else@h'
  });
  const texts = out
    .filter((c) => c.id === 'authority.grant')
    .map((c) => c.text)
    .join(' | ');
  assert.match(texts, /EVERY namespace/);
});

// The real hole stays exactly as loud. Nothing arrived that could answer.
test('absent flat fields with NO grant is still skew', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: null,
      grants: null
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  assert.equal(grant.state, 'unknown');
  assert.match(grant.text, /does not understand/);
});

// ---- systemd user units are a third binding surface ----
//
// A worker can sign via `Environment=APP_SUBSTRATE_AGENT_KEY=%h/.config/substrate/keys/app-prime.key`
// in a systemd user unit, so a key referenced only there is not unused. The
// unit names the key but not always the kid, so a kid-less reference still counts.

test('systemd Environment= key paths resolve to keyRefs, %h expanded', () => {
  const refs = scanSystemdRefs([
    {
      path: '~/.config/systemd/user/app-prime-worker.service',
      text: '[Service]\nEnvironment=APP_SUBSTRATE_AGENT_KEY=%h/.config/substrate/keys/app-prime.key\nExecStart=/usr/bin/node worker.js\n'
    }
  ]);
  assert.deepEqual(refs, [
    {
      keyName: 'app-prime',
      kid: null,
      source: '~/.config/systemd/user/app-prime-worker.service'
    }
  ]);
});

test('systemd scan pairs a _KID on the same stem, and reads quoted multi-assignments', () => {
  const refs = scanSystemdRefs([
    {
      path: 'u.service',
      text: '[Service]\nEnvironment="PRIME_KID=app-prime@deskbook" "PRIME_KEY=%h/.config/substrate/keys/app-prime.key"\n'
    }
  ]);
  assert.deepEqual(refs, [
    { keyName: 'app-prime', kid: 'app-prime@deskbook', source: 'u.service' }
  ]);
});

test('systemd scan ignores key-named vars that are not substrate key paths', () => {
  const refs = scanSystemdRefs([
    {
      path: 'u.service',
      text: '[Service]\nEnvironment=API_KEY=abc123\nEnvironment=SSH_KEY=%h/.ssh/id_ed25519\n'
    }
  ]);
  assert.deepEqual(refs, []);
});

test('a key referenced with NO stated kid is accounted for, not unreferenced', () => {
  const out = auditOrphans({
    keyNames: ['app-prime'],
    revokedNames: [],
    directoryKids: ['claude-code@Desk'],
    keyRefs: [{ keyName: 'app-prime', kid: null, source: 'app-prime-worker.service' }],
    refScanComplete: true
  });
  const o = out.find((c) => c.id === 'orphans.keys');
  assert.equal(o.state, 'ok');
  assert.match(o.text, /app-prime/);
  assert.match(o.text, /app-prime-worker\.service/);
  assert.doesNotMatch(o.text, /unreferenced/i);
});

test('the unreferenced headline claims only what the scan saw', () => {
  const out = auditOrphans({
    keyNames: ['operator'],
    revokedNames: [],
    directoryKids: ['claude-code@Desk'],
    keyRefs: [],
    refScanComplete: true
  });
  const o = out.find((c) => c.id === 'orphans.keys');
  assert.equal(o.state, 'warn');
  assert.doesNotMatch(`${o.text} ${o.detail}`, /nothing signs with these/);
  assert.match(o.text, /systemd/);
  // A key used through a tool (e.g. `app enroll`'s operator key) is invisible
  // to any config scan. Say so, so the reader does not retire it on this alone.
  assert.match(o.detail, /through a tool/);
});

// ---- inbox push (synoptic 2.4.0) ----

test('auditInboxPush: defaults read as push on, wake off, no urgent senders', () => {
  const out = auditInboxPush({ env: { SUBSTRATE_AGENT_KEY_ID: 'me@Host' } });
  assert.deepEqual(
    out.map((f) => [f.id, f.state]),
    [
      ['inbox.push', 'ok'],
      ['inbox.wake', 'ok'],
      ['inbox.urgent', 'ok']
    ]
  );
  assert.match(out[0].text, /push on/);
  assert.match(out[1].text, /wake off/);
  assert.match(out[2].text, /urgent preemption off/);
});

test('auditInboxPush: PUSH=off is reported as the deliberate rollback', () => {
  const [push] = auditInboxPush({
    env: { SUBSTRATE_AGENT_KEY_ID: 'me@Host', SYNOPTIC_INBOX_PUSH: 'off' }
  });
  assert.equal(push.state, 'ok');
  assert.match(push.text, /push off/);
});

test('auditInboxPush: no identity means push cannot run, and says why', () => {
  const [push] = auditInboxPush({ env: {} });
  assert.equal(push.state, 'warn');
  assert.match(push.text, /no agent identity/);
});

test('auditInboxPush: a value that is neither on nor off is flagged, not silently defaulted', () => {
  const out = auditInboxPush({
    env: {
      SUBSTRATE_AGENT_KEY_ID: 'me@Host',
      SYNOPTIC_INBOX_PUSH: 'false',
      SYNOPTIC_INBOX_WAKE: 'yes'
    }
  });
  assert.equal(out[0].state, 'warn');
  assert.match(out[0].text, /SYNOPTIC_INBOX_PUSH="false".*stays on/);
  assert.equal(out[1].state, 'warn');
  assert.match(out[1].text, /SYNOPTIC_INBOX_WAKE="yes".*stays off/);
});

test('auditInboxPush: names the urgent senders when set', () => {
  const out = auditInboxPush({
    env: { SUBSTRATE_AGENT_KEY_ID: 'me@Host', SYNOPTIC_INBOX_URGENT_FROM: 'coord@Host, ops@Host' }
  });
  assert.match(out[2].text, /urgent preemption allowed from 2 kid\(s\): coord@Host, ops@Host/);
});

// The capability declares what it does to each namespace, so the audit can
// check `mutate` where it is needed. A key narrowed to `cortext:read` must not
// render a clean `ok` and then fail at the cold-start's first write.
const NEEDS_CAPS = { cortext: ['read', 'mutate'], recall: ['read', 'mutate'] };

test('a held namespace missing a NEEDED capability warns, naming it', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: ['cortext', 'recall'],
      grants: { cortext: ['read'], recall: ['read', 'mutate'] }
    },
    expectedNamespaces: NEEDS,
    expectedCapabilities: NEEDS_CAPS,
    resolvedKid: 'a@h'
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  assert.equal(grant.state, 'warn');
  assert.match(grant.text, /no `mutate` on cortext/);
});

test('the flat path checks needed capabilities too', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: ['read'],
      namespaces: ['cortext', 'recall'],
      grants: null
    },
    expectedNamespaces: NEEDS,
    expectedCapabilities: NEEDS_CAPS,
    resolvedKid: 'a@h'
  });
  const grant = out.find((c) => c.id === 'authority.grant');
  assert.equal(grant.state, 'warn');
  assert.match(grant.text, /no `mutate` on cortext, recall/);
});

test('a grant covering every needed capability passes', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: ['read', 'mutate'],
      namespaces: ['cortext', 'recall'],
      grants: { cortext: ['read', 'mutate'], recall: ['read', 'mutate'] }
    },
    expectedNamespaces: NEEDS,
    expectedCapabilities: NEEDS_CAPS,
    resolvedKid: 'a@h'
  });
  assert.equal(out.find((c) => c.id === 'authority.grant').state, 'ok');
});

test('without declared capabilities, mutate is still not invented', () => {
  const out = auditAuthority({
    whoami: {
      ok: true,
      authenticated: true,
      id: 'a@h',
      capabilities: null,
      namespaces: ['cortext', 'recall'],
      grants: { cortext: ['read'], recall: ['read'] }
    },
    expectedNamespaces: NEEDS,
    resolvedKid: 'a@h'
  });
  assert.equal(out.find((c) => c.id === 'authority.grant').state, 'ok');
});

// ---- roaming identities and the Codex config surface ----

test('a ROAMING name on two hosts is named on the ok line, not warned about or called retired', () => {
  const kids = ['codex@desk', 'codex@deskbook'];
  const out = auditOrphans({
    keyNames: [],
    revokedNames: [],
    directoryKids: kids,
    activeKids: kids,
    directoryRows: kids.map((kid) => ({ kid, active: true, description: null, roaming: true }))
  });
  const h = out.find((c) => c.id === 'orphans.hosts');
  assert.equal(h.state, 'ok');
  assert.match(h.text, /roaming, one per host by design: codex@desk \/ codex@deskbook/);
  assert.equal(
    out.find((c) => c.id === 'orphans.retired'),
    undefined
  );
});

test('a pair with only ONE roaming member still warns', () => {
  const kids = ['a@h1', 'a@h2'];
  const out = auditOrphans({
    keyNames: [],
    revokedNames: [],
    directoryKids: kids,
    activeKids: kids,
    directoryRows: [
      { kid: 'a@h1', active: true, description: null, roaming: true },
      { kid: 'a@h2', active: true, description: null, roaming: null }
    ]
  });
  assert.equal(out.find((c) => c.id === 'orphans.hosts').state, 'warn');
});

test('scanCodexRefs reads the identity a Codex skin signs with', () => {
  const refs = scanCodexRefs([
    {
      path: '/r/.codex/cortext.local.json',
      text: JSON.stringify({
        env: {
          SUBSTRATE_AGENT_KEY_ID: 'codex@desk',
          SUBSTRATE_AGENT_KEY_PATH: '/home/u/.config/substrate/keys/codex@desk.key'
        }
      })
    },
    { path: '/missing', text: null },
    { path: '/broken', text: '{"env":' },
    { path: '/relative', text: '{"env":{"SUBSTRATE_AGENT_KEY_PATH":"keys/x.key"}}' }
  ]);
  assert.deepEqual(refs, [
    { keyName: 'codex@desk', kid: 'codex@desk', source: '/r/.codex/cortext.local.json' }
  ]);
});

test('a key referenced only by a Codex config is accounted for, not unreferenced', () => {
  const out = auditOrphans({
    keyNames: ['codex@desk'],
    revokedNames: [],
    directoryKids: ['codex@desk'],
    activeKids: ['codex@desk'],
    keyRefs: scanCodexRefs([
      {
        path: '/r/.codex/cortext.local.json',
        text: '{"env":{"SUBSTRATE_AGENT_KEY_ID":"codex@desk","SUBSTRATE_AGENT_KEY_PATH":"/h/.config/substrate/keys/codex@desk.key"}}'
      }
    ]),
    refScanComplete: true
  });
  assert.equal(out.find((c) => c.id === 'orphans.keys').state, 'ok');
});

// ---- a permanent caveat must not make a healthy audit exit 1 ----
test('info findings render as notes, are not counted, and leave "Nothing to do" reachable', () => {
  const report = renderAudit([
    [
      'Authority',
      [
        check('a', 'ok', 'fine'),
        check(
          'authority.fleet',
          'info',
          'other identities are not visible',
          'use substrate-admin list'
        )
      ]
    ]
  ]);
  assert.match(report, /\[note\] {2}other identities are not visible/);
  assert.match(report, /\*\*1 checks passed\.\*\* Nothing to do\./);
  // audit-entry exits 1 on exactly this pattern.
  assert.doesNotMatch(report, /\[WARN\]|\[\?\?\?\?\]/);
});
