#!/usr/bin/env node
// Infer `resolution` for every closed Todo and write the values file
// `substrate backfill-field` takes. Reads only; writes nothing to the store.
//
//   node scripts/todo-resolution-values.mjs <out.json> [substrateUrl] [namespace]
//
// Then, as an admin, dry run first:
//   substrate backfill-field cortext Todo resolution --values out.json
//   substrate backfill-field cortext Todo resolution --values out.json --apply
//   substrate normalise-vocab cortext Todo status --apply
//
// ORDER MATTERS: backfill resolution BEFORE normalising status. While a row
// still reads `done` / `closed`, the inference can tell them apart; and a
// read-modify-write of a `done` row after the deploy fills `resolution:
// completed` by implication, which would beat a better inferred value.
//
// Signed with the caller's own SUBSTRATE_AGENT_KEY_ID / SUBSTRATE_AGENT_KEY_PATH.

import { writeFileSync } from 'node:fs';
import { inferTodoResolution } from '../packages/cortext/dist/index.js';
import { createAgentAuth, makeSignedFetch } from '../packages/synoptic/src/agent-auth.js';

const [out, url = process.env.SUBSTRATE_URL, ns = 'cortext'] = process.argv.slice(2);
if (out === undefined || !url) {
  console.error(
    'usage: node scripts/todo-resolution-values.mjs <out.json> [substrateUrl] [namespace]'
  );
  process.exit(2);
}
const auth = createAgentAuth(process.env);
if (auth.warning) console.error(auth.warning.trim());
const signed = makeSignedFetch(auth.getAuthHeader);
const key = `${ns}/Todo`;

const rows = [];
let cursor;
for (;;) {
  const res = await signed(`${url.replace(/\/+$/, '')}/substrate/v1/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      [key]: {
        params: {
          where: { status: { in: ['done', 'closed'] } },
          limit: 500,
          ...(cursor ? { cursor } : {})
        },
        fields: { id: true, status: true, title: true, notes: true, body: true }
      }
    })
  });
  const body = await res.json();
  if (body.errors?.length || body.data?.[key] === undefined) {
    console.error(JSON.stringify(body.errors ?? body));
    process.exit(1);
  }
  rows.push(...body.data[key]);
  const page = body._pagination?.[key];
  if (!page?.hasMore) break;
  cursor = page.nextCursor;
}

const values = {};
const counts = {};
for (const r of rows) {
  const v = inferTodoResolution(r);
  values[r.id] = v;
  counts[`${r.status} -> ${v}`] = (counts[`${r.status} -> ${v}`] ?? 0) + 1;
}
writeFileSync(out, `${JSON.stringify(values, null, 2)}\n`);
console.log(`${rows.length} closed Todos -> ${out}`);
for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
  console.log(`  ${k.padEnd(28)} ${n}`);
