// Agent-identity signing for the cold-start hook. JS port of substrate's apps/substrate/src/mcp/agent-jwt.ts — same env vars
// (SUBSTRATE_AGENT_KEY_PATH = path to an Ed25519 private PEM, SUBSTRATE_AGENT_KEY_ID =
// registry key id), same claim shape the stack's verifier requires (EdDSA
// header with kid; payload with sub, iat, exp, an EXPLICIT ns claim — a
// verify-time invariant for Ed25519 tokens — and capabilities).
//
// One deliberate divergence from the MCP version: the MCP server FAILS LOUD
// (throws at construction) on a configured-but-broken key, because it is
// long-lived and silent anonymous WRITES are the threat. These hooks only
// READ and must never block a session — so a broken key yields a VISIBLE
// warning plus anonymous fallback. Under a read-gated deployment the anonymous
// reads then fail visibly anyway.
//
// THE CLAIM IS AN OPT-IN, not a constant. `SUBSTRATE_AGENT_CAPABILITIES` /
// `SYNOPTIC_AGENT_NAMESPACES` override the defaults, or `opts` for a programmatic
// caller. Env-driven because a hook receives env and nothing else — the OpenCode
// V2 skin is the exception: it passes `opts.kid` / `opts.key` from plugin config
// (`ctx.options`), because a per-project identity cannot live in a shared
// process env, and opts win over env. The defaults
// are unchanged and right for every cold-start identity in the fleet; the
// override exists for the identity they are wrong for — see DEFAULT_CAPABILITIES
// for why a too-NARROW claim is the dangerous direction.
//
// `warning` is RETURNED rather than written, because the right channel differs
// per caller and only the caller knows it: the cold-start prepends it
// to its injected context, the inbox hooks send it to stderr (their stdout is a
// parsed JSON decision / per-turn injected context), and the audit threads it
// into `auditAuthority` so a broken key file is diagnosed as a broken key file
// rather than as absent wiring. What is NOT acceptable is dropping it.

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TTL_SECONDS = 3600; // 1h token; refreshed when within 60s of expiry.
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
const DEFAULT_CAPABILITIES = ['read', 'mutate'];
const DEFAULT_NAMESPACES = ['*'];

/**
 * Parse a comma-separated env override into a claim list.
 * Returns `null` for unset/blank, so an empty string cannot silently mint a
 * zero-capability token — which is the exact failure this whole area is about.
 */
function claimList(raw) {
  if (typeof raw !== 'string') return null;
  const items = raw
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');
  return items.length === 0 ? null : items;
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mint(kid, key, ns, capabilities) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TTL_SECONDS;
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }), 'utf8'));
  const payload = b64url(
    Buffer.from(JSON.stringify({ sub: kid, iat: now, exp, ns, capabilities }), 'utf8')
  );
  const signingInput = `${header}.${payload}`;
  const sig = cryptoSign(null, Buffer.from(signingInput, 'utf8'), key);
  return { jwt: `${signingInput}.${b64url(sig)}`, exp };
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
export function createAgentAuth(env, opts) {
  const hasOptionsSeam = opts !== undefined;
  opts ??= {};
  // All or nothing: an options identity never borrows the other half
  // from env. Mixing paired one identity's kid with another's key, so every
  // token failed verification and the cold-start read as "unreachable". The
  // Codex skin refuses the same mix.
  const optionsIdentity =
    (opts.kid !== undefined && opts.kid !== null && opts.kid !== '') ||
    (opts.key !== undefined && opts.key !== null && opts.key !== '');
  const keyPath = optionsIdentity ? opts.key : env.SUBSTRATE_AGENT_KEY_PATH;
  const kid = optionsIdentity ? opts.kid : env.SUBSTRATE_AGENT_KEY_ID;
  const hasKey = typeof keyPath === 'string' && keyPath !== '';
  const hasKid = typeof kid === 'string' && kid !== '';
  if (!hasKey && !hasKid) return { getAuthHeader: () => null, warning: null, claim: null };
  if (!hasKey || !hasKid) {
    const [envName, optionName] = hasKey
      ? ['SUBSTRATE_AGENT_KEY_ID', 'options.kid']
      : ['SUBSTRATE_AGENT_KEY_PATH', 'options.key'];
    const missing = hasOptionsSeam ? `${envName} / ${optionName}` : envName;
    return misconfigured(`${missing} is not set`);
  }
  let key;
  try {
    key = createPrivateKey(readFileSync(keyPath, 'utf8'));
  } catch (err) {
    return misconfigured(`cannot load ${keyPath}: ${String(err?.message ?? err)}`);
  }
  // Tokens are always signed `alg: EdDSA`. An RSA or EC key loads fine and
  // then 401s every request, which the cold-start can only report as
  // "substrate offline". Say what is actually wrong instead.
  if (key.asymmetricKeyType !== 'ed25519') {
    return misconfigured(
      `${keyPath} is a ${key.asymmetricKeyType ?? 'non-asymmetric'} key; agent tokens are EdDSA and need an ed25519 key`
    );
  }

  // The claim is an OPT-IN, matching the substrate policy package's
  // `TokenProviderOpts` `capabilities` / `namespaces`.
  //
  // Nothing here imports it either way — this module is a standalone signer,
  // and the only imports in this file are `node:crypto` and `node:fs`. So the
  // "match" is one of INTENT, not of type: no build reads it, and the two
  // shapes are free to move apart without anything failing. Worth saying,
  // because the two side by side look like drift and are not.
  //
  // Env-driven because a hook receives env and nothing else — the V2 skin's
  // opts override carries kid/key identity only, not the claim.
  const capabilities =
    opts.capabilities ?? claimList(env.SUBSTRATE_AGENT_CAPABILITIES) ?? DEFAULT_CAPABILITIES;
  const ns = opts.namespaces ?? claimList(env.SYNOPTIC_AGENT_NAMESPACES) ?? DEFAULT_NAMESPACES;

  // `['*']` IS NOT A WILDCARD FOR CAPABILITIES, and it fails silently.
  // `intersectList` returns the row verbatim against a wildcard,
  // which is exactly how the `ns: ['*']` claim correctly inherits a narrowed
  // grant — so the symmetry is very inviting. It does not hold, because the two
  // gates that consume capabilities do a bare membership test with no wildcard
  // branch (`compose.ts withAuth: if (!have.includes(required))`,
  // `primitives.ts requireCapability: caps.includes(name)`). A `'*'` claim
  // against a `'*'` row resolves to the literal `['*']` and is refused
  // EVERYTHING — the zero-capability state, arrived at by the one edit most
  // likely to be made in an attempt to avoid it.
  //
  // Refused loudly rather than silently corrected: someone who wrote it wants
  // wider access, and quietly substituting the defaults would give them a
  // working token that is not the one they asked for.
  if (capabilities.includes('*')) {
    return misconfigured(
      "capabilities cannot be claimed as '*' — the capability gates do a bare `includes` with no " +
        'wildcard branch, so a wildcard claim is refused everything. ' +
        `Enumerate them instead, e.g. SUBSTRATE_AGENT_CAPABILITIES=${DEFAULT_CAPABILITIES.join(',')}`
    );
  }

  let cached = null;
  return {
    getAuthHeader: () => {
      const now = Math.floor(Date.now() / 1000);
      if (cached === null || cached.exp - REFRESH_SKEW <= now) {
        cached = mint(kid, key, ns, capabilities);
      }
      return `Bearer ${cached.jwt}`;
    },
    warning: null,
    /** What this identity CLAIMS — the request, never the grant. See `probeWhoami` for the grant. */
    claim: { ns, capabilities }
  };
}

/**
 * Wrap a fetch implementation so every request carries the agent JWT when one
 * is available. The single seam for the whole hook — every HTTP helper takes
 * an injectable fetchImpl, so signing needs no per-call-site changes.
 */
export function makeSignedFetch(getAuthHeader, fetchImpl = fetch) {
  return (url, init = {}) => {
    const header = getAuthHeader();
    if (header === null) return fetchImpl(url, init);
    return fetchImpl(url, { ...init, headers: { ...init.headers, authorization: header } });
  };
}
