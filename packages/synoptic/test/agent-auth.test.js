// Agent-identity signing for the cold-start hook. When SUBSTRATE_AGENT_KEY_PATH + SUBSTRATE_AGENT_KEY_ID are configured the
// hook's HTTP reads carry the same Ed25519 agent JWT the MCP server mints —
// so a deployment that flips its read posture to identity-gated keeps its
// cold-start. Anonymous fallback when unconfigured; VISIBLE warning (never a
// crash, never silence) when misconfigured — a hook must not block the
// session, but a configured-and-broken key must not silently degrade either.

import { verify as cryptoVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentAuth, makeSignedFetch } from '../src/agent-auth.js';

function makeKeyFiles() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'synoptic-auth-'));
  const keyPath = join(dir, 'agent.key');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { keyPath, publicKey };
}

function decodeJwt(bearer) {
  const jwt = bearer.replace(/^Bearer /, '');
  const [h, p, s] = jwt.split('.');
  const fromB64url = (x) => Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return {
    header: JSON.parse(fromB64url(h).toString('utf8')),
    payload: JSON.parse(fromB64url(p).toString('utf8')),
    signingInput: `${h}.${p}`,
    signature: fromB64url(s)
  };
}

describe('createAgentAuth', () => {
  it('unconfigured → anonymous: null header, no warning', () => {
    const auth = createAgentAuth({});
    expect(auth.getAuthHeader()).toBeNull();
    expect(auth.warning).toBeNull();
  });

  it('configured → mints a verifiable EdDSA JWT with the substrate claim shape', () => {
    const { keyPath, publicKey } = makeKeyFiles();
    const auth = createAgentAuth({
      SUBSTRATE_AGENT_KEY_PATH: keyPath,
      SUBSTRATE_AGENT_KEY_ID: 'claude-code@testhost'
    });
    expect(auth.warning).toBeNull();

    const bearer = auth.getAuthHeader();
    expect(bearer).toMatch(/^Bearer /);
    const { header, payload, signingInput, signature } = decodeJwt(bearer);
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'claude-code@testhost' });
    expect(payload.sub).toBe('claude-code@testhost');
    expect(payload.ns).toEqual(['*']);
    expect(payload.capabilities).toEqual(['read', 'mutate']);
    expect(payload.exp).toBeGreaterThan(payload.iat);
    expect(cryptoVerify(null, Buffer.from(signingInput, 'utf8'), publicKey, signature)).toBe(true);
  });

  it('caches the token across calls within the TTL', () => {
    const { keyPath } = makeKeyFiles();
    const auth = createAgentAuth({
      SUBSTRATE_AGENT_KEY_PATH: keyPath,
      SUBSTRATE_AGENT_KEY_ID: 'kid-1'
    });
    expect(auth.getAuthHeader()).toBe(auth.getAuthHeader());
  });

  it('missing key file → null header + visible warning, never throws', () => {
    const auth = createAgentAuth({
      SUBSTRATE_AGENT_KEY_PATH: '/nonexistent/agent.key',
      SUBSTRATE_AGENT_KEY_ID: 'kid-1'
    });
    expect(auth.getAuthHeader()).toBeNull();
    expect(auth.warning).toContain('agent identity misconfigured');
    expect(auth.warning).toContain('anonymous');
  });

  it('malformed PEM → null header + visible warning, never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synoptic-auth-'));
    const keyPath = join(dir, 'bad.key');
    writeFileSync(keyPath, 'not a pem at all');
    const auth = createAgentAuth({
      SUBSTRATE_AGENT_KEY_PATH: keyPath,
      SUBSTRATE_AGENT_KEY_ID: 'kid-1'
    });
    expect(auth.getAuthHeader()).toBeNull();
    expect(auth.warning).toContain('agent identity misconfigured');
  });

  it('partial config (key without kid, kid without key) → warning, not silence', () => {
    const { keyPath } = makeKeyFiles();
    const keyOnly = createAgentAuth({ SUBSTRATE_AGENT_KEY_PATH: keyPath });
    expect(keyOnly.getAuthHeader()).toBeNull();
    expect(keyOnly.warning).toContain('agent identity misconfigured');

    const kidOnly = createAgentAuth({ SUBSTRATE_AGENT_KEY_ID: 'kid-1' });
    expect(kidOnly.getAuthHeader()).toBeNull();
    expect(kidOnly.warning).toContain('agent identity misconfigured');
  });

  // A Claude hook is a spawned process with env and nothing else, so a
  // warning naming `options.kid` points at a setting that caller cannot reach.
  it('names only the env spelling when the caller passed no options', () => {
    const { keyPath } = makeKeyFiles();
    const keyOnly = createAgentAuth({ SUBSTRATE_AGENT_KEY_PATH: keyPath });
    expect(keyOnly.warning).toContain('SUBSTRATE_AGENT_KEY_ID is not set');
    expect(keyOnly.warning).not.toContain('options.');

    const kidOnly = createAgentAuth({ SUBSTRATE_AGENT_KEY_ID: 'kid-1' });
    expect(kidOnly.warning).toContain('SUBSTRATE_AGENT_KEY_PATH is not set');
    expect(kidOnly.warning).not.toContain('options.');
  });

  it('names both spellings when the caller has an options seam, even an empty one', () => {
    const { keyPath } = makeKeyFiles();
    const keyOnly = createAgentAuth({ SUBSTRATE_AGENT_KEY_PATH: keyPath }, {});
    expect(keyOnly.warning).toContain('SUBSTRATE_AGENT_KEY_ID / options.kid is not set');

    const kidOnly = createAgentAuth({}, { kid: 'kid-1' });
    expect(kidOnly.warning).toContain('SUBSTRATE_AGENT_KEY_PATH / options.key is not set');
  });
});

// ---- OpenCode V2 skin: identity via plugin options ----
//
// A per-project identity cannot live in a shared process env, so the V2
// plugin config (`ctx.options`) carries kid/key and createAgentAuth takes
// them as opts overrides. Same tri-state: opts-only mints, opts beat env,
// partial stays anonymous + visible warning.

describe('createAgentAuth identity override (plugin options)', () => {
  it('opts kid/key alone mint a token — no env pair needed', () => {
    const { keyPath, publicKey } = makeKeyFiles();
    const auth = createAgentAuth({}, { kid: 'plugin@host', key: keyPath });
    expect(auth.warning).toBeNull();

    const bearer = auth.getAuthHeader();
    expect(bearer).toMatch(/^Bearer /);
    const { header, payload, signingInput, signature } = decodeJwt(bearer);
    expect(header.kid).toBe('plugin@host');
    expect(payload.sub).toBe('plugin@host');
    expect(cryptoVerify(null, Buffer.from(signingInput, 'utf8'), publicKey, signature)).toBe(true);
  });

  // Options are all-or-nothing, so an options kid never signs with the ENV
  // key; the full-pair case lives in the block below.

  it('partial opts (kid without any key) → warning, not silence', () => {
    const auth = createAgentAuth({}, { kid: 'kid-only' });
    expect(auth.getAuthHeader()).toBeNull();
    expect(auth.warning).toContain('agent identity misconfigured');
  });
});

describe('makeSignedFetch', () => {
  it('adds the authorization header and preserves init', async () => {
    let seen;
    const inner = (url, init) => {
      seen = { url, init };
      return Promise.resolve({ ok: true });
    };
    const fetchImpl = makeSignedFetch(() => 'Bearer tok-123', inner);
    await fetchImpl('https://h:3100/substrate/v1/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}'
    });
    expect(seen.url).toBe('https://h:3100/substrate/v1/query');
    expect(seen.init.method).toBe('POST');
    expect(seen.init.body).toBe('{"a":1}');
    expect(seen.init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer tok-123'
    });
  });

  it('passes through untouched when the header provider yields null', async () => {
    let seen;
    const inner = (url, init) => {
      seen = { url, init };
      return Promise.resolve({ ok: true });
    };
    const fetchImpl = makeSignedFetch(() => null, inner);
    await fetchImpl('https://h:3100/substrate/v1/recall', {
      headers: { 'content-type': 'application/json' }
    });
    expect(seen.init.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('works for header-less GET requests (embed-stats probe)', async () => {
    let seen;
    const inner = (url, init) => {
      seen = { url, init };
      return Promise.resolve({ ok: true });
    };
    const fetchImpl = makeSignedFetch(() => 'Bearer tok-123', inner);
    await fetchImpl('https://h:3100/substrate/v1/embed-stats', { signal: undefined });
    expect(seen.init.headers).toEqual({ authorization: 'Bearer tok-123' });
  });
});

// ---- the claim is an OPT-IN, not a constant ----
//
// substrate intersects the claim against the kid's _system/Key row, so the row is the
// authority and a token can never widen itself. The hazard runs the other way:
// a claim that OMITS what the row grants intersects it AWAY, and an identity
// registered `admin` against a fixed ['read','mutate'] claim mints a token
// carrying NOTHING. substrate-policy's `TokenProviderOpts` makes it an opt-in.

describe('createAgentAuth claim override', () => {
  const claimOf = (bearer) => decodeJwt(bearer).payload;

  it('defaults are unchanged — read+mutate over every namespace', () => {
    const { keyPath } = makeKeyFiles();
    const c = claimOf(
      createAgentAuth({
        SUBSTRATE_AGENT_KEY_PATH: keyPath,
        SUBSTRATE_AGENT_KEY_ID: 'k@h'
      }).getAuthHeader()
    );
    expect(c.capabilities).toEqual(['read', 'mutate']);
    expect(c.ns).toEqual(['*']);
  });

  it('env overrides both lists — the admin case', () => {
    const { keyPath } = makeKeyFiles();
    const c = claimOf(
      createAgentAuth({
        SUBSTRATE_AGENT_KEY_PATH: keyPath,
        SUBSTRATE_AGENT_KEY_ID: 'k@h',
        SUBSTRATE_AGENT_CAPABILITIES: 'read, mutate ,admin',
        SYNOPTIC_AGENT_NAMESPACES: 'cortext,recall'
      }).getAuthHeader()
    );
    // Whitespace tolerated: an operator-typed env var will have it.
    expect(c.capabilities).toEqual(['read', 'mutate', 'admin']);
    expect(c.ns).toEqual(['cortext', 'recall']);
  });

  it('opts beat env, for a programmatic caller with no env to set', () => {
    const { keyPath } = makeKeyFiles();
    const c = claimOf(
      createAgentAuth(
        {
          SUBSTRATE_AGENT_KEY_PATH: keyPath,
          SUBSTRATE_AGENT_KEY_ID: 'k@h',
          SUBSTRATE_AGENT_CAPABILITIES: 'admin'
        },
        { capabilities: ['read'] }
      ).getAuthHeader()
    );
    expect(c.capabilities).toEqual(['read']);
  });

  it('refuses `*` for capabilities — it is NOT a wildcard and fails silently', () => {
    // `intersectList` returns the row verbatim against a wildcard,
    // which is how the `ns: ['*']` claim correctly inherits a narrowed grant —
    // so the symmetry is very inviting. It does not hold: both capability gates
    // do a bare `includes` with no wildcard branch, so a `'*'` claim resolves to
    // the literal `['*']` and is refused EVERYTHING. That is the zero-capability
    // state, reached by the one edit most likely to be made to avoid it.
    const { keyPath } = makeKeyFiles();
    const auth = createAgentAuth({
      SUBSTRATE_AGENT_KEY_PATH: keyPath,
      SUBSTRATE_AGENT_KEY_ID: 'k@h',
      SUBSTRATE_AGENT_CAPABILITIES: '*'
    });
    // Refused LOUDLY, not silently corrected: someone who wrote this wants wider
    // access, and quietly substituting the defaults hands them a working token
    // that is not the one they asked for.
    expect(auth.getAuthHeader()).toBeNull();
    expect(auth.warning).toContain("cannot be claimed as '*'");
    expect(auth.warning).toContain('refused everything');
  });

  it('a blank or comma-only override falls back rather than minting an EMPTY claim', () => {
    // The failure mode this whole area exists to prevent: an empty capability
    // list verifies, attributes correctly, and can do nothing. An env var that
    // is set-but-empty must never be the way there.
    const { keyPath } = makeKeyFiles();
    for (const raw of ['', '   ', ' , , ']) {
      const c = claimOf(
        createAgentAuth({
          SUBSTRATE_AGENT_KEY_PATH: keyPath,
          SUBSTRATE_AGENT_KEY_ID: 'k@h',
          SUBSTRATE_AGENT_CAPABILITIES: raw
        }).getAuthHeader()
      );
      expect(c.capabilities).toEqual(['read', 'mutate']);
    }
  });

  it('exposes the claim for diagnostics, and it is the REQUEST not the grant', () => {
    // The audit must never render this as authority — `probeWhoami` is the only
    // thing that answers what the credential actually holds, post-intersection.
    const { keyPath } = makeKeyFiles();
    const auth = createAgentAuth({
      SUBSTRATE_AGENT_KEY_PATH: keyPath,
      SUBSTRATE_AGENT_KEY_ID: 'k@h'
    });
    expect(auth.claim).toEqual({ ns: ['*'], capabilities: ['read', 'mutate'] });
    expect(createAgentAuth({}).claim).toBeNull();
  });
});

describe('options identity is all or nothing', () => {
  it('an options kid never borrows the env signing key', () => {
    const { keyPath } = makeKeyFiles();
    const auth = createAgentAuth(
      { SUBSTRATE_AGENT_KEY_ID: 'env@h', SUBSTRATE_AGENT_KEY_PATH: keyPath },
      { kid: 'options@h' }
    );
    expect(auth.getAuthHeader()).toBeNull();
    expect(auth.warning).toContain('options.key');
  });

  it('a full options pair signs as the options kid', () => {
    const { keyPath } = makeKeyFiles();
    const auth = createAgentAuth(
      { SUBSTRATE_AGENT_KEY_ID: 'env@h' },
      { kid: 'options@h', key: keyPath }
    );
    expect(decodeJwt(auth.getAuthHeader()).header.kid).toBe('options@h');
  });

  it('empty or null options fall back to the env pair', () => {
    const { keyPath } = makeKeyFiles();
    for (const opts of [{}, { kid: null, key: null }, { kid: '', key: '' }]) {
      const auth = createAgentAuth(
        { SUBSTRATE_AGENT_KEY_ID: 'env@h', SUBSTRATE_AGENT_KEY_PATH: keyPath },
        opts
      );
      expect(decodeJwt(auth.getAuthHeader()).header.kid).toBe('env@h');
    }
  });
});

describe('key type', () => {
  it('an RSA key is reported as the wrong type, not left to 401', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const dir = mkdtempSync(join(tmpdir(), 'synoptic-auth-rsa-'));
    const keyPath = join(dir, 'agent.key');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const auth = createAgentAuth({
      SUBSTRATE_AGENT_KEY_ID: 'a@h',
      SUBSTRATE_AGENT_KEY_PATH: keyPath
    });
    expect(auth.getAuthHeader()).toBeNull();
    expect(auth.warning).toContain('is a rsa key');
  });
});
