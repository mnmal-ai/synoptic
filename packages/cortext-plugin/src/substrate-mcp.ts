import type { EngineInterface } from 'claude-code';
import { cut } from './text.js';

// Reads and writes through the session's own substrate MCP server, so each write is signed by
// this repo's key. Shared by the Todos pane and session sharing.

/** Which namespace and which MCP server (its name as /mcp lists it) a caller talks to. */
export type Substrate = { ns: string; server: string };

/** The text of an MCP tool result, parsed as JSON. Throws with the server's words on an error. */
export async function sub(
  p: Substrate,
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>
) {
  const r = await $.mcp.call(p.server, tool, args);
  const text = r.content
    .map((c) => (c.type === 'text' ? (c as { text: string }).text : ''))
    .join('');
  if (r.isError) throw new Error(cut(text || `${tool} failed`, 200));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A reply cut short (a size cap on the way) or a server answering in prose.
    throw new Error(
      `${tool} answered ${text.length} characters that are not JSON: ${cut(text, 120)}`
    );
  }
  const body = parsed as {
    data?: Record<string, unknown>;
    errors?: { message: string; code?: string }[];
    ok?: boolean;
  };
  if (body.errors && body.errors.length > 0) {
    const err = new Error(cut(body.errors[0]?.message ?? 'refused', 200)) as Error & {
      code?: string;
    };
    err.code = body.errors[0]?.code;
    throw err;
  }
  return body;
}

export async function query<T>(
  p: Substrate,
  $: EngineInterface,
  type: string,
  frame: object
): Promise<T[]> {
  const key = `${p.ns}/${type}`;
  const body = await sub(p, $, 'query', { payload: { [key]: frame } });
  const rows = body.data?.[key];
  // A rejected frame is absent from data; an empty list is a real "nothing matched".
  if (!Array.isArray(rows)) throw new Error(`${key} did not come back`);
  return rows as T[];
}

export async function mutate<T>(
  p: Substrate,
  $: EngineInterface,
  op: string,
  params: object
): Promise<T> {
  const key = `${p.ns}/${op}`;
  const body = await sub(p, $, 'mutate', {
    payload: { [key]: { params, fields: { id: true } } }
  });
  const row = body.data?.[key];
  if (row === undefined) throw new Error(`${key} did not come back`);
  return row as T;
}
