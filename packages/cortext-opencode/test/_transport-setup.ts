// These suites test the plugin's logic against a stubbed global `fetch`.
// Synoptic now reaches substrate through `substrateFetch` (HTTP/2), so route it
// to whatever `fetch` is current; the Bun HTTP/2 smoke covers the real transport.
import { vi } from 'vitest';

vi.mock('@mnmal-ai/substrate/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mnmal-ai/substrate/client')>()),
  substrateFetch: (input: string, init?: RequestInit) => globalThis.fetch(input, init)
}));
