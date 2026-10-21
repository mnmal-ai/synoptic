// The fleet audit's `hosts` section. Pure: built from HostInstall rows, not
// local disk, so it covers hosts this machine cannot see, and reconciled
// against the AgentIdentity directory, which says where each project is worked.
//
// A quiet host is a hole, not a pass, and a stale one is a warning: a dead host
// must not read as a quiet one.

import { normaliseHost } from './fleet-fragments.js';
import { SETTINGS_ENV_ALLOWLIST, SETTINGS_ENV_PRESENCE } from './host-checks.js';
import { classifyInstall, describeAge } from './host-install.js';

const STATE_OF = { fresh: 'ok', quiet: 'unknown', stale: 'warn' };
// The reason an unknown or warn age carries. audit.mjs refuses an unknown
// finding without one, so a quiet host must say why it is not a verdict.
const INSTALL_DETAIL = {
  quiet:
    'no session has started in that repo for over a day, so the row is probably still true but unconfirmed; starting one refreshes it',
  stale:
    'no session has started there for over a week; do not rely on the row, the host or repo may be gone'
};

// The switches compared for drift. SYNOPTIC_PROJECT_SCOPE is recorded but left
// out: it is legitimately set per repo.
const DRIFT_KEYS = [
  ...SETTINGS_ENV_ALLOWLIST.filter((k) => k !== 'SYNOPTIC_PROJECT_SCOPE'),
  ...SETTINGS_ENV_PRESENCE
];

// Row fields are written by whoever holds a key, and this report is read by
// agents. Control characters would let a value forge report lines, and
// backticks would let it close a code span, so both go; length is capped.
const MAX_FIELD = 64;
const MAX_NOTE = 200;
function clean(value, max = MAX_FIELD) {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/[\p{Cc}`]/gu, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
// Key parts additionally lose whitespace, so a key stays one token.
const token = (value) => (clean(value) ?? '?').replace(/\s+/g, '_');

const FIELDS = [
  'host',
  'project',
  'kid',
  'harness',
  'pluginVersion',
  'fragmentVersion',
  'fragmentDigest',
  'fragmentState',
  'refreshedAt',
  'pinState',
  'pinNote',
  'mcpJsonState',
  'mcpJsonNote',
  'authorityState',
  'authorityNote',
  'settingsState',
  'settingsNote'
];

// The cold-start's checks, by row field, with the remedy each points to. The
// remedies are fixed text: row values must not reach an instruction.
const CHECKS = [
  ['pin', 'pin', 'update the plugin on that host, or refresh its marketplace clone'],
  ['mcpJson', '.mcp.json', 'run audit.mjs in that repo for the detail'],
  [
    'authority',
    'authority',
    'the note names which: a key rejected or not loaded, a signer other than the repo kid, a server verifying nothing, or a grant too narrow or too broad. Run audit.mjs in that repo for the fix'
  ],
  [
    'settings',
    'settings',
    "fix that repo's .claude/settings.local.json; audit.mjs there has the detail"
  ]
];
function cleanRow(row) {
  const out = { _metadata: { updatedBy: { id: clean(row?._metadata?.updatedBy?.id) } } };
  for (const f of FIELDS) out[f] = clean(row?.[f], f.endsWith('Note') ? MAX_NOTE : MAX_FIELD);
  return out;
}

/**
 * @param {{ rows: Array<object>|null, directoryRows: Array<object>|null,
 *   nowMs: number, compare: (a: string, b: string) => number }} p
 */
export function auditHosts({ rows, directoryRows, nowMs, compare }) {
  if (rows === null || directoryRows === null) {
    return [
      {
        id: 'hosts.read',
        state: 'unknown',
        text:
          rows === null
            ? 'HostInstall rows could not be read, so no host was checked'
            : 'the AgentIdentity directory could not be read, so no host was checked',
        detail:
          'a runtime older than the release that added HostInstall refuses the read. Deploy it, then let one session start in each repo'
      }
    ];
  }

  // Matching uses the raw values: cleaning is lossy (truncation, stripped
  // characters), so two different values could clean to the same text. The
  // cleaned form is for display only.
  const matchKey = (host, project) => `${normaliseHost(host)}/${String(project ?? '')}`;
  const shownKey = (host, project) => `${token(normaliseHost(host))}/${token(project)}`;
  const expected = new Map();
  // Roaming identities (`roaming: true`) work whichever repo they are sent
  // into on their own host, so they vouch for any repo there and nowhere
  // else. Strictly true: rows written before the field existed read null.
  const roamers = new Map();
  const hostOf = (r) => {
    const at = typeof r.kid === 'string' ? r.kid.lastIndexOf('@') : -1;
    return r.host ?? (at > 0 ? r.kid.slice(at + 1) : null);
  };
  for (const r of directoryRows) {
    if (r.active === false || r.roaming !== true || typeof r.kid !== 'string') continue;
    const host = hostOf(r);
    if (!host) continue;
    const kids = roamers.get(normaliseHost(host)) ?? new Set();
    kids.add(r.kid);
    roamers.set(normaliseHost(host), kids);
  }
  for (const r of directoryRows) {
    if (r.active === false || typeof r.project !== 'string' || r.project === '') continue;
    const host = hostOf(r);
    if (!host) continue;
    // More than one active identity can work one repo on one host (a Claude
    // Code and an OpenCode session, say), so each key holds a set of kids.
    const match = matchKey(host, r.project);
    const entry = expected.get(match) ?? { kids: new Set(), shown: shownKey(host, r.project) };
    if (typeof r.kid === 'string') entry.kids.add(r.kid);
    expected.set(match, entry);
  }

  const out = [];
  const seen = new Set();
  const fresh = [];
  for (const raw of rows) {
    const row = cleanRow(raw);
    // refreshedAt comes from the host's clock, so a host running fast would
    // read as fresh long after it died. The server-stamped updatedAt bounds
    // it: the older of the two is the one to trust.
    const serverAt = Date.parse(raw?._metadata?.updatedAt ?? '');
    const hostAt = Date.parse(raw?.refreshedAt ?? '');
    if (!Number.isNaN(serverAt) && !Number.isNaN(hostAt) && serverAt < hostAt) {
      row.refreshedAt = new Date(serverAt).toISOString();
    }
    const match = matchKey(raw?.host, raw?.project);
    // The directory says where a repo is worked, not by which harness, so
    // matching is per host and repo while each row is shown with its harness.
    const key = `${shownKey(raw?.host, raw?.project)}/${token(raw?.harness)}`;
    seen.add(match);
    const { state, ageMs } = classifyInstall(row, nowMs);
    out.push({
      id: 'hosts.install',
      state: STATE_OF[state],
      text: `${key} ${state} — last reported ${describeAge(ageMs)}: plugin ${row.pluginVersion ?? '?'}, fragment ${row.fragmentVersion ?? '?'}+${row.fragmentDigest ?? '?'} (${row.fragmentState}), ${row.harness}${checkSummary(row)}`,
      ...(INSTALL_DETAIL[state] ? { detail: INSTALL_DETAIL[state] } : {})
    });
    // A stale row's verdicts are as old as the row, which already warns.
    if (state !== 'stale') {
      for (const [field, label, remedy] of CHECKS) {
        if (row[`${field}State`] !== 'warn') continue;
        out.push({
          id: 'hosts.checks',
          state: 'warn',
          text: `${key} ${label}: \`${row[`${field}Note`] ?? 'no reason recorded'}\``,
          detail: remedy
        });
      }
    }
    // The row's own `kid` is written by the same key being checked, so it
    // cannot vouch for that key. The directory's kid for this host and repo
    // can; the row's kid is the fallback only for a row with no directory
    // entry, which is reported as an orphan below. Compared raw, shown clean.
    const writer = raw?._metadata?.updatedBy?.id ?? null;
    const rowKid = raw?.kid ?? null;
    const roaming =
      writer !== null && (roamers.get(normaliseHost(raw?.host))?.has(writer) ?? false);
    const owners = expected.get(match)?.kids ?? new Set(rowKid === null ? [] : [rowKid]);
    const ownerText = [...owners].map((k) => `\`${clean(k)}\``).join(' or ');
    if (roaming) {
      // Labelled rather than silent, so a reader can tell a guest's report
      // from the repo's own identity's.
      out.push({
        id: 'hosts.writer',
        state: 'ok',
        text: `${key} was written by \`${clean(writer)}\`, a roaming identity on that host`
      });
    } else if (writer === null) {
      out.push({
        id: 'hosts.writer',
        state: 'unknown',
        text: `${key} carries no _metadata.updatedBy, so who wrote it cannot be checked`,
        detail:
          'the server stamps updatedBy on every write, so its absence means the read did not project it or the row predates attribution'
      });
    } else if (owners.size > 0 && !owners.has(writer)) {
      out.push({
        id: 'hosts.writer',
        state: 'warn',
        text: `${key} was last written by \`${clean(writer)}\`, not by ${ownerText}, the identity that works it`,
        detail:
          "a key other than the repo's own reported this host; something may be holding a borrowed key"
      });
    }
    if (!roaming && rowKid !== null && owners.size > 0 && !owners.has(rowKid)) {
      out.push({
        id: 'hosts.writer',
        state: 'warn',
        text: `${key} names kid \`${clean(rowKid)}\`, but the directory says ${ownerText} works it`,
        detail:
          'the row or the directory is wrong about which identity works this repo on this host'
      });
    }
    // Only a row the directory vouches for, written by one of that repo's own
    // kids, takes part in the fleet comparisons below. Any key with write
    // access can create rows, and an unverified one must not be able to
    // outvote a real host into looking drifted, or hide real drift.
    const verified =
      roaming || (writer !== null && expected.has(match) && expected.get(match).kids.has(writer));
    if (state === 'fresh' && verified) {
      fresh.push({ key, row, harness: raw?.harness ?? null, env: raw?.settingsEnv ?? null });
    }
    if (!expected.has(match) && !roaming) {
      out.push({
        id: 'hosts.orphan',
        state: 'unknown',
        text: `${key} reports, but no active AgentIdentity works ${row.project} on ${row.host}`,
        detail:
          'a retired or unregistered identity is still starting sessions there, or the directory row is wrong'
      });
    }
  }

  for (const [match, { shown }] of expected) {
    if (seen.has(match)) continue;
    out.push({
      id: 'hosts.unreported',
      state: 'unknown',
      text: `${shown} never reported`,
      detail:
        'its agent has not started a session on a plugin that reports, or SYNOPTIC_HOST_REPORT=off there, or the directory names the wrong host'
    });
  }

  // Disagreement among fresh, verified rows only: a stale row is already a warning,
  // and comparing against it would blame the hosts that are current.
  out.push(...settingsDrift(fresh));

  if (fresh.length > 1) {
    const newest = fresh
      .map((f) => f.row.pluginVersion)
      .filter(Boolean)
      .sort((a, b) => compare(b, a))[0];
    const digests = new Map();
    for (const f of fresh) {
      if (f.row.fragmentState === 'source' || !f.row.fragmentDigest) continue;
      digests.set(f.row.fragmentDigest, (digests.get(f.row.fragmentDigest) ?? 0) + 1);
    }
    const commonDigest = [...digests].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    // One finding per row, naming what disagrees and only the remedy for
    // that cause: the plugin is per machine, the fragment is per repo. The
    // remedies are fixed text: row values are written by whoever holds a key,
    // and must not reach an instruction an agent will act on.
    for (const f of fresh) {
      const pluginBehind = Boolean(
        newest && f.row.pluginVersion && compare(f.row.pluginVersion, newest) < 0
      );
      const fragmentOff = Boolean(
        commonDigest &&
          f.row.fragmentState !== 'source' &&
          f.row.fragmentDigest &&
          f.row.fragmentDigest !== commonDigest
      );
      if (!pluginBehind && !fragmentOff) continue;
      const causes = [];
      const remedies = [];
      if (pluginBehind) {
        causes.push(`plugin ${f.row.pluginVersion} is behind the fleet's ${newest}`);
        remedies.push(
          'run /plugin update cortext@mnmal-ai on that host, then start a session there'
        );
      }
      if (fragmentOff) {
        causes.push(
          `fragment ${f.row.fragmentVersion ?? '?'}+${f.row.fragmentDigest} differs from the fleet's ${commonDigest}`
        );
        remedies.push('run /substrate-setup in that repo');
      }
      out.push({
        id: 'hosts.versions',
        state: 'warn',
        text: `${f.key} ${causes.join('; ')}`,
        detail: remedies.join('; ')
      });
    }
  }
  return out;
}

/** ` · pin ok · authority warn …` for the states a row carries, or ''. */
function checkSummary(row) {
  const parts = CHECKS.filter(([field]) => row[`${field}State`] !== null).map(
    ([field, label]) => `${label} ${row[`${field}State`]}`
  );
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`;
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
  const byHarness = new Map();
  for (const f of fresh) {
    if (f.env === null || typeof f.env !== 'object' || Array.isArray(f.env)) continue;
    const list = byHarness.get(f.harness) ?? [];
    list.push(f);
    byHarness.set(f.harness, list);
  }
  // Booleans record presence; a string is shown quoted, so a literal value
  // cannot pass for either.
  const show = (v) => {
    if (v === true) return '(set)';
    if (v === false || v === undefined) return '(unset)';
    return typeof v === 'string' ? `"${clean(v)}"` : null;
  };
  const out = [];
  for (const rows of byHarness.values()) {
    if (rows.length < 3) continue;
    for (const name of DRIFT_KEYS) {
      const values = rows.map((r) => ({ key: r.key, v: show(r.env[name]) }));
      if (values.some((x) => x.v === null)) continue;
      const counts = new Map();
      for (const { v } of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      const [majority, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (n * 2 <= rows.length) continue;
      for (const { key, v } of values) {
        if (v === majority) continue;
        out.push({
          id: 'hosts.settings-drift',
          state: 'warn',
          text: `${key} ${name}=${v}, where ${n} of ${rows.length} fresh records have ${majority}`,
          detail:
            "align that repo's .claude/settings.local.json with the fleet, or record why it differs"
        });
      }
    }
  }
  return out;
}
