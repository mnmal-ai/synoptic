/**
 * Schema parity test — locks `config.schema.json` against the canonical
 * `z.toJSONSchema(Schema, { io: 'input' })` output so the committed JSON (consumed by
 * `package.json#substrate` for ops-surface declaration, IDE intellisense for
 * operator-edited `<plugin>.config.json`, and any future loader-level
 * pre-validation) cannot drift from the runtime zod schema.
 *
 * To regenerate after a schema change:
 *
 *   UPDATE_SCHEMA=1 pnpm --filter @mnmal-ai/cortext test
 *
 * Without the env flag this test fails on drift — vitest's diff output
 * points at exactly what changed.
 *
 * Canonical pattern shared across every substrate plugin.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CortextBootstrapConfigSchema } from '../src/bootstrap.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '..', 'config.schema.json');
const defaultConfigPath = resolve(here, '..', 'default-config.json');

describe('config.schema.json parity with zod schema', () => {
  it('committed JSON matches z.toJSONSchema(Schema)', () => {
    // io: 'input' mode marks Zod `.default(...)` fields as optional in the
    // operator-facing schema.
    const generated = `${JSON.stringify(z.toJSONSchema(CortextBootstrapConfigSchema, { io: 'input' }), null, 2)}\n`;

    if (process.env.UPDATE_SCHEMA === '1') {
      writeFileSync(schemaPath, generated);
    }

    const committed = readFileSync(schemaPath, 'utf8');
    expect(committed).toBe(generated);
  });
});

describe('default-config.json parity with zod defaults', () => {
  // The plugin-dir loader merges default-config.json over nothing BEFORE zod
  // parsing, so for manifest-loaded deployments the JSON file wins and the
  // zod .default()s only govern programmatic/embedded callers.
  // The two sources must resolve identically or the deployment modes diverge.
  it('parsing the committed file equals parsing {}', () => {
    const committed: unknown = JSON.parse(readFileSync(defaultConfigPath, 'utf8'));
    expect(CortextBootstrapConfigSchema.parse(committed)).toEqual(
      CortextBootstrapConfigSchema.parse({})
    );
  });
});
