// Run under `bun`: the built OpenCode skin renders its cold-start against the
// substrate at SUBSTRATE_URL, through the transport it bundles. Prints one JSON
// line; exits 0 when the cold-start rendered from the server's rows.
// Usage: SUBSTRATE_URL=<url> bun test/bun-h2-smoke.mjs [dist/plugin.js]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? join(import.meta.dir, '../dist/plugin.js'));
const { CortextPlugin } = await import(dist);
const hooks = await CortextPlugin({ directory: mkdtempSync(join(tmpdir(), 'bun-h2-smoke-')) });
const output = { system: [] };
await hooks['experimental.chat.system.transform']({ sessionID: 'smoke', model: {} }, output);
const coldStart = output.system[0] ?? '';
const ok = coldStart.includes('#7 smoke task');
console.log(
  JSON.stringify({ ok, runtime: `bun ${process.versions.bun}`, blocks: output.system.length })
);
if (!ok) console.error(coldStart.slice(0, 2000));
process.exit(ok ? 0 : 1);
