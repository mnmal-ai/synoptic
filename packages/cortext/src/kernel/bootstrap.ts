/**
 * Structured-config bootstrap for cortext's kernel plugin
 * (mirrors the recall + plane bootstrap pattern).
 *
 * No operator-overridable surface today — the plugin contributes a
 * static migration list and nothing else. Reserved for future schema-
 * level controls if any emerge.
 */

import { defineBootstrap } from '@mnmal-ai/substrate/sdk';
import { z } from 'zod';
import { createCortextKernelPlugin } from './plugin.js';

const CortextKernelConfigSchema = z.object({}).strict();
type CortextKernelConfig = z.infer<typeof CortextKernelConfigSchema>;
type CortextKernelHostDeps = Record<string, never>;

export const bootstrap = defineBootstrap.kernel<CortextKernelConfig, CortextKernelHostDeps>({
  schema: CortextKernelConfigSchema,
  build: () => createCortextKernelPlugin()
});

export default bootstrap;
