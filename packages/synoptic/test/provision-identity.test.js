import { describe, expect, it } from 'vitest';
import { provisionIdentity } from '../src/provision-identity.js';

const OPTS = { host: 'Desk', keyDir: '/home/user/.config/substrate/keys' };

describe('provisionIdentity', () => {
  it('derives `<agent>@<host>` kid and key paths under the key dir', () => {
    const p = provisionIdentity('cursor', OPTS);
    expect(p.kid).toBe('cursor@Desk');
    expect(p.keyPath).toBe('/home/user/.config/substrate/keys/cursor@Desk.key');
    expect(p.pubPath).toBe('/home/user/.config/substrate/keys/cursor@Desk.pub');
  });

  it('scopes the kid per-project when a project is given', () => {
    expect(provisionIdentity('cursor', { ...OPTS, project: 'tools' }).kid).toBe(
      'cursor-tools@Desk'
    );
  });

  it('emits three steps: keygen (safe) then register + restart (privileged)', () => {
    const { steps } = provisionIdentity('cursor', OPTS);
    expect(steps.map((s) => s.id)).toEqual(['keygen', 'register', 'restart']);
    expect(steps.find((s) => s.id === 'keygen').privileged).toBe(false);
    expect(steps.find((s) => s.id === 'register').privileged).toBe(true);
    expect(steps.find((s) => s.id === 'restart').privileged).toBe(true);
  });

  it('keygen generates an ed25519 keypair at the derived paths', () => {
    const keygen = provisionIdentity('cursor', OPTS).steps[0];
    const joined = keygen.commands.join('\n');
    expect(joined).toMatch(
      /genpkey -algorithm ed25519 -out \/home\/user\/\.config\/substrate\/keys\/cursor@Desk\.key/
    );
    expect(joined).toMatch(
      /-pubout -out \/home\/user\/\.config\/substrate\/keys\/cursor@Desk\.pub/
    );
    expect(joined).toMatch(/chmod 600/);
  });

  // ---- authority is emitted, never defaulted ----
  //
  // Omitting `--ns` does not mean "no namespaces", it means `*`. The assertions
  // below are on the flags being PRESENT — an absence here is a silent wildcard grant, which
  // is the one failure mode that produces no error anywhere.

  it('register always emits --ns and --caps, never relying on the default', () => {
    const reg = provisionIdentity('cursor', OPTS).steps[1].commands.join('\n');
    expect(reg).toMatch(/--ns cortext,recall/);
    expect(reg).toMatch(/--caps read,mutate/);
  });

  it('the register LABEL names the grant, since that is what an operator reads', () => {
    const step = provisionIdentity('cursor', OPTS).steps[1];
    expect(step.label).toMatch(/granting read,mutate on namespaces: cortext,recall/);
  });

  it('the default namespace set includes `recall` — the cold-start queries it', () => {
    // recall/Hit, recall/boost and recall/fetchEmbeddings. A kid without this
    // does not fail loudly; it silently renders Agent Memory through the
    // importance x recency fallback.
    expect(provisionIdentity('cursor', OPTS).namespaces).toEqual(['cortext', 'recall']);
  });

  it('an explicit namespace set overrides the default, and is reported back', () => {
    const p = provisionIdentity('cursor', { ...OPTS, namespaces: ['app', 'recall', 'plane'] });
    expect(p.namespaces).toEqual(['app', 'recall', 'plane']);
    expect(p.steps[1].commands.join('\n')).toMatch(/--ns app,recall,plane/);
    expect(p.steps[1].label).toMatch(/namespaces: app,recall,plane/);
  });

  it('a non-default coordination namespace still carries recall alongside it', () => {
    expect(provisionIdentity('cursor', { ...OPTS, namespace: 'othertext' }).namespaces).toEqual([
      'othertext',
      'recall'
    ]);
  });

  it('an EMPTY namespaces or caps list throws — there is no safe empty value', () => {
    // `--ns ''` is a malformed grant, not a narrow one, and falling back to the
    // default would hide the caller's mistake behind a working command.
    for (const bad of [[], 'cortext', 0]) {
      expect(() => provisionIdentity('cursor', { ...OPTS, namespaces: bad })).toThrow(
        /non-empty array/
      );
      expect(() => provisionIdentity('cursor', { ...OPTS, caps: bad })).toThrow(/non-empty array/);
    }
  });

  it('null and undefined both mean "use the default" — `??`, as elsewhere in this file', () => {
    // Asserted rather than assumed: `??` treats null as nullish, so an explicit
    // null falls back exactly like an omitted key. That is the file's existing
    // idiom (`opts.host ?? hostname()`); the point of pinning it is that the
    // fallback here hands out AUTHORITY, so which inputs reach it should be
    // written down rather than inferred from an operator.
    for (const nullish of [null, undefined]) {
      expect(provisionIdentity('cursor', { ...OPTS, namespaces: nullish }).namespaces).toEqual([
        'cortext',
        'recall'
      ]);
      expect(provisionIdentity('cursor', { ...OPTS, caps: nullish }).caps).toEqual([
        'read',
        'mutate'
      ]);
    }
  });

  it('register runs substrate-admin against the runtime store with the kid + pubkey', () => {
    const reg = provisionIdentity('cursor', OPTS).steps[1].commands.join('\n');
    expect(reg).toMatch(
      /substrate-admin register "cursor@Desk" --pubkey \/home\/user\/\.config\/substrate\/keys\/cursor@Desk\.pub/
    );
    expect(reg).toMatch(/grep '\^SUBSTRATE_DATABASE_URL=' \.\/\.env/);
  });

  it('resolves substrate-admin to the runtime-local bin, not a bare PATH lookup', () => {
    // `substrate-admin` is not on PATH — it's a runtime-local
    // bin. Default derives from runtimeEnv's dir; overridable via adminBin.
    const reg = provisionIdentity('cursor', OPTS).steps[1].commands.join('\n');
    expect(reg).toMatch(/\.\/node_modules\/\.bin\/substrate-admin register/);
    const custom = provisionIdentity('cursor', {
      ...OPTS,
      adminBin: '/opt/substrate-admin'
    }).steps[1].commands.join('\n');
    expect(custom).toMatch(/\/opt\/substrate-admin register "cursor@Desk"/);
  });

  it('restart re-primes the registry via systemd', () => {
    expect(provisionIdentity('cursor', OPTS).steps[2].commands.join('\n')).toMatch(
      /systemctl restart substrate-binary/
    );
  });

  it('defaults to an ABSOLUTE ~/.config/substrate/keys path (never a literal ~)', () => {
    // A literal ~ in SUBSTRATE_AGENT_KEY_PATH breaks: the substrate MCP server reads
    // the key with readFileSync, which does not expand ~.
    const { keyPath } = provisionIdentity('gemini', { host: 'Desk' });
    expect(keyPath).not.toContain('~');
    expect(keyPath).toMatch(/^\/.+\/\.config\/substrate\/keys\/gemini@Desk\.key$/);
  });

  it('expands a leading ~ in an explicit keyDir', () => {
    const { keyPath } = provisionIdentity('gemini', { host: 'Desk', keyDir: '~/keys' });
    expect(keyPath).not.toContain('~');
    expect(keyPath).toMatch(/\/keys\/gemini@Desk\.key$/);
  });
});
