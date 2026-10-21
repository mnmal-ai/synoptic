import { describe, expect, it } from 'vitest';
import * as host from '../src/index.js';

describe('host public surface (src/index.js)', () => {
  it('exports the onboarding pipeline + capability contract', () => {
    for (const name of [
      'onboard',
      'applyOnboard',
      'planActions',
      'wireMCP',
      'HARNESSES',
      'projectColdStart',
      'provisionIdentity',
      'defineCapability',
      'cortext'
    ]) {
      expect(host[name], name).toBeDefined();
    }
  });
});
