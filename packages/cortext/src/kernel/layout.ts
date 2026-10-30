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
 * The layout as the catalog reports it. Migrations read `ctx.layout` instead;
 * this is for boot-time code, whose lifecycle context does not carry it.
 */
export async function storeLayout(sql: unknown): Promise<StoreLayout> {
  const [row] = (await (sql as SqlTag)`
    SELECT c.relkind AS kind FROM pg_class c WHERE c.oid = to_regclass('rows')
  `) as unknown as [{ kind: string } | undefined];
  return row?.kind === 'p' ? 'partitioned' : 'legacy';
}
