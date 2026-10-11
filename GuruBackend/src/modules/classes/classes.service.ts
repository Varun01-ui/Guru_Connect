import { sql } from 'kysely'
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import { audit } from '../../lib/audit.js'
import { conflictState, forbidden, notFound } from '../../lib/errors.js'
import { createDropdownCache } from '../../lib/masters/dropdownCache.js'
import { auditBase, deleteMaster, duplicateError, patchMaster, reorderMaster, restoreMaster, setMasterActive } from '../../lib/masters/kernel.js'
import type { Ctx, MasterDef } from '../../lib/masters/kernel.js'
import { likePrefix, pageMeta } from '../../lib/masters/query.js'
import type { CreateClassInput, DropdownField, ListQuery, PatchClassInput } from './classes.schemas.js'

export type { Ctx }

const COLUMNS = ['id', 'name', 'code', 'stage', 'level_order', 'is_active', 'created_at', 'updated_at', 'deleted_at'] as const
const teacherCount = sql<number>`(select count(distinct tc.teacher_id)::int from teacher_classes tc join teachers t on t.id = tc.teacher_id and t.deleted_at is null where tc.class_id = classes.id)`.as('teacher_count')
const childCount = sql<number>`(select count(*)::int from parent_children pc where pc.class_id = classes.id and pc.deleted_at is null)`.as('child_count')

const NOT_FOUND = 'Class not found.'
const DROPDOWN_CAP = 5000
const cache = createDropdownCache('classes')

type Row = {
  id: string
  name: string
  code: string
  stage: string
  level_order: number
  is_active: boolean
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  teacher_count: number
  child_count: number
}

function present(r: Row) {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    stage: r.stage,
    levelOrder: r.level_order,
    isActive: r.is_active,
    teacherCount: r.teacher_count,
    childCount: r.child_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  }
}
export type ClassView = ReturnType<typeof present>

function mapDuplicate(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string }
  if (err?.code !== '23505') return e
  if (err.constraint === 'uq_classes_code') return duplicateError('A class with this code already exists.', 'code')
  return duplicateError('A class with this name already exists.', 'name')
}

const def: MasterDef<Row, ClassView> = {
  table: 'classes',
  noun: 'class',
  plural: 'classes',
  auditPrefix: 'class',
  auditModule: 'education_masters',
  async load(executor: Kysely<DB>, id, options = {}) {
    let q = executor.selectFrom('classes').select([...COLUMNS, teacherCount, childCount]).where('id', '=', id)
    if (!options.includeDeleted) q = q.where('deleted_at', 'is', null)
    if (options.lock) q = q.forUpdate()
    const row = await q.executeTakeFirst()
    if (!row) throw notFound(NOT_FOUND)
    return row as Row
  },
  present,
  snapshot: (c) => ({ name: c.name, code: c.code, stage: c.stage, levelOrder: c.levelOrder, isActive: c.isActive }),
  purgeCache: () => cache.purge(),
  mapDuplicate,
}

// ------------------------------------------------------------------ reads

function filterWhere(query: ListQuery, includeDeleted: boolean) {
  return (eb: ExpressionBuilder<DB, 'classes'>) => {
    const conditions: Expression<SqlBool>[] = []
    if (!includeDeleted) conditions.push(eb('deleted_at', 'is', null))
    if (query.active !== undefined) conditions.push(eb('is_active', '=', query.active))
    if (query.stage) conditions.push(eb('stage', '=', query.stage))
    if (query.q) {
      const prefix = likePrefix(query.q)
      conditions.push(eb.or([sql<SqlBool>`lower(name) like lower(${prefix})`, sql<SqlBool>`code like upper(${prefix})`]))
    }
    return eb.and(conditions)
  }
}

const DROPDOWN_COLUMN: Record<DropdownField, (typeof COLUMNS)[number]> = { id: 'id', name: 'name', code: 'code', stage: 'stage', levelOrder: 'level_order' }

export async function listClasses(ctx: Ctx, query: ListQuery) {
  const includeDeleted = query.includeDeleted === true
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted classes.')

  if (query.fields) return { data: await dropdown(query), meta: undefined }

  const where = filterWhere(query, includeDeleted)
  const total = Number((await db.selectFrom('classes').select(sql<string>`count(*)`.as('n')).where(where).executeTakeFirstOrThrow()).n)

  const [field, dir] = (query.sort ?? 'levelOrder:asc').split(':') as ['name' | 'levelOrder' | 'createdAt', 'asc' | 'desc']
  const column = field === 'name' ? 'name' : field === 'createdAt' ? 'created_at' : 'level_order'
  let rows = db.selectFrom('classes').select([...COLUMNS, teacherCount, childCount]).where(where).orderBy(column, dir)
  if (column !== 'name') rows = rows.orderBy('name', 'asc')
  const result = await rows.orderBy('id').limit(query.pageSize).offset((query.page - 1) * query.pageSize).execute()

  return { data: (result as Row[]).map(present), meta: pageMeta(query.page, query.pageSize, total) }
}

async function dropdown(query: ListQuery): Promise<Record<string, unknown>[]> {
  const fields = query.fields!
  const variant = `${query.active ?? 'any'}:${query.stage ?? 'any'}:${fields.join(',')}`
  const cacheable = !query.q
  if (cacheable) {
    const hit = await cache.get<Record<string, unknown>[]>(variant)
    if (hit) return hit
  }
  const rows = await db.selectFrom('classes').select(COLUMNS).where(filterWhere(query, false)).orderBy('level_order', 'asc').orderBy('name', 'asc').limit(DROPDOWN_CAP).execute()
  const data = rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[DROPDOWN_COLUMN[f]]])))
  if (cacheable) await cache.set(variant, data)
  return data
}

export async function getClass(ctx: Ctx, id: string, includeDeleted = false) {
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted classes.')
  return present(await def.load(db, id, { includeDeleted }))
}

// ------------------------------------------------------------------ writes

export async function createClass(ctx: Ctx, input: CreateClassInput) {
  const created = await db
    .transaction()
    .execute(async (trx) => {
      const inserted = await trx
        .insertInto('classes')
        .values({ name: input.name, code: input.code, stage: input.stage, level_order: input.levelOrder, is_active: input.isActive, created_by: ctx.actor.id, updated_by: ctx.actor.id })
        .returning('id')
        .executeTakeFirstOrThrow()
      const view = present(await def.load(trx, inserted.id))
      await audit(trx, { ...auditBase(ctx, def, view.id), action: 'class.created', newValues: def.snapshot(view) })
      return view
    })
    .catch((e) => {
      throw mapDuplicate(e)
    })
  await cache.purge()
  return created
}

export function patchClass(ctx: Ctx, id: string, version: Date, input: PatchClassInput) {
  return patchMaster(def, ctx, id, version, input, {
    columns: { name: 'name', code: 'code', stage: 'stage', levelOrder: 'level_order', isActive: 'is_active' },
    // FR-11.S2: the mobile app and analytics key on the code.
    validate: (_trx, _row, _before, changes) => {
      if ('code' in changes) throw conflictState("Class codes can't change.")
    },
  })
}

export const setClassActive = (ctx: Ctx, id: string, active: boolean, reason?: string) => setMasterActive(def, ctx, id, active, reason)
export const deleteClass = (ctx: Ctx, id: string) => deleteMaster(def, ctx, id)
export const restoreClass = (ctx: Ctx, id: string) => restoreMaster(def, ctx, id)
// FR-11.S1: rewrites level_order to 1..n, which the recommendation ranges use.
export const reorderClasses = (ctx: Ctx, ids: string[]) => reorderMaster(def, ctx, 'level_order', ids)
