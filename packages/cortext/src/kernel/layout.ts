/**
 * Which storage layout `rows` has: one shared table (`legacy`) or a table
 * partitioned by namespace and type (`partitioned`).
 *
 * On a partitioned `rows`, Postgres refuses a UNIQUE index that lacks the
 * partition keys, and clones every parent-level index and CHECK onto every
 * other plugin's partitions. So cortext's raw DDL runs on `legacy` only; on
 * `partitioned` the engine builds cortext's declared and `indexed: true`
 * indexes per partition.
 */

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

export type StoreLayout = 'legacy' | 'partitioned';

/**
 * The layout the host reports, else the catalog's answer.
 *
 * `reported` is `KernelMigrationContext.layout` on hosts that carry it.
 * shortcut: catalog fallback for hosts without `ctx.layout`; drop it once the
 * contract floor is a substrate that always reports the layout.
 */
export async function storeLayout(sql: unknown, reported?: unknown): Promise<StoreLayout> {
  if (reported === 'legacy' || reported === 'partitioned') return reported;
  const [row] = (await (sql as SqlTag)`
    SELECT c.relkind AS kind FROM pg_class c WHERE c.oid = to_regclass('rows')
  `) as unknown as [{ kind: string } | undefined];
  return row?.kind === 'p' ? 'partitioned' : 'legacy';
}

/** `ctx.layout` where the host's context carries it. */
export function reportedLayout(ctx: object): unknown {
  return (ctx as { layout?: unknown }).layout;
}
