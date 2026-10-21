#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createAgentAuth } from '../../synoptic/src/agent-auth.js';
import { loadConfig, mcpInvocation } from './config.js';

try {
  const config = loadConfig(process.cwd());
  const auth = createAgentAuth(config.env);
  if (auth.warning) throw new Error('Codex signing identity is incomplete or unreadable');
  const invocation = mcpInvocation(config);
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: 'inherit',
    shell: false
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', () => {
    process.stderr.write('Cortext MCP executable could not start; check mcp.command.\n');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  // These errors contain configuration field names, never credential values.
  process.stderr.write(`Cortext MCP: ${error.message}\n`);
  process.exitCode = 1;
}
