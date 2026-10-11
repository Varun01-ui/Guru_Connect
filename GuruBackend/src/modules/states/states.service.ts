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
import type { CreateStateInput, DropdownField, ListQuery, PatchStateInput } from './states.schemas.js'

export type { Ctx }

const COLUMNS = [
  'states.id',
  'states.country_id',
  'states.name',
  'states.code',
  'states.type',
  'states.is_active',
  'states.sort_order',
  'states.created_at',
  'states.updated_at',
  'states.deleted_at',
] as const
const cityCount = sql<number>`(select count(*)::int from cities ci where ci.state_id = states.id and ci.deleted_at is null)`.as('city_count')

const NOT_FOUND = 'State not found.'
export const BAD_COUNTRY = 'Pick an active parent record.'
const DROPDOWN_CAP = 5000
const cache = createDropdownCache('states')
export const purgeStatesCache = () => cache.purge()

type Row = {
  id: string
  country_id: string
  country_name: string
  name: string
  code: string
  type: 'state' | 'union_territory'
  is_active: boolean
  sort_order: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  city_count: number
}

function present(r: Row) {
  return {
    id: r.id,
    country: { id: r.country_id, name: r.country_name },
    countryId: r.country_id,
    name: r.name,
    code: r.code,
    type: r.type,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    cityCount: r.city_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  }
}
export type StateView = ReturnType<typeof present>

export function mapDuplicate(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string }
  if (err?.code !== '23505') return e
  if (err.constraint === 'uq_states_country_code') return duplicateError('A state with this code already exists in this country.', 'code')
  return duplicateError('A state with this name already exists.', 'name')
}

// The parent country has to exist, be active and not be deleted (section 5).
export async function assertActiveCountry(executor: Kysely<DB>, countryId: string) {
  const country = await executor.selectFrom('countries').select('id').where('id', '=', countryId).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
  if (!country) throw validationFailed([{ path: 'countryId', message: BAD_COUNTRY }], BAD_COUNTRY)
}

function selectRows(executor: Kysely<DB>) {
  return executor.selectFrom('states').innerJoin('countries as c', 'c.id', 'states.country_id').select([...COLUMNS, 'c.name as country_name', cityCount])
}

export const def: MasterDef<Row, StateView> = {
  table: 'states',
  noun: 'state',
  plural: 'states',
  auditPrefix: 'state',
  auditModule: 'locations',
  async load(executor: Kysely<DB>, id, options = {}) {
    // Lock the state row alone: a locking read over the join would also lock (and so serialise) its country.
    if (options.lock) await executor.selectFrom('states').select('id').where('id', '=', id).forUpdate().executeTakeFirst()
    let q = selectRows(executor).where('states.id', '=', id)
    if (!options.includeDeleted) q = q.where('states.deleted_at', 'is', null)
    const row = await q.executeTakeFirst()
    if (!row) throw notFound(NOT_FOUND)
    return row as Row
  },
  present,
  snapshot: (s) => ({ countryId: s.countryId, name: s.name, code: s.code, type: s.type, isActive: s.isActive, sortOrder: s.sortOrder }),
  purgeCache: purgeStatesCache,
  mapDuplicate,
  // A state can't come back under a country that has itself been deleted.
  guardRestore: async (executor, row) => {
    const country = await executor.selectFrom('countries').select('id').where('id', '=', row.country_id).where('deleted_at', 'is', null).executeTakeFirst()
    if (!country) throw conflictState(`Restore ${row.country_name} first, then restore this state.`)
  },
}

// ------------------------------------------------------------------ reads

function filterWhere(query: ListQuery, includeDeleted: boolean) {
  return (eb: ExpressionBuilder<DB, 'states'>) => {
    const conditions: Expression<SqlBool>[] = []
    if (!includeDeleted) conditions.push(eb('states.deleted_at', 'is', null))
    if (query.active !== undefined) conditions.push(eb('states.is_active', '=', query.active))
    if (query.countryId) conditions.push(eb('states.country_id', '=', query.countryId))
    if (query.type) conditions.push(eb('states.type', '=', query.type))
    if (query.q) {
      const term = query.q
      conditions.push(
        eb.or([
          sql<SqlBool>`lower(states.name) like lower(${likePrefix(term)})`,
          sql<SqlBool>`similarity(states.name, ${term}) > 0.3`,
          sql<SqlBool>`states.code = ${term.toUpperCase()}`,
        ]),
      )
    }
    return eb.and(conditions)
  }
}

const DROPDOWN_COLUMN: Record<DropdownField, 'id' | 'name' | 'code' | 'type' | 'country_id' | 'sort_order'> = {
  id: 'id',
  name: 'name',
  code: 'code',
  type: 'type',
  countryId: 'country_id',
  sortOrder: 'sort_order',
}

export async function listStates(ctx: Ctx, query: ListQuery) {
  const includeDeleted = query.includeDeleted === true
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted states.')

  if (query.fields) return { data: await dropdown(query), meta: undefined }

  const where = filterWhere(query, includeDeleted)
  const total = Number((await db.selectFrom('states').select(sql<string>`count(*)`.as('n')).where(where).executeTakeFirstOrThrow()).n)

  const [field, dir] = (query.sort ?? 'sortOrder:asc').split(':') as ['name' | 'sortOrder' | 'createdAt', 'asc' | 'desc']
  const column = field === 'name' ? 'states.name' : field === 'createdAt' ? 'states.created_at' : 'states.sort_order'
  let rows = selectRows(db).where(where).orderBy(column, dir)
  if (column !== 'states.name') rows = rows.orderBy('states.name', 'asc')
  const result = await rows.orderBy('states.id').limit(query.pageSize).offset((query.page - 1) * query.pageSize).execute()

  return { data: (result as Row[]).map(present), meta: pageMeta(query.page, query.pageSize, total) }
}

async function dropdown(query: ListQuery): Promise<Record<string, unknown>[]> {
  const fields = query.fields!
  const variant = `${query.active ?? 'any'}:${query.countryId ?? 'any'}:${query.type ?? 'any'}:${fields.join(',')}`
  const cacheable = !query.q
  if (cacheable) {
    const hit = await cache.get<Record<string, unknown>[]>(variant)
    if (hit) return hit
  }
  const rows = await db
    .selectFrom('states')
    .select(['id', 'name', 'code', 'type', 'country_id', 'sort_order'])
    .where(filterWhere(query, false))
    .orderBy('sort_order', 'asc')
    .orderBy('name', 'asc')
    .limit(DROPDOWN_CAP)
    .execute()
  const data = rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[DROPDOWN_COLUMN[f]]])))
  if (cacheable) await cache.set(variant, data)
  return data
}

export async function getState(ctx: Ctx, id: string, includeDeleted = false) {
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted states.')
  return present(await def.load(db, id, { includeDeleted }))
}

// ------------------------------------------------------------------ writes

export async function createState(ctx: Ctx, input: CreateStateInput) {
  const created = await db
    .transaction()
    .execute(async (trx) => {
      await assertActiveCountry(trx, input.countryId)
      const inserted = await trx
        .insertInto('states')
        .values({
          country_id: input.countryId,
          name: input.name,
          code: input.code,
          type: input.type,
          is_active: input.isActive,
          sort_order: input.sortOrder,
          created_by: ctx.actor.id,
          updated_by: ctx.actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const view = present(await def.load(trx, inserted.id))
      await audit(trx, { ...auditBase(ctx, def, view.id), action: 'state.created', newValues: def.snapshot(view) })
      return view
    })
    .catch((e) => {
      throw mapDuplicate(e)
    })
  await cache.purge()
  return created
}

export function patchState(ctx: Ctx, id: string, version: Date, input: PatchStateInput) {
  return patchMaster(def, ctx, id, version, input, {
    columns: { countryId: 'country_id', name: 'name', code: 'code', type: 'type', isActive: 'is_active', sortOrder: 'sort_order' },
    validate: async (trx, _row, _before, changes) => {
      if (!('countryId' in changes)) return
      await assertActiveCountry(trx, changes.countryId as string)
      // FR-8.S1: cities hang off the state, so a state with cities can't be moved to another country.
      const { n } = await trx.selectFrom('cities').select(sql<number>`count(*)::int`.as('n')).where('state_id', '=', _row.id).where('deleted_at', 'is', null).executeTakeFirstOrThrow()
      if (n > 0) throw conflictState("A state that has cities can't move to another country. Create a new state instead.", { cities: n })
    },
  })
}

export const setStateActive = (ctx: Ctx, id: string, active: boolean, reason?: string) => setMasterActive(def, ctx, id, active, reason)
export const deleteState = (ctx: Ctx, id: string) => deleteMaster(def, ctx, id)
export const restoreState = (ctx: Ctx, id: string) => restoreMaster(def, ctx, id)
