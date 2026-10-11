import { sql } from 'kysely'
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import { audit } from '../../lib/audit.js'
import { ApiError, forbidden, notFound } from '../../lib/errors.js'
import { kvDel, kvGet, kvSet } from '../../lib/kv.js'
import type { Ctx } from '../rbac/rbac.service.js'
import type { CreateCountryInput, DropdownField, ListQuery, PatchCountryInput } from './countries.schemas.js'

export type { Ctx }

const COLUMNS = ['id', 'name', 'iso2', 'iso3', 'phone_code', 'currency_code', 'is_active', 'sort_order', 'created_at', 'updated_at', 'deleted_at'] as const
const stateCount = sql<number>`(select count(*)::int from states s where s.country_id = countries.id and s.deleted_at is null)`.as('state_count')

const NOT_FOUND = 'Country not found.'
const STALE = 'Someone else changed this country. Reload.'
const DROPDOWN_CAP = 5000
const DROPDOWN_TTL_SECONDS = 600
const VERSION_KEY = 'master:countries:ver'

type Row = {
  id: string
  name: string
  iso2: string
  iso3: string
  phone_code: string
  currency_code: string
  is_active: boolean
  sort_order: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  state_count: number
}

function present(r: Row) {
  return {
    id: r.id,
    name: r.name,
    iso2: r.iso2,
    iso3: r.iso3,
    phoneCode: r.phone_code,
    currencyCode: r.currency_code,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    stateCount: r.state_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  }
}
export type CountryView = ReturnType<typeof present>

// What goes into audit_logs: the editable fields only, never counts or timestamps.
const snapshot = (c: CountryView) => ({ name: c.name, iso2: c.iso2, iso3: c.iso3, phoneCode: c.phoneCode, currencyCode: c.currencyCode, isActive: c.isActive, sortOrder: c.sortOrder })

const auditBase = (ctx: Ctx, entityId: string) => ({
  actorType: 'admin' as const,
  actorId: ctx.actor.id,
  actorEmail: ctx.actor.email,
  module: 'locations',
  entityType: 'countries',
  entityId,
  ip: ctx.ip,
  userAgent: ctx.userAgent,
  requestId: ctx.requestId,
})

// PostgreSQL 23505 on the partial unique indexes becomes CONFLICT_DUPLICATE naming the field (section 5).
function mapDuplicate(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string }
  if (err?.code !== '23505') return e
  if (err.constraint === 'uq_countries_iso2') return new ApiError(409, 'CONFLICT_DUPLICATE', 'A country with this ISO code already exists.', { field: 'iso2' })
  return new ApiError(409, 'CONFLICT_DUPLICATE', 'A country with this name already exists.', { field: 'name' })
}

async function loadOne(executor: Kysely<DB>, id: string, opts: { lock?: boolean; includeDeleted?: boolean } = {}): Promise<Row> {
  let q = executor.selectFrom('countries').select([...COLUMNS, stateCount]).where('id', '=', id)
  if (!opts.includeDeleted) q = q.where('deleted_at', 'is', null)
  if (opts.lock) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound(NOT_FOUND)
  return row as Row
}

// ------------------------------------------------------------------ dropdown cache (FR-7.S2)

async function cacheVersion(): Promise<string> {
  return (await kvGet(VERSION_KEY)) ?? '0'
}

// Any write bumps the version, which orphans every cached dropdown variant at once.
async function purgeCache(): Promise<void> {
  await kvSet(VERSION_KEY, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 30 * 86_400)
}

/** Test hook: forget the cache version so a fresh process view is simulated. */
export async function resetCacheVersion(): Promise<void> {
  await kvDel(VERSION_KEY)
}

const DROPDOWN_COLUMN: Record<DropdownField, (typeof COLUMNS)[number]> = {
  id: 'id',
  name: 'name',
  iso2: 'iso2',
  iso3: 'iso3',
  phoneCode: 'phone_code',
  currencyCode: 'currency_code',
  sortOrder: 'sort_order',
}

// Shared by the paged list, its total and the dropdown so the three can never disagree.
function filterWhere(query: ListQuery, includeDeleted: boolean) {
  return (eb: ExpressionBuilder<DB, 'countries'>) => {
    const conditions: Expression<SqlBool>[] = []
    if (!includeDeleted) conditions.push(eb('deleted_at', 'is', null))
    if (query.active !== undefined) conditions.push(eb('is_active', '=', query.active))
    if (query.q) {
      const term = query.q
      const prefix = `${term.replace(/[\\%_]/g, '\\$&')}%`
      const code = term.toUpperCase()
      conditions.push(
        eb.or([
          sql<SqlBool>`lower(name) like lower(${prefix})`,
          sql<SqlBool>`similarity(name, ${term}) > 0.3`,
          sql<SqlBool>`iso2 = ${code}`,
          sql<SqlBool>`iso3 = ${code}`,
        ]),
      )
    }
    return eb.and(conditions)
  }
}

// ------------------------------------------------------------------ reads

export async function listCountries(ctx: Ctx, query: ListQuery) {
  const includeDeleted = query.includeDeleted === true
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted countries.')

  if (query.fields) {
    return { data: await dropdown(query), meta: undefined }
  }

  const where = filterWhere(query, includeDeleted)
  const total = Number((await db.selectFrom('countries').select(sql<string>`count(*)`.as('n')).where(where).executeTakeFirstOrThrow()).n)

  const [field, dir] = (query.sort ?? 'sortOrder:asc').split(':') as ['name' | 'sortOrder' | 'createdAt', 'asc' | 'desc']
  const column = field === 'name' ? 'name' : field === 'createdAt' ? 'created_at' : 'sort_order'
  let rows = db.selectFrom('countries').select([...COLUMNS, stateCount]).where(where).orderBy(column, dir)
  if (column !== 'name') rows = rows.orderBy('name', 'asc')
  const result = await rows.orderBy('id').limit(query.pageSize).offset((query.page - 1) * query.pageSize).execute()

  return {
    data: (result as Row[]).map(present),
    meta: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) },
  }
}

async function dropdown(query: ListQuery): Promise<Record<string, unknown>[]> {
  const fields = query.fields!
  const cacheable = !query.q
  const key = `master:countries:dd:${await cacheVersion()}:${query.active ?? 'any'}:${fields.join(',')}`
  if (cacheable) {
    const hit = await kvGet(key)
    if (hit) return JSON.parse(hit) as Record<string, unknown>[]
  }
  const rows = await db
    .selectFrom('countries')
    .select(COLUMNS)
    .where(filterWhere(query, false))
    .orderBy('sort_order', 'asc')
    .orderBy('name', 'asc')
    .limit(DROPDOWN_CAP)
    .execute()
  const data = rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[DROPDOWN_COLUMN[f]]])))
  if (cacheable) await kvSet(key, JSON.stringify(data), DROPDOWN_TTL_SECONDS)
  return data
}

export async function getCountry(ctx: Ctx, id: string, includeDeleted = false) {
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted countries.')
  return present(await loadOne(db, id, { includeDeleted }))
}

// ------------------------------------------------------------------ writes

export async function createCountry(ctx: Ctx, input: CreateCountryInput) {
  const created = await db
    .transaction()
    .execute(async (trx) => {
      const inserted = await trx
        .insertInto('countries')
        .values({
          name: input.name,
          iso2: input.iso2,
          iso3: input.iso3,
          phone_code: input.phoneCode,
          currency_code: input.currencyCode,
          is_active: input.isActive,
          sort_order: input.sortOrder,
          created_by: ctx.actor.id,
          updated_by: ctx.actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const view = present(await loadOne(trx, inserted.id))
      await audit(trx, { ...auditBase(ctx, view.id), action: 'country.created', newValues: snapshot(view) })
      return view
    })
    .catch((e) => {
      throw mapDuplicate(e)
    })
  await purgeCache()
  return created
}

const FIELD_COLUMN = {
  name: 'name',
  iso2: 'iso2',
  iso3: 'iso3',
  phoneCode: 'phone_code',
  currencyCode: 'currency_code',
  isActive: 'is_active',
  sortOrder: 'sort_order',
} as const

export async function patchCountry(ctx: Ctx, id: string, version: Date, input: PatchCountryInput) {
  const updated = await db
    .transaction()
    .execute(async (trx) => {
      const row = await loadOne(trx, id, { lock: true })
      const before = present(row)
      if (row.updated_at.getTime() !== version.getTime()) {
        throw new ApiError(409, 'VERSION_CONFLICT', STALE, { current: before })
      }

      const changes = Object.entries(input).filter(([k, v]) => v !== undefined && v !== before[k as keyof CountryView]) as [keyof typeof FIELD_COLUMN, unknown][]
      if (changes.length === 0) return before

      const set: Record<string, unknown> = { updated_by: ctx.actor.id }
      for (const [k, v] of changes) set[FIELD_COLUMN[k]] = v
      await trx.updateTable('countries').set(set as never).where('id', '=', id).execute()

      const after = present(await loadOne(trx, id))
      await audit(trx, {
        ...auditBase(ctx, id),
        action: 'country.updated',
        oldValues: Object.fromEntries(changes.map(([k]) => [k, before[k]])),
        newValues: Object.fromEntries(changes.map(([k]) => [k, after[k]])),
      })
      return after
    })
    .catch((e) => {
      throw mapDuplicate(e)
    })
  await purgeCache()
  return updated
}

export async function setCountryActive(ctx: Ctx, id: string, active: boolean, reason?: string) {
  const result = await db.transaction().execute(async (trx) => {
    const row = await loadOne(trx, id, { lock: true })
    if (row.is_active === active) return { view: present(row), changed: false }
    await trx.updateTable('countries').set({ is_active: active, updated_by: ctx.actor.id }).where('id', '=', id).execute()
    const view = present(await loadOne(trx, id))
    await audit(trx, {
      ...auditBase(ctx, id),
      action: active ? 'country.activated' : 'country.deactivated',
      oldValues: { isActive: !active },
      newValues: { isActive: active },
      reason: reason ?? null,
    })
    return { view, changed: true }
  })
  if (result.changed) await purgeCache()
  return result.view
}

export async function deleteCountry(ctx: Ctx, id: string) {
  await db.transaction().execute(async (trx) => {
    // The row lock also blocks a concurrent state insert (its FK check takes a share lock on this row).
    const row = await loadOne(trx, id, { lock: true })
    const { n } = await trx
      .selectFrom('states')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('country_id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow()
    if (n > 0) {
      throw new ApiError(409, 'CONFLICT_IN_USE', 'This country is in use. Deactivate it instead.', { references: { states: n } })
    }
    await trx.updateTable('countries').set({ deleted_at: sql`now()`, deleted_by: ctx.actor.id, updated_by: ctx.actor.id }).where('id', '=', id).execute()
    await audit(trx, { ...auditBase(ctx, id), action: 'country.deleted', oldValues: snapshot(present(row)) })
  })
  await purgeCache()
}

export async function restoreCountry(ctx: Ctx, id: string) {
  if (!ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can restore a country.')
  const restored = await db
    .transaction()
    .execute(async (trx) => {
      const row = await loadOne(trx, id, { lock: true, includeDeleted: true })
      if (!row.deleted_at) throw new ApiError(409, 'CONFLICT_STATE', 'This country is not deleted.')
      await trx.updateTable('countries').set({ deleted_at: null, deleted_by: null, updated_by: ctx.actor.id }).where('id', '=', id).execute()
      const view = present(await loadOne(trx, id))
      await audit(trx, { ...auditBase(ctx, id), action: 'country.restored', newValues: snapshot(view) })
      return view
    })
    .catch((e) => {
      throw mapDuplicate(e)
    })
  await purgeCache()
  return restored
}
