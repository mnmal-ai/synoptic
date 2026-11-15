// A real substrate server for transport tests: the `substrate serve` binary
// from the devDependency, on the memory store, speaking cleartext HTTP/2 (h2c)
// on loopback, with this workspace's built cortext plugin loaded. Pass `keys`
// ([{ kid, publicKey }], Ed25519 SPKI PEM) to turn auth on in `attribute` mode:
// signed requests carry their kid, unsigned ones still read.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { substrateFetch } from '@mnmal-ai/substrate/client';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORTEXT = resolve(HERE, '../../../cortext');
const BINARY = join(
  dirname(fileURLToPath(import.meta.resolve('@mnmal-ai/substrate/client'))),
  'substrate.js'
);

// The binary refuses PORT=0, so reserve a free port and hand it over.
function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** @returns {Promise<{ url: string, stop: () => Promise<void>, log: () => string }>} */
export async function startSubstrate({ readyMs = 20000, keys = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'synoptic-h2-'));
  mkdirSync(join(dir, 'node_modules', '@mnmal-ai'), { recursive: true });
  symlinkSync(CORTEXT, join(dir, 'node_modules', '@mnmal-ai', 'cortext'), 'dir');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ private: true, dependencies: { '@mnmal-ai/cortext': '*' } })
  );

  const auth = {};
  if (keys.length > 0) {
    const registry = join(dir, 'keys.json');
    writeFileSync(
      registry,
      JSON.stringify(
        keys.map((k) => ({ alg: 'EdDSA', kind: 'agent', kid: k.kid, publicKey: k.publicKey }))
      )
    );
    auth.SUBSTRATE_AUTH_KEY_REGISTRY = registry;
    auth.SUBSTRATE_AUTH_MODE = 'attribute';
  }

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [BINARY, 'serve'], {
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: String(port),
      SUBSTRATE_SYSTEM_ACTOR: 'transport-test',
      SUBSTRATE_PLUGIN_DIR: dir,
      ...auth
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (output += b));
  const exited = new Promise((ok) => child.once('exit', ok));

  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  };

  const deadline = Date.now() + readyMs;
  for (;;) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`substrate serve exited (${child.exitCode}) before it was ready:\n${output}`);
    }
    try {
      const res = await substrateFetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`substrate serve was not ready within ${readyMs} ms:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { url, stop, log: () => output };
}
