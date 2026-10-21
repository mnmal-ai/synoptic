#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readHookStdin } from '../../synoptic/src/hook-io.js';
import { loadConfig } from './config.js';
import { handleHook } from './hook.js';

try {
  const input = await readHookStdin();
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const version = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
  ).version;
  const config = loadConfig(cwd);
  // Renderer tunable defaults read process.env. This is a dedicated hook
  // process, so overlaying the validated local values cannot affect Codex.
  Object.assign(process.env, config.env);
  const result = await handleHook(input, config, { version });
  if (result.warning) process.stderr.write(result.warning);
  process.stdout.write(result.output || '{}');
} catch {
  process.stderr.write('Cortext hook unavailable; check .codex/cortext.local.json settings.\n');
  process.stdout.write('{}');
}
