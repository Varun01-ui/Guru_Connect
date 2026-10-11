import { sql } from 'kysely'
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import { audit } from '../../lib/audit.js'
import { conflictState, forbidden, notFound, validationFailed } from '../../lib/errors.js'
import { createDropdownCache } from '../../lib/masters/dropdownCache.js'
import { auditBase, deleteMaster, duplicateError, patchMaster, restoreMaster, setMasterActive } from '../../lib/masters/kernel.js'
import type { Ctx, MasterDef } from '../../lib/masters/kernel.js'
import { likePrefix, pageMeta } from '../../lib/masters/query.js'
import { slugify } from '../../lib/slug.js'
import type { CreateCityInput, DropdownField, ListQuery, PatchCityInput } from './cities.schemas.js'

export type { Ctx }

const COLUMNS = [
  'cities.id',
  'cities.state_id',
  'cities.name',
  'cities.slug',
  'cities.latitude',
  'cities.longitude',
  'cities.tier',
  'cities.is_serviceable',
  'cities.is_active',
  'cities.sort_order',
  'cities.created_at',
  'cities.updated_at',
  'cities.deleted_at',
] as const
const areaCount = sql<number>`(select count(*)::int from areas a where a.city_id = cities.id and a.deleted_at is null)`.as('area_count')
// Approved, active teachers who list this city as a place they teach.
const verifiedTeachers = sql<number>`(
  select count(distinct tl.teacher_id)::int from teacher_locations tl
  join teachers t on t.id = tl.teacher_id and t.deleted_at is null and t.verification_status = 'approved' and t.account_status = 'active'
  where tl.city_id = cities.id
)`.as('verified_teachers')

const NOT_FOUND = 'City not found.'
const BAD_PARENT = 'Pick an active parent record.'
const DROPDOWN_CAP = 5000
const cache = createDropdownCache('cities')

type Row = {
  id: string
  state_id: string
  state_name: string
  name: string
  slug: string
  latitude: string | null
  longitude: string | null
  tier: number | null
  is_serviceable: boolean
  is_active: boolean
  sort_order: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  area_count: number
  verified_teachers: number
}

// numeric(9,6) comes back from the driver as a string.
const toNumber = (v: string | null) => (v === null ? null : Number(v))

function present(r: Row) {
  return {
    id: r.id,
    state: { id: r.state_id, name: r.state_name },
    stateId: r.state_id,
    name: r.name,
    slug: r.slug,
    latitude: toNumber(r.latitude),
    longitude: toNumber(r.longitude),
    tier: r.tier,
    isServiceable: r.is_serviceable,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    areaCount: r.area_count,
    verifiedTeachers: r.verified_teachers,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  }
}
export type CityView = ReturnType<typeof present>

function mapDuplicate(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string }
  if (err?.code !== '23505') return e
  if (err.constraint === 'uq_cities_slug') return duplicateError('A city with this slug already exists.', 'slug')
  return duplicateError('A city with this name already exists.', 'name')
}

export async function assertActiveState(executor: Kysely<DB>, stateId: string) {
  const state = await executor.selectFrom('states').select('id').where('id', '=', stateId).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
  if (!state) throw validationFailed([{ path: 'stateId', message: BAD_PARENT }], BAD_PARENT)
}

// "Kochi" -> "kochi", and "kochi-2" when another live city already has that slug. A name with no letters or digits
// gets the placeholder "city".
async function freeSlug(executor: Kysely<DB>, name: string): Promise<string> {
  const base = /[a-z0-9]/i.test(name.normalize('NFKD')) ? slugify(name).slice(0, 56) : 'city'
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    const taken = await executor.selectFrom('cities').select('id').where('slug', '=', candidate).where('deleted_at', 'is', null).executeTakeFirst()
    if (!taken) return candidate.length >= 2 ? candidate : `${candidate}-${n + 1}`
  }
}

function selectRows(executor: Kysely<DB>) {
  return executor.selectFrom('cities').innerJoin('states as s', 's.id', 'cities.state_id').select([...COLUMNS, 's.name as state_name', areaCount, verifiedTeachers])
}

const def: MasterDef<Row, CityView> = {
  table: 'cities',
  noun: 'city',
  plural: 'cities',
  auditPrefix: 'city',
  auditModule: 'locations',
  async load(executor: Kysely<DB>, id, options = {}) {
    if (options.lock) await executor.selectFrom('cities').select('id').where('id', '=', id).forUpdate().executeTakeFirst()
    let q = selectRows(executor).where('cities.id', '=', id)
    if (!options.includeDeleted) q = q.where('cities.deleted_at', 'is', null)
    const row = await q.executeTakeFirst()
    if (!row) throw notFound(NOT_FOUND)
    return row as Row
  },
  present,
  snapshot: (c) => ({ stateId: c.stateId, name: c.name, slug: c.slug, latitude: c.latitude, longitude: c.longitude, tier: c.tier, isServiceable: c.isServiceable, isActive: c.isActive, sortOrder: c.sortOrder }),
  purgeCache: () => cache.purge(),
  mapDuplicate,
  // A city can't come back under a state that has itself been deleted.
  guardRestore: async (executor, row) => {
    const state = await executor.selectFrom('states').select('id').where('id', '=', row.state_id).where('deleted_at', 'is', null).executeTakeFirst()
    if (!state) throw conflictState(`Restore ${row.state_name} first, then restore this city.`)
  },
}

// ------------------------------------------------------------------ reads

function filterWhere(query: ListQuery, includeDeleted: boolean) {
  return (eb: ExpressionBuilder<DB, 'cities'>) => {
    const conditions: Expression<SqlBool>[] = []
    if (!includeDeleted) conditions.push(eb('cities.deleted_at', 'is', null))
    if (query.active !== undefined) conditions.push(eb('cities.is_active', '=', query.active))
    if (query.serviceable !== undefined) conditions.push(eb('cities.is_serviceable', '=', query.serviceable))
    if (query.stateId) conditions.push(eb('cities.state_id', '=', query.stateId))
    if (query.tier) conditions.push(eb('cities.tier', '=', query.tier))
    if (query.countryId) conditions.push(sql<SqlBool>`cities.state_id in (select id from states where country_id = ${query.countryId})`)
    if (query.q) {
      const term = query.q
      conditions.push(
        eb.or([
          sql<SqlBool>`lower(cities.name) like lower(${likePrefix(term)})`,
          sql<SqlBool>`similarity(cities.name, ${term}) > 0.3`,
          sql<SqlBool>`cities.slug = ${term.toLowerCase()}`,
        ]),
      )
    }
    return eb.and(conditions)
  }
}

const DROPDOWN_COLUMN: Record<DropdownField, 'id' | 'name' | 'slug' | 'state_id' | 'tier' | 'is_serviceable' | 'sort_order'> = {
  id: 'id',
  name: 'name',
  slug: 'slug',
  stateId: 'state_id',
  tier: 'tier',
  isServiceable: 'is_serviceable',
  sortOrder: 'sort_order',
}

export async function listCities(ctx: Ctx, query: ListQuery) {
  const includeDeleted = query.includeDeleted === true
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted cities.')

  if (query.fields) return { data: await dropdown(query), meta: undefined }

  const where = filterWhere(query, includeDeleted)
  const total = Number((await db.selectFrom('cities').select(sql<string>`count(*)`.as('n')).where(where).executeTakeFirstOrThrow()).n)

  let rows = selectRows(db).where(where)
  if (query.sort) {
    const [field, dir] = query.sort.split(':') as ['name' | 'sortOrder' | 'createdAt', 'asc' | 'desc']
    const column = field === 'name' ? 'cities.name' : field === 'createdAt' ? 'cities.created_at' : 'cities.sort_order'
    rows = rows.orderBy(column, dir)
    if (column !== 'cities.name') rows = rows.orderBy('cities.name', 'asc')
  } else if (query.q) {
    // A search ranks the closest names first (section 17).
    rows = rows.orderBy(sql`similarity(cities.name, ${query.q})`, 'desc').orderBy('cities.sort_order', 'asc').orderBy('cities.name', 'asc')
  } else {
    rows = rows.orderBy('cities.sort_order', 'asc').orderBy('cities.name', 'asc')
  }
  const result = await rows.orderBy('cities.id').limit(query.pageSize).offset((query.page - 1) * query.pageSize).execute()

  return { data: (result as Row[]).map(present), meta: pageMeta(query.page, query.pageSize, total) }
}

async function dropdown(query: ListQuery): Promise<Record<string, unknown>[]> {
  const fields = query.fields!
  const variant = `${query.active ?? 'any'}:${query.serviceable ?? 'any'}:${query.stateId ?? 'any'}:${query.countryId ?? 'any'}:${query.tier ?? 'any'}:${fields.join(',')}`
  const cacheable = !query.q
  if (cacheable) {
    const hit = await cache.get<Record<string, unknown>[]>(variant)
    if (hit) return hit
  }
  const rows = await db
    .selectFrom('cities')
    .select(['id', 'name', 'slug', 'state_id', 'tier', 'is_serviceable', 'sort_order'])
    .where(filterWhere(query, false))
    .orderBy('sort_order', 'asc')
    .orderBy('name', 'asc')
    .limit(DROPDOWN_CAP)
    .execute()
  const data = rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[DROPDOWN_COLUMN[f]]])))
  if (cacheable) await cache.set(variant, data)
  return data
}

export async function getCity(ctx: Ctx, id: string, includeDeleted = false) {
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted cities.')
  return present(await def.load(db, id, { includeDeleted }))
}

// FR-9.S3: live counts until the dashboard roll-up (M47) exists. Shown before a city is marked serviceable.
export async function getCityStats(id: string) {
  await def.load(db, id)
  const [counts] = (
    await sql<{ verified_teachers: number; institutes: number; parents: number; students: number; areas: number }>`
      select
        (select count(distinct tl.teacher_id)::int from teacher_locations tl
          join teachers t on t.id = tl.teacher_id and t.deleted_at is null and t.verification_status = 'approved' and t.account_status = 'active'
          where tl.city_id = ${id}) as verified_teachers,
        (select count(*)::int from institutes i where i.city_id = ${id} and i.deleted_at is null) as institutes,
        (select count(*)::int from parents p where p.city_id = ${id} and p.deleted_at is null) as parents,
        (select count(*)::int from students s where s.city_id = ${id} and s.deleted_at is null) as students,
        (select count(*)::int from areas a where a.city_id = ${id} and a.deleted_at is null) as areas`.execute(db)
  ).rows
  return { verifiedTeachers: counts!.verified_teachers, institutes: counts!.institutes, parents: counts!.parents, students: counts!.students, areas: counts!.areas }
}

// ------------------------------------------------------------------ writes

export async function createCity(ctx: Ctx, input: CreateCityInput) {
  const created = await db
    .transaction()
    .execute(async (trx) => {
      await assertActiveState(trx, input.stateId)
      const inserted = await trx
        .insertInto('cities')
        .values({
          state_id: input.stateId,
          name: input.name,
          slug: input.slug ?? (await freeSlug(trx, input.name)),
          latitude: input.latitude === null ? null : String(input.latitude),
          longitude: input.longitude === null ? null : String(input.longitude),
          tier: input.tier,
          is_serviceable: input.isServiceable,
          is_active: input.isActive,
          sort_order: input.sortOrder,
          created_by: ctx.actor.id,
          updated_by: ctx.actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const view = present(await def.load(trx, inserted.id))
      await audit(trx, { ...auditBase(ctx, def, view.id), action: 'city.created', newValues: def.snapshot(view) })
      return view
    })
    .catch((e) => {
      throw mapDuplicate(e)
    })
  await cache.purge()
  return created
}

export function patchCity(ctx: Ctx, id: string, version: Date, input: PatchCityInput) {
  // Coordinates stay numbers here so an unchanged value compares equal to the stored one; the driver sends them as numeric.
  return patchMaster(def, ctx, id, version, input, {
    columns: { stateId: 'state_id', name: 'name', slug: 'slug', latitude: 'latitude', longitude: 'longitude', tier: 'tier', isServiceable: 'is_serviceable', isActive: 'is_active', sortOrder: 'sort_order' },
    validate: async (trx, _row, before, changes) => {
      // FR-9.S2: deep links and SEO pages use the slug, so it is frozen once the city is live.
      if ('slug' in changes && before.isServiceable) throw conflictState("Slugs can't change after launch.")
      if ('stateId' in changes) await assertActiveState(trx, changes.stateId as string)
    },
  })
}

export const setCityActive = (ctx: Ctx, id: string, active: boolean, reason?: string) => setMasterActive(def, ctx, id, active, reason)
export const deleteCity = (ctx: Ctx, id: string) => deleteMaster(def, ctx, id)
export const restoreCity = (ctx: Ctx, id: string) => restoreMaster(def, ctx, id)
