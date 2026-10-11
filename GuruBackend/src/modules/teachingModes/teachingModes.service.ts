import { sql } from 'kysely'
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import { audit } from '../../lib/audit.js'
import { conflictState, forbidden, notFound } from '../../lib/errors.js'
import { createDropdownCache } from '../../lib/masters/dropdownCache.js'
import { auditBase, deleteMaster, duplicateError, patchMaster, restoreMaster, setMasterActive } from '../../lib/masters/kernel.js'
import type { Ctx, MasterDef } from '../../lib/masters/kernel.js'
import { likePrefix, pageMeta } from '../../lib/masters/query.js'
import { SYSTEM_CODES } from './teachingModes.schemas.js'
import type { CreateTeachingModeInput, DropdownField, ListQuery, PatchTeachingModeInput } from './teachingModes.schemas.js'

export type { Ctx }

const COLUMNS = ['id', 'name', 'code', 'description', 'requires_location', 'is_active', 'sort_order', 'created_at', 'updated_at', 'deleted_at'] as const
const teacherCount = sql<number>`(select count(distinct ttm.teacher_id)::int from teacher_teaching_modes ttm join teachers t on t.id = ttm.teacher_id and t.deleted_at is null where ttm.teaching_mode_id = teaching_modes.id)`.as('teacher_count')

const NOT_FOUND = 'Teaching mode not found.'
const BUILT_IN_REMOVE = "Built-in modes can't be removed."
const BUILT_IN_FIELDS = 'Built-in modes can only change their name, description and order.'
const DROPDOWN_CAP = 5000
const cache = createDropdownCache('teaching-modes')

type Row = {
  id: string
  name: string
  code: string
  description: string | null
  requires_location: boolean
  is_active: boolean
  sort_order: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  teacher_count: number
}

const isSystemCode = (code: string) => (SYSTEM_CODES as readonly string[]).includes(code)

function present(r: Row) {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    description: r.description,
    requiresLocation: r.requires_location,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    isSystem: isSystemCode(r.code),
    teacherCount: r.teacher_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  }
}
export type TeachingModeView = ReturnType<typeof present>

function mapDuplicate(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string }
  if (err?.code !== '23505') return e
  if (err.constraint === 'uq_teaching_modes_code') return duplicateError('A teaching mode with this code already exists.', 'code')
  return duplicateError('A teaching mode with this name already exists.', 'name')
}

const def: MasterDef<Row, TeachingModeView> = {
  table: 'teaching_modes',
  noun: 'teaching mode',
  plural: 'teaching modes',
  auditPrefix: 'teaching_mode',
  auditModule: 'education_masters',
  async load(executor: Kysely<DB>, id, options = {}) {
    let q = executor.selectFrom('teaching_modes').select([...COLUMNS, teacherCount]).where('id', '=', id)
    if (!options.includeDeleted) q = q.where('deleted_at', 'is', null)
    if (options.lock) q = q.forUpdate()
    const row = await q.executeTakeFirst()
    if (!row) throw notFound(NOT_FOUND)
    return row as Row
  },
  present,
  snapshot: (m) => ({ name: m.name, code: m.code, description: m.description, requiresLocation: m.requiresLocation, isActive: m.isActive, sortOrder: m.sortOrder }),
  purgeCache: () => cache.purge(),
  mapDuplicate,
  guardDeactivate: (row) => {
    if (isSystemCode(row.code)) throw conflictState(BUILT_IN_REMOVE)
  },
  guardDelete: (row) => {
    if (isSystemCode(row.code)) throw conflictState(BUILT_IN_REMOVE)
  },
}

// ------------------------------------------------------------------ reads

function filterWhere(query: ListQuery, includeDeleted: boolean) {
  return (eb: ExpressionBuilder<DB, 'teaching_modes'>) => {
    const conditions: Expression<SqlBool>[] = []
    if (!includeDeleted) conditions.push(eb('deleted_at', 'is', null))
    if (query.active !== undefined) conditions.push(eb('is_active', '=', query.active))
    if (query.q) {
      const prefix = likePrefix(query.q)
      conditions.push(eb.or([sql<SqlBool>`lower(name) like lower(${prefix})`, sql<SqlBool>`code like upper(${prefix})`]))
    }
    return eb.and(conditions)
  }
}

const DROPDOWN_COLUMN: Record<DropdownField, (typeof COLUMNS)[number]> = { id: 'id', name: 'name', code: 'code', requiresLocation: 'requires_location', sortOrder: 'sort_order' }

export async function listTeachingModes(ctx: Ctx, query: ListQuery) {
  const includeDeleted = query.includeDeleted === true
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted teaching modes.')

  if (query.fields) return { data: await dropdown(query), meta: undefined }

  const where = filterWhere(query, includeDeleted)
  const total = Number((await db.selectFrom('teaching_modes').select(sql<string>`count(*)`.as('n')).where(where).executeTakeFirstOrThrow()).n)

  const [field, dir] = (query.sort ?? 'sortOrder:asc').split(':') as ['name' | 'sortOrder' | 'createdAt', 'asc' | 'desc']
  const column = field === 'name' ? 'name' : field === 'createdAt' ? 'created_at' : 'sort_order'
  let rows = db.selectFrom('teaching_modes').select([...COLUMNS, teacherCount]).where(where).orderBy(column, dir)
  if (column !== 'name') rows = rows.orderBy('name', 'asc')
  const result = await rows.orderBy('id').limit(query.pageSize).offset((query.page - 1) * query.pageSize).execute()

  return { data: (result as Row[]).map(present), meta: pageMeta(query.page, query.pageSize, total) }
}

async function dropdown(query: ListQuery): Promise<Record<string, unknown>[]> {
  const fields = query.fields!
  const variant = `${query.active ?? 'any'}:${fields.join(',')}`
  const cacheable = !query.q
  if (cacheable) {
    const hit = await cache.get<Record<string, unknown>[]>(variant)
    if (hit) return hit
  }
  const rows = await db.selectFrom('teaching_modes').select(COLUMNS).where(filterWhere(query, false)).orderBy('sort_order', 'asc').orderBy('name', 'asc').limit(DROPDOWN_CAP).execute()
  const data = rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[DROPDOWN_COLUMN[f]]])))
  if (cacheable) await cache.set(variant, data)
  return data
}

export async function getTeachingMode(ctx: Ctx, id: string, includeDeleted = false) {
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted teaching modes.')
  return present(await def.load(db, id, { includeDeleted }))
}

// ------------------------------------------------------------------ writes

export async function createTeachingMode(ctx: Ctx, input: CreateTeachingModeInput) {
  const created = await db
    .transaction()
    .execute(async (trx) => {
      const inserted = await trx
        .insertInto('teaching_modes')
        .values({
          name: input.name,
          code: input.code,
          description: input.description,
          requires_location: input.requiresLocation,
          is_active: input.isActive,
          sort_order: input.sortOrder,
          created_by: ctx.actor.id,
          updated_by: ctx.actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const view = present(await def.load(trx, inserted.id))
      await audit(trx, { ...auditBase(ctx, def, view.id), action: 'teaching_mode.created', newValues: def.snapshot(view) })
      return view
    })
    .catch((e) => {
      throw mapDuplicate(e)
    })
  await cache.purge()
  return created
}

export function patchTeachingMode(ctx: Ctx, id: string, version: Date, input: PatchTeachingModeInput) {
  return patchMaster(def, ctx, id, version, input, {
    columns: { name: 'name', code: 'code', description: 'description', requiresLocation: 'requires_location', isActive: 'is_active', sortOrder: 'sort_order' },
    validate: (_trx, row, _before, changes) => {
      if ('code' in changes) throw conflictState("Teaching mode codes can't change.")
      // FR-14.S1: the five built-in modes keep their flags; deactivating one is the same as removing it.
      if (isSystemCode(row.code) && ('requiresLocation' in changes || 'isActive' in changes)) {
        throw conflictState('isActive' in changes ? BUILT_IN_REMOVE : BUILT_IN_FIELDS)
      }
    },
  })
}

export const setTeachingModeActive = (ctx: Ctx, id: string, active: boolean, reason?: string) => setMasterActive(def, ctx, id, active, reason)
export const deleteTeachingMode = (ctx: Ctx, id: string) => deleteMaster(def, ctx, id)
export const restoreTeachingMode = (ctx: Ctx, id: string) => restoreMaster(def, ctx, id)
