import { sql } from 'kysely'
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import { audit } from '../../lib/audit.js'
import { ApiError, conflictState, forbidden, notFound, validationFailed } from '../../lib/errors.js'
import { createDropdownCache } from '../../lib/masters/dropdownCache.js'
import { auditBase, deleteMaster, duplicateError, patchMaster, restoreMaster, setMasterActive } from '../../lib/masters/kernel.js'
import type { Ctx, MasterDef } from '../../lib/masters/kernel.js'
import { likePrefix, pageMeta } from '../../lib/masters/query.js'
import { foreignKeysTo } from '../../lib/masters/references.js'
import { slugify } from '../../lib/slug.js'
import { MAX_PINCODES, PIN } from './areas.schemas.js'
import type { CreateAreaInput, DropdownField, ListQuery, PatchAreaInput } from './areas.schemas.js'

export type { Ctx }

const COLUMNS = [
  'areas.id',
  'areas.city_id',
  'areas.name',
  'areas.slug',
  'areas.pincodes',
  'areas.latitude',
  'areas.longitude',
  'areas.is_active',
  'areas.sort_order',
  'areas.created_at',
  'areas.updated_at',
  'areas.deleted_at',
] as const
const teacherCount = sql<number>`(
  select count(distinct tl.teacher_id)::int from teacher_locations tl
  join teachers t on t.id = tl.teacher_id and t.deleted_at is null
  where tl.area_id = areas.id
)`.as('teacher_count')

const NOT_FOUND = 'Area not found.'
export const BAD_PARENT = 'Pick an active parent record.'
const SAME_CITY = 'Both areas must be in the same city.'
const DROPDOWN_CAP = 5000
const cache = createDropdownCache('areas')
export const purgeAreasCache = () => cache.purge()

type Row = {
  id: string
  city_id: string
  city_name: string
  name: string
  slug: string
  pincodes: string[]
  latitude: string | null
  longitude: string | null
  is_active: boolean
  sort_order: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  teacher_count: number
}

const toNumber = (v: string | null) => (v === null ? null : Number(v))

function present(r: Row) {
  return {
    id: r.id,
    city: { id: r.city_id, name: r.city_name },
    cityId: r.city_id,
    name: r.name,
    slug: r.slug,
    pincodes: r.pincodes,
    latitude: toNumber(r.latitude),
    longitude: toNumber(r.longitude),
    isActive: r.is_active,
    sortOrder: r.sort_order,
    teacherCount: r.teacher_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  }
}
export type AreaView = ReturnType<typeof present>

function mapDuplicate(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string }
  if (err?.code !== '23505') return e
  return duplicateError('An area with this name already exists.', 'name')
}

// The parent city has to exist, be active and not be deleted (section 5).
export async function assertActiveCity(executor: Kysely<DB>, cityId: string) {
  const city = await executor.selectFrom('cities').select('id').where('id', '=', cityId).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
  if (!city) throw validationFailed([{ path: 'cityId', message: BAD_PARENT }], BAD_PARENT)
}

/** "Koramangala" -> "koramangala", then "koramangala-2" when another live area of the city has it. `taken` adds slugs already claimed in the same batch. */
export async function freeSlug(executor: Kysely<DB>, cityId: string, name: string, taken: ReadonlySet<string> = new Set()): Promise<string> {
  const base = /[a-z0-9]/i.test(name.normalize('NFKD')) ? slugify(name).slice(0, 56) : 'area'
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    if (taken.has(candidate)) continue
    const clash = await executor.selectFrom('areas').select('id').where('city_id', '=', cityId).where('slug', '=', candidate).where('deleted_at', 'is', null).executeTakeFirst()
    if (!clash) return candidate
  }
}

function selectRows(executor: Kysely<DB>) {
  return executor.selectFrom('areas').innerJoin('cities as c', 'c.id', 'areas.city_id').select([...COLUMNS, 'c.name as city_name', teacherCount])
}

export const def: MasterDef<Row, AreaView> = {
  table: 'areas',
  noun: 'area',
  plural: 'areas',
  auditPrefix: 'area',
  auditModule: 'locations',
  async load(executor: Kysely<DB>, id, options = {}) {
    if (options.lock) await executor.selectFrom('areas').select('id').where('id', '=', id).forUpdate().executeTakeFirst()
    let q = selectRows(executor).where('areas.id', '=', id)
    if (!options.includeDeleted) q = q.where('areas.deleted_at', 'is', null)
    const row = await q.executeTakeFirst()
    if (!row) throw notFound(NOT_FOUND)
    return row as Row
  },
  present,
  snapshot: (a) => ({ cityId: a.cityId, name: a.name, slug: a.slug, pincodes: a.pincodes, latitude: a.latitude, longitude: a.longitude, isActive: a.isActive, sortOrder: a.sortOrder }),
  purgeCache: purgeAreasCache,
  mapDuplicate,
  // An area can't come back under a city that has itself been deleted.
  guardRestore: async (executor, row) => {
    const city = await executor.selectFrom('cities').select('id').where('id', '=', row.city_id).where('deleted_at', 'is', null).executeTakeFirst()
    if (!city) throw conflictState(`Restore ${row.city_name} first, then restore this area.`)
  },
}

// ------------------------------------------------------------------ reads

function filterWhere(query: ListQuery, includeDeleted: boolean) {
  return (eb: ExpressionBuilder<DB, 'areas'>) => {
    const conditions: Expression<SqlBool>[] = []
    if (!includeDeleted) conditions.push(eb('areas.deleted_at', 'is', null))
    if (query.active !== undefined) conditions.push(eb('areas.is_active', '=', query.active))
    if (query.cityId) conditions.push(eb('areas.city_id', '=', query.cityId))
    if (query.hasCoordinates !== undefined) {
      conditions.push(query.hasCoordinates ? sql<SqlBool>`areas.latitude is not null and areas.longitude is not null` : sql<SqlBool>`(areas.latitude is null or areas.longitude is null)`)
    }
    if (query.q) {
      const term = query.q
      const matches: Expression<SqlBool>[] = [sql<SqlBool>`lower(areas.name) like lower(${likePrefix(term)})`, sql<SqlBool>`similarity(areas.name, ${term}) > 0.3`]
      // A 6-digit term is a PIN code and uses the GIN index on pincodes.
      if (PIN.test(term)) matches.push(sql<SqlBool>`areas.pincodes @> ARRAY[${term}]::text[]`)
      conditions.push(eb.or(matches))
    }
    return eb.and(conditions)
  }
}

const DROPDOWN_COLUMN: Record<DropdownField, 'id' | 'name' | 'slug' | 'city_id' | 'pincodes' | 'sort_order'> = {
  id: 'id',
  name: 'name',
  slug: 'slug',
  cityId: 'city_id',
  pincodes: 'pincodes',
  sortOrder: 'sort_order',
}

export async function listAreas(ctx: Ctx, query: ListQuery) {
  const includeDeleted = query.includeDeleted === true
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted areas.')

  if (query.fields) return { data: await dropdown(query), meta: undefined }

  const where = filterWhere(query, includeDeleted)
  const total = Number((await db.selectFrom('areas').select(sql<string>`count(*)`.as('n')).where(where).executeTakeFirstOrThrow()).n)

  const [field, dir] = (query.sort ?? 'sortOrder:asc').split(':') as ['name' | 'sortOrder' | 'createdAt', 'asc' | 'desc']
  const column = field === 'name' ? 'areas.name' : field === 'createdAt' ? 'areas.created_at' : 'areas.sort_order'
  let rows = selectRows(db).where(where).orderBy(column, dir)
  if (column !== 'areas.name') rows = rows.orderBy('areas.name', 'asc')
  const result = await rows.orderBy('areas.id').limit(query.pageSize).offset((query.page - 1) * query.pageSize).execute()

  return { data: (result as Row[]).map(present), meta: pageMeta(query.page, query.pageSize, total) }
}

async function dropdown(query: ListQuery): Promise<Record<string, unknown>[]> {
  const fields = query.fields!
  const variant = `${query.active ?? 'any'}:${query.cityId ?? 'any'}:${fields.join(',')}`
  const cacheable = !query.q
  if (cacheable) {
    const hit = await cache.get<Record<string, unknown>[]>(variant)
    if (hit) return hit
  }
  const rows = await db
    .selectFrom('areas')
    .select(['id', 'name', 'slug', 'city_id', 'pincodes', 'sort_order'])
    .where(filterWhere(query, false))
    .orderBy('sort_order', 'asc')
    .orderBy('name', 'asc')
    .limit(DROPDOWN_CAP)
    .execute()
  const data = rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[DROPDOWN_COLUMN[f]]])))
  if (cacheable) await cache.set(variant, data)
  return data
}

export async function getArea(ctx: Ctx, id: string, includeDeleted = false) {
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted areas.')
  return present(await def.load(db, id, { includeDeleted }))
}

// FR-10.S3: which areas cover a PIN code (support, and the app pre-filling an address).
export async function areasByPincode(pin: string) {
  const rows = await db
    .selectFrom('areas')
    .innerJoin('cities as c', 'c.id', 'areas.city_id')
    .select(['areas.id', 'areas.name', 'areas.slug', 'areas.pincodes', 'areas.is_active', 'areas.city_id', 'c.name as city_name'])
    .where('areas.deleted_at', 'is', null)
    .where(sql<SqlBool>`areas.pincodes @> ARRAY[${pin}]::text[]`)
    .orderBy('c.name')
    .orderBy('areas.name')
    .execute()
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, pincodes: r.pincodes, isActive: r.is_active, city: { id: r.city_id, name: r.city_name } }))
}

// ------------------------------------------------------------------ writes

export async function createArea(ctx: Ctx, input: CreateAreaInput) {
  const created = await db
    .transaction()
    .execute(async (trx) => {
      await assertActiveCity(trx, input.cityId)
      const inserted = await trx
        .insertInto('areas')
        .values({
          city_id: input.cityId,
          name: input.name,
          slug: await freeSlug(trx, input.cityId, input.name),
          pincodes: input.pincodes,
          latitude: input.latitude === null ? null : String(input.latitude),
          longitude: input.longitude === null ? null : String(input.longitude),
          is_active: input.isActive,
          sort_order: input.sortOrder,
          created_by: ctx.actor.id,
          updated_by: ctx.actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const view = present(await def.load(trx, inserted.id))
      await audit(trx, { ...auditBase(ctx, def, view.id), action: 'area.created', newValues: def.snapshot(view) })
      return view
    })
    .catch((e) => {
      throw mapDuplicate(e)
    })
  await purgeAreasCache()
  return created
}

export function patchArea(ctx: Ctx, id: string, version: Date, input: PatchAreaInput) {
  return patchMaster(def, ctx, id, version, input, {
    columns: { cityId: 'city_id', name: 'name', pincodes: 'pincodes', latitude: 'latitude', longitude: 'longitude', isActive: 'is_active', sortOrder: 'sort_order' },
    validate: async (trx, _row, _before, changes) => {
      if ('cityId' in changes) await assertActiveCity(trx, changes.cityId as string)
    },
  })
}

export const setAreaActive = (ctx: Ctx, id: string, active: boolean, reason?: string) => setMasterActive(def, ctx, id, active, reason)
export const deleteArea = (ctx: Ctx, id: string) => deleteMaster(def, ctx, id)
export const restoreArea = (ctx: Ctx, id: string) => restoreMaster(def, ctx, id)

const MERGE_TARGET = 'Pick the area to merge into.'

/**
 * FR-10.S2: moves everything that points at the source area to the target, unions their PIN codes and removes the
 * source, all in one transaction. A teacher who covers both areas ends up with one row and keeps their primary flag.
 */
export async function mergeAreas(ctx: Ctx, sourceId: string, input: { intoAreaId: string; reason?: string }) {
  if (sourceId === input.intoAreaId) throw validationFailed([{ path: 'intoAreaId', message: 'Pick a different area to merge into.' }], 'Pick a different area to merge into.')

  const result = await db
    .transaction()
    .execute(async (trx) => {
      // Lock both rows in a fixed order so two merges can't deadlock.
      for (const id of [sourceId, input.intoAreaId].sort()) await trx.selectFrom('areas').select('id').where('id', '=', id).forUpdate().executeTakeFirst()
      const source = await def.load(trx, sourceId)
      const target = await def.load(trx, input.intoAreaId).catch((e) => {
        if (e instanceof ApiError && e.status === 404) throw validationFailed([{ path: 'intoAreaId', message: MERGE_TARGET }], MERGE_TARGET)
        throw e
      })
      if (source.city_id !== target.city_id) throw validationFailed([{ path: 'intoAreaId', message: SAME_CITY }], SAME_CITY)

      const pincodes = [...new Set([...target.pincodes, ...source.pincodes])].sort()
      if (pincodes.length > MAX_PINCODES) {
        const message = `The merged area would have ${pincodes.length} PIN codes; the limit is ${MAX_PINCODES}.`
        throw validationFailed([{ path: 'intoAreaId', message }], message)
      }

      const moved: Record<string, number> = {}
      for (const fk of await foreignKeysTo(trx, 'areas')) {
        if (fk.table === 'teacher_locations') {
          // Teachers covering both areas: keep the target's row (handing it the primary flag if only the source had it).
          const flipped = await sql<{ teacher_id: string }>`
            update teacher_locations s set is_primary = false from teacher_locations t
            where s.area_id = ${source.id} and t.area_id = ${target.id} and s.teacher_id = t.teacher_id and s.city_id = t.city_id and s.is_primary and not t.is_primary
            returning s.teacher_id`.execute(trx)
          if (flipped.rows.length > 0) {
            await sql`update teacher_locations set is_primary = true where area_id = ${target.id} and teacher_id = any(${flipped.rows.map((r) => r.teacher_id)}::uuid[])`.execute(trx)
          }
          const dropped = await sql`
            delete from teacher_locations s using teacher_locations t
            where s.area_id = ${source.id} and t.area_id = ${target.id} and s.teacher_id = t.teacher_id and s.city_id = t.city_id`.execute(trx)
          const updated = await sql`update teacher_locations set area_id = ${target.id} where area_id = ${source.id}`.execute(trx)
          const n = Number(dropped.numAffectedRows ?? 0) + Number(updated.numAffectedRows ?? 0)
          if (n > 0) moved[fk.table] = (moved[fk.table] ?? 0) + n
          continue
        }
        const res = await sql`update ${sql.table(fk.table)} set ${sql.ref(fk.column)} = ${target.id} where ${sql.ref(fk.column)} = ${source.id}`.execute(trx)
        const n = Number(res.numAffectedRows ?? 0)
        if (n > 0) moved[fk.table] = (moved[fk.table] ?? 0) + n
      }

      await trx.updateTable('areas').set({ pincodes, updated_by: ctx.actor.id }).where('id', '=', target.id).execute()
      await trx.updateTable('areas').set({ deleted_at: sql`now()`, deleted_by: ctx.actor.id, updated_by: ctx.actor.id }).where('id', '=', source.id).execute()
      await audit(trx, {
        ...auditBase(ctx, def, source.id),
        action: 'area.merged',
        oldValues: { name: source.name, pincodes: source.pincodes },
        newValues: { intoAreaId: target.id, intoName: target.name, pincodes, moved },
        reason: input.reason ?? null,
      })
      return { area: present(await def.load(trx, target.id)), moved }
    })
    .catch((e) => {
      // Some other table holds a row for both areas that can't simply be moved.
      if ((e as { code?: string })?.code === '23505') throw conflictState("These areas can't be merged automatically: some records refer to both of them.")
      throw e
    })
  await purgeAreasCache()
  return result
}
