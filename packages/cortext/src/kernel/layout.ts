/**
 * How the store keeps rows: one shared `rows` table (`legacy`), `rows`
 * partitioned by namespace and type (`partitioned`), or one table per type
 * listed in `substrate_type_tables` (`tables`, the only layout substrate
 * 1.0.0-alpha.12 and later boots).
 *
 * cortext's raw DDL targets `rows` on `legacy` only. On `partitioned`,
 * Postgres refuses a UNIQUE index that lacks the partition keys and clones
 * every parent-level index and CHECK onto other plugins' partitions; on
 * `tables` there is no `rows` at all. On both, the engine builds cortext's
 * declared indexes, `indexed: true` fields and enum CHECKs per type.
 */

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

export type StoreLayout = 'legacy' | 'partitioned' | 'tables';

/** Whether `layout` has a shared `rows` table for cortext's raw DDL to target. */
export const hasRowsTable = (layout: unknown): boolean =>
  layout === 'legacy' || layout === 'partitioned';

/**
 * The layout as the catalog reports it. Migrations read `ctx.layout` instead;
 * this is for boot-time code, whose lifecycle context does not carry it.
 * A schema with neither table reads as `legacy`, whose audit then reports
 * every object missing.
 */
export async function storeLayout(sql: unknown): Promise<StoreLayout> {
  const [row] = (await (sql as SqlTag)`
    SELECT (SELECT c.relkind FROM pg_class c WHERE c.oid = to_regclass('rows')) AS kind,
           to_regclass('substrate_type_tables') IS NOT NULL AS tables
  `) as unknown as [{ kind: string | null; tables: boolean } | undefined];
  if (row?.kind === 'p') return 'partitioned';
  if (row?.kind == null && row?.tables === true) return 'tables';
  return 'legacy';
}
