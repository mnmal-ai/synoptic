import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readMcpJsonFacts } from '../src/mcp-json-facts.js';

test('a SUBSTRATE_AGENT_KEY_ID naming a host is flagged as a host-pinned identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synoptic-mcpjson-'));
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        substrate: {
          command: 'npx',
          args: ['-y', '@mnmal-ai/substrate@next', 'mcp'],
          env: { SUBSTRATE_AGENT_KEY_ID: 'repo-claude@example-host' }
        }
      }
    })
  );
  const { markers } = readMcpJsonFacts(dir);
  expect(markers).toContainEqual({
    field: 'substrate.env.SUBSTRATE_AGENT_KEY_ID',
    kind: 'host-pinned identity'
  });
});
