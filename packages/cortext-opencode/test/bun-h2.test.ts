// The built OpenCode skin under Bun (OpenCode's runtime) against HTTP/2-only
// servers: cleartext with prior knowledge (h2c), and TLS with a private CA that
// Bun trusts through NODE_EXTRA_CA_CERTS. Skipped where bun or openssl is absent.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const has = (cmd: string, arg: string): boolean =>
  spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const ready = has('bun', '--version') && has('openssl', 'version');

/** A substrate stand-in: every query frame answers `[]`, Task answers one row. */
function answer(server: http2.Http2Server | http2.Http2SecureServer, seen: string[]) {
  server.on('stream', (stream, headers) => {
    let raw = '';
    stream.on('data', (c: Buffer) => {
      raw += c;
    });
    stream.on('end', () => {
      seen.push(`${headers[':method']} ${headers[':path']}`);
      const data: Record<string, unknown> = {};
      try {
        for (const k of Object.keys(JSON.parse(raw || '{}')))
          data[k] = k === 'cortext/Task' ? [{ id: 't-uuid', shortId: 7, title: 'smoke task' }] : [];
      } catch {
        /* a GET: empty data */
      }
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ data }));
    });
  });
}

async function listen(server: http2.Http2Server | http2.Http2SecureServer): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

/** Async on purpose: the stub servers share this process's event loop. */
function runBun(
  url: string,
  ca?: string
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    SUBSTRATE_URL: url,
    SUBSTRATE_NAMESPACE: 'cortext'
  };
  if (ca) env.NODE_EXTRA_CA_CERTS = ca;
  return new Promise((resolve) => {
    const child = spawn('bun', [join(HERE, 'bun-h2-smoke.mjs')], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

describe.skipIf(!ready)('the built OpenCode skin under Bun over HTTP/2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cortext-bun-h2-'));
  const servers: Array<http2.Http2Server | http2.Http2SecureServer> = [];
  afterAll(() => {
    for (const s of servers) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders its cold-start from an h2c server', async () => {
    const seen: string[] = [];
    const server = http2.createServer();
    servers.push(server);
    answer(server, seen);
    const port = await listen(server);
    const r = await runBun(`http://127.0.0.1:${port}`);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}')).toMatchObject({ ok: true });
    expect(seen).toContain('POST /substrate/v1/query');
  }, 40000);

  it('renders its cold-start over TLS with a private CA', async () => {
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1'
      ],
      { stdio: 'ignore' }
    );
    const seen: string[] = [];
    const server = http2.createSecureServer({
      cert: readFileSync(cert),
      key: readFileSync(key),
      allowHTTP1: false
    });
    servers.push(server);
    answer(server, seen);
    const port = await listen(server);
    const r = await runBun(`https://127.0.0.1:${port}`, cert);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}')).toMatchObject({ ok: true });
    expect(seen).toContain('POST /substrate/v1/query');
  }, 40000);
});
