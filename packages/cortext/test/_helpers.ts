/**
 * Test helper: build the claude plugin with sane defaults + caller-supplied
 * overrides. The pure factory requires a fully-resolved
 * `CortextPluginConfig`, and tests prefer to thread only the bits they care
 * about.
 */

import type { CoordinatorPlugin } from '@mnmal-ai/substrate/sdk';
import { type CortextPluginConfig, createCortextPlugin } from '../src/index.js';

export function buildClaudeForTest(
  overrides: Partial<CortextPluginConfig> = {}
): CoordinatorPlugin {
  return createCortextPlugin({
    namespace: 'claude',
    architectureNamespace: 'architecture',
    compactRetention: 7,
    autoCompactIntervalMs: undefined,
    auth: undefined,
    ...overrides
  });
}
