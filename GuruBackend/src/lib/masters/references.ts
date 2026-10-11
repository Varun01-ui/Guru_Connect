import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB } from '../../db/types.js'

export type ForeignKey = { table: string; column: string; soft: boolean }
const cache = new Map<string, ForeignKey[]>()

// Every single-column foreign key that points at `table`, read from the catalog. Module specs list the referencing
// tables by hand and those lists go stale as modules land; asking PostgreSQL means a delete can never orphan a row,
// including tables added later. The answer only changes with a migration, so it is cached for the process lifetime.
export async function foreignKeysTo(executor: Kysely<DB>, table: string): Promise<ForeignKey[]> {
  const hit = cache.get(table)
  if (hit) return hit
  const result = await sql<{ table_name: string; column_name: string; soft: boolean }>`
    select cl.relname as table_name, a.attname as column_name,
      exists (select 1 from pg_attribute d where d.attrelid = cl.oid and d.attname = 'deleted_at' and not d.attisdropped) as soft
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and cardinality(c.conkey) = 1 and c.confrelid = ${`public.${table}`}::regclass
    order by cl.relname, a.attname`.execute(executor)
  const keys = result.rows.map((r) => ({ table: r.table_name, column: r.column_name, soft: r.soft }))
  cache.set(table, keys)
  return keys
}

/**
 * Live rows that reference `id`, keyed by referencing table (or `table.column` when one table points at it through
 * several columns). Tables with `deleted_at` only count rows that are not soft-deleted. Zero counts are omitted, so an
 * empty object means the row can be deleted.
 */
export async function countReferences(executor: Kysely<DB>, table: string, id: string): Promise<Record<string, number>> {
  const keys = await foreignKeysTo(executor, table)
  const perTable = new Map<string, number>()
  for (const k of keys) perTable.set(k.table, (perTable.get(k.table) ?? 0) + 1)

  const references: Record<string, number> = {}
  for (const k of keys) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from ${sql.table(k.table)} where ${sql.ref(k.column)} = ${id}${k.soft ? sql` and deleted_at is null` : sql``}`.execute(executor)
    const n = rows[0]?.n ?? 0
    if (n > 0) references[perTable.get(k.table)! > 1 ? `${k.table}.${k.column}` : k.table] = n
  }
  return references
}
