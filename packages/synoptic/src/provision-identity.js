// provisionIdentity — Synoptic host, the IDENTITY third of agent onboarding
// (siblings: wire-mcp.js = config, cold-start-projector.js = context). Mints
// the per-agent signing identity so the agent's writes attribute to
// `<agent>@<host>` under attribute-mode auth.
//
// Unlike the two pure emitters, identity provisioning is SIDE-EFFECTFUL and
// PRIVILEGED — keygen writes a private key to disk, registration writes to the
// PROD database (admin), and a restart re-primes the live registry. So this is
// a PLANNER, not an executor: it derives the kid + key paths and emits the
// exact steps, each flagged `privileged`, for an operator (or a gated executor)
// to run. The host never silently writes prod credentials — the same posture
// that (correctly) blocks an agent self-minting tokens to the prod stack.
//
// Mirrors substrate's agent-identity runbook. Registration is idempotent-ish:
// `substrate-admin register` refuses a duplicate LIVE kid, so re-running is safe.
//
// ## Authority is emitted EXPLICITLY
//
// `substrate-admin register` takes `--ns <csv>` and `--caps <csv>`. Omitting
// `--ns` does not mean "no namespaces" — it means `*`. A wildcard issued by
// omission produces no error and no review surface: a plan that never mentions
// namespaces gives the human approving privileged steps no point at which to
// see what authority they are handing out.
//
// So both flags are always emitted, and the register step's LABEL names the
// namespaces, because the label is what an operator actually reads before
// running a privileged command.
//
// The default is derived, not guessed: a cortext agent's cold-start touches
// exactly two namespaces — the cortext namespace itself, and `recall` for
// `recall/Hit`, `recall/boost` and `recall/fetchEmbeddings`. A kid granted only
// the first degrades silently to the importance x recency ranker with a
// rejected-frames warning, losing hybrid recall. Callers needing more (a coordinator namespace, say) pass `namespaces`
// explicitly.

import { homedir, hostname } from 'node:os';
import { dirname } from 'node:path';

/** Expand a leading `~` to the absolute home dir. The key path is written into
 *  an MCP config that a NON-shell process (the substrate MCP server) reads with
 *  `readFileSync` — `~` is never expanded there, so a tilde path fails-loud on
 *  boot. Found onboarding Codex (the config carried `~/.config/substrate/keys/…`). Key
 *  paths must be absolute; the keygen shell commands tolerate absolute fine. */
function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}/${p.slice(2)}`;
  return p;
}

/**
 * @param {string} agent  short agent label, e.g. 'cursor', 'gemini', 'codex'
 * @param {{ host?: string, project?: string, keyDir?: string, runtimeEnv?: string, store?: string,
 *           namespace?: string, namespaces?: ReadonlyArray<string>, caps?: ReadonlyArray<string> }} [opts]
 * @returns {{ agent: string, host: string, kid: string, keyPath: string, pubPath: string,
 *            namespaces: ReadonlyArray<string>, caps: ReadonlyArray<string>,
 *            steps: Array<{ id: string, label: string, privileged: boolean, commands: string[] }> }}
 */
export function provisionIdentity(agent, opts = {}) {
  const host = opts.host ?? hostname();
  const keyDir = expandHome(opts.keyDir ?? `${homedir()}/.config/substrate/keys`);
  // The `.env` a `substrate init` runtime directory carries; run the plan from that directory or pass it.
  const runtimeEnv = opts.runtimeEnv ?? './.env';
  // `substrate-admin` is NOT on PATH on a real install — it's a runtime-local bin
  // (`<runtimeDir>/node_modules/.bin/substrate-admin`), so a bare name would not
  // resolve. Default to the runtime-local path (derived from runtimeEnv's dir); override via adminBin.
  const adminBin = opts.adminBin ?? `${dirname(runtimeEnv)}/node_modules/.bin/substrate-admin`;
  // Admin store URL for registration, read from the runtime env at run time so
  // the plan never carries a password. The placeholder is filled by the
  // preceding shell assignment in the same step.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell placeholder, see above
  const store = opts.store ?? '${SUBSTRATE_DATABASE_URL}';

  const kid = opts.project ? `${agent}-${opts.project}@${host}` : `${agent}@${host}`;
  const keyPath = `${keyDir}/${kid}.key`;
  const pubPath = `${keyDir}/${kid}.pub`;

  // An explicit empty list is a caller ERROR, not a request for no authority:
  // `--ns ''` is not a narrower grant, it is a malformed one, and silently
  // falling back to the default would hide it. Fail here rather than register a
  // kid whose authority nobody chose.
  const namespace = opts.namespace ?? 'cortext';
  const namespaces = opts.namespaces ?? [namespace, 'recall'];
  const caps = opts.caps ?? ['read', 'mutate'];
  for (const [name, list] of [
    ['namespaces', namespaces],
    ['caps', caps]
  ]) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(
        `provisionIdentity: '${name}' must be a non-empty array — omitting it on the ` +
          'substrate-admin command line grants `*`, so there is no safe empty value'
      );
    }
  }
  const nsCsv = namespaces.join(',');
  const capsCsv = caps.join(',');

  const steps = [
    {
      id: 'keygen',
      label: 'Generate the Ed25519 keypair (local, private key stays on this box)',
      privileged: false,
      commands: [
        `mkdir -p ${keyDir} && chmod 700 ${keyDir}`,
        `openssl genpkey -algorithm ed25519 -out ${keyPath} && chmod 600 ${keyPath}`,
        `openssl pkey -in ${keyPath} -pubout -out ${pubPath}`
      ]
    },
    {
      id: 'register',
      // The label names the grant. An operator approving a privileged step reads
      // this line, not the flags — see the authority note at the top of this file.
      label:
        `Register the PUBLIC key as a _system/Key (admin → the store), granting ` +
        `${capsCsv} on namespaces: ${nsCsv}`,
      privileged: true,
      commands: [
        `SUBSTRATE_DATABASE_URL=$(grep '^SUBSTRATE_DATABASE_URL=' ${runtimeEnv} | cut -d= -f2-)`,
        `SUBSTRATE_DATABASE_URL="${store}" ${adminBin} register "${kid}" --pubkey ${pubPath} ` +
          `--ns ${nsCsv} --caps ${capsCsv}`
      ]
    },
    {
      id: 'restart',
      label: 'Restart the substrate binary so it re-primes the key registry from the DB',
      privileged: true,
      commands: ['sudo systemctl restart substrate-binary']
    }
  ];

  return { agent, host, kid, keyPath, pubPath, namespaces, caps, steps };
}
