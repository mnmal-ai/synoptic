import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The kernel's pg suites: the setup guards the database, and each suite
    // runs in a schema of its own.
    globalSetup: ['./test/_global-setup.ts'],
    setupFiles: ['./test/_setup.ts']
  }
});
